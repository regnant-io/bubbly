import Anthropic from '@anthropic-ai/sdk';
import type { ModelResponse, ToolDefinition, Message } from '../types';
import { logger } from '../utils/logger';

type AnthropicToolResultContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: AnthropicToolResultContent }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const parts: AnthropicContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            // Attach any images so Claude can actually SEE the rendered result
            // (e.g. a Bubbly Preview screenshot), alongside the text summary.
            if (block.images && block.images.length > 0) {
              const content: AnthropicToolResultContent = [
                { type: 'text', text: block.content },
                ...block.images.map((img) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
                })),
              ];
              parts.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content });
            } else {
              parts.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content });
            }
          } else if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          }
        }
        result.push({ role: 'user', content: parts as Anthropic.MessageParam['content'] });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        const parts: AnthropicContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        result.push({ role: 'assistant', content: parts as Anthropic.MessageParam['content'] });
      }
    }
  }

  return result;
}

/**
 * Hard output ceilings per model family. Requesting max_tokens above a model's
 * ceiling makes the API reject EVERY call with a 400 — the loop then burns its
 * retries and surfaces a confusing error. Clamp instead.
 */
function maxOutputTokensFor(model: string): number {
  const m = model.toLowerCase();
  if (/claude-3-(opus|sonnet|haiku)\b|claude-3-5-haiku/.test(m)) return 8192;
  if (/claude-3-5-sonnet/.test(m)) return 8192;
  if (/claude-opus-4-[01]\b|claude-opus-4\b/.test(m)) return 32000;
  // Sonnet 4+, Opus 4.5+, Haiku 4.5+ and anything newer: 64k is safe.
  return 64000;
}

export async function callClaude(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onToolStart?: (info: { id: string; name: string }) => void;
  onToolProgress?: (info: { id: string; name: string; partialJson: string }) => void;
}): Promise<ModelResponse> {
  const modelLogger = logger.child({
    component: 'model-claude',
    model: params.model
  });

  modelLogger.info('Claude API call starting', {
    messageCount: params.messages.length,
    maxTokens: params.maxTokens,
    toolCount: params.tools.length,
    streaming: !!params.onToken
  });

  const startTime = Date.now();
  const client = new Anthropic({ apiKey: params.apiKey });

  const anthropicTools: Anthropic.ToolUnion[] = params.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    // Cache breakpoint after the last tool: tools + system prompt form a large
    // static prefix that is identical on every iteration of the agent loop.
    // Caching it cuts input cost ~90% and speeds up every call after the first.
    ...(i === params.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  const anthropicMessages = toAnthropicMessages(params.messages);

  // Second cache breakpoint on the last message block: the conversation history
  // grows append-only in the agent loop, so each call re-reads the previous
  // turns from cache and only pays full price for the newest turn.
  const last = anthropicMessages[anthropicMessages.length - 1];
  if (last) {
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      const lastBlock = last.content[last.content.length - 1] as unknown as Record<string, unknown>;
      if (lastBlock.type === 'text' || lastBlock.type === 'tool_result') {
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  const maxTokens = Math.min(params.maxTokens ?? 8192, maxOutputTokensFor(params.model));
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  let textContent = '';
  const toolCalls: ModelResponse['toolCalls'] = [];

  try {
    // Use streaming for text, fallback to non-streaming
    if (params.onToken) {
      const stream = await client.messages.stream({
        model: params.model,
        max_tokens: maxTokens,
        system,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      }, { signal: params.signal });

      const startedToolIds = new Set<string>();
      /** Streaming tool-argument state, keyed by content-block index. */
      const blockIndexToTool = new Map<number, { id: string; name: string }>();
      const partialArgs = new Map<number, string>();
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          textContent += chunk.delta.text;
          params.onToken(chunk.delta.text);
        } else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
          // Fire the moment a tool call BEGINS — the id + name are available
          // here, long before the (possibly huge) arguments finish streaming.
          // This is what lets the UI show "Creating file…" immediately instead
          // of only after the whole call arrives (which reads as a frozen UI).
          const { id, name } = chunk.content_block;
          if (!startedToolIds.has(id)) {
            startedToolIds.add(id);
            params.onToolStart?.({ id, name });
          }
          blockIndexToTool.set(chunk.index, { id, name });
          partialArgs.set(chunk.index, '');
        } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta') {
          // The tool's ARGUMENTS streaming in. For a 700-line write_file this is
          // where the minute goes: the whole file body arrives here, token by
          // token, while the UI previously showed a bare spinner. Accumulate and
          // report progress so the user sees the file being written live —
          // which path, and how much of it exists so far.
          const meta = blockIndexToTool.get(chunk.index);
          if (meta) {
            const acc = (partialArgs.get(chunk.index) ?? '') + chunk.delta.partial_json;
            partialArgs.set(chunk.index, acc);
            params.onToolProgress?.({ id: meta.id, name: meta.name, partialJson: acc });
          }
        }
      }

      const finalMsg = await stream.finalMessage();
      for (const block of finalMsg.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          });
        }
      }

      const duration = Date.now() - startTime;
      modelLogger.info('Claude API call succeeded (streaming)', {
        duration,
        inputTokens: finalMsg.usage.input_tokens,
        outputTokens: finalMsg.usage.output_tokens,
        totalTokens: finalMsg.usage.input_tokens + finalMsg.usage.output_tokens,
        stopReason: finalMsg.stop_reason,
        toolCallCount: toolCalls.length,
        textLength: textContent.length
      });

      return {
        textContent,
        toolCalls,
        stopReason: finalMsg.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: finalMsg.usage.input_tokens,
          outputTokens: finalMsg.usage.output_tokens,
        },
      };
    } else {
      const response = await client.messages.create({
        model: params.model,
        max_tokens: maxTokens,
        system,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      }, { signal: params.signal });

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          });
        }
      }

      const duration = Date.now() - startTime;
      modelLogger.info('Claude API call succeeded (non-streaming)', {
        duration,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        stopReason: response.stop_reason,
        toolCallCount: toolCalls.length,
        textLength: textContent.length
      });

      return {
        textContent,
        toolCalls,
        stopReason: response.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    modelLogger.error('Claude API call failed', {
      error: error instanceof Error ? error.message : String(error),
      duration,
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}
