import type { ModelResponse, ToolDefinition, Message } from '../types';
import { logger } from '../utils/logger';

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenRouterToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * OpenRouter's chat endpoint uses the OpenAI message contract. In particular,
 * tool calls live on an assistant message's `tool_calls` field and every
 * result is a separate `role:"tool"` message keyed by `tool_call_id`.
 *
 * Bubbly's provider-neutral history uses Anthropic-shaped content blocks, so
 * this boundary has to translate the structure rather than forwarding those
 * blocks verbatim. Forwarding `tool_use` / `tool_result` inside `content` made
 * the first model call work and the second (after a tool ran) fail validation.
 */
export type OpenRouterMessage =
  | { role: 'system' | 'user'; content: string | OpenRouterContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenRouterToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function imageDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType || 'image/png'};base64,${data}`;
}

/** Convert Bubbly's neutral history into a valid OpenAI/OpenRouter sequence. */
export function toOpenRouterMessages(messages: Message[], includeImages = true): OpenRouterMessage[] {
  const out: OpenRouterMessage[] = [];
  const knownToolCalls = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n');

    if (msg.role === 'assistant') {
      const calls: OpenRouterToolCall[] = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        knownToolCalls.add(block.id);
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
      // Reasoning-only blocks are deliberately not represented in Bubbly's
      // provider-neutral history. Do not emit an empty assistant turn for
      // them: several OpenAI-compatible providers reject a null assistant
      // message unless it actually contains tool calls.
      if (text || calls.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });
      }
      continue;
    }

    // Tool results must all follow the assistant tool_calls message before a
    // normal user/image follow-up. This matters when a model requested several
    // tools in one response: inserting an image-user message between results
    // makes strict providers reject the still-outstanding calls.
    const followupParts: OpenRouterContentPart[] = [];
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (knownToolCalls.has(block.tool_use_id)) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
      } else {
        // Compaction can retain a useful old result after dropping its matching
        // assistant call. An orphan `role:tool` is invalid, so preserve it as
        // ordinary user context rather than sending a sequence the API rejects.
        followupParts.push({ type: 'text', text: `[tool result]\n${block.content}` });
      }
      if (includeImages && block.images?.length) {
        followupParts.push({
          type: 'text',
          text: `Image returned by tool call ${block.tool_use_id}:`,
        });
        for (const image of block.images) {
          followupParts.push({
            type: 'image_url',
            image_url: { url: imageDataUrl(image.mediaType, image.data) },
          });
        }
      }
    }

    if (text) followupParts.unshift({ type: 'text', text });
    if (followupParts.length > 0) out.push({ role: 'user', content: followupParts });
  }

  return out;
}

/**
 * Call OpenRouter's unified API (OpenAI-compatible format)
 */
export async function callOpenRouter(params: {
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
    component: 'model-openrouter',
    model: params.model
  });

  modelLogger.info('OpenRouter API call starting', {
    messageCount: params.messages.length,
    maxTokens: params.maxTokens,
    toolCount: params.tools.length,
    streaming: !!params.onToken
  });

  const startTime = Date.now();

  const cachedInfo = cachedModelInfo(params.model);
  const acceptsImages = !noVisionModels.has(params.model) &&
    cachedInfo?.architecture?.input_modalities?.includes('image') !== false;
  const openRouterMessages: OpenRouterMessage[] = [
    ...(params.systemPrompt
      ? [{ role: 'system' as const, content: params.systemPrompt }]
      : []),
    ...toOpenRouterMessages(params.messages, acceptsImages),
  ];

  const maxTokens = params.maxTokens ?? 8192;

  // OpenRouter uses OpenAI-compatible format
  const requestBody: Record<string, unknown> = {
    model: params.model,
    messages: openRouterMessages,
    max_tokens: maxTokens,
    stream: !!params.onToken
  };

  // Add tools if provided
  if (params.tools.length > 0) {
    requestBody.tools = params.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));
  }

  let textContent = '';
  const toolCalls: ModelResponse['toolCalls'] = [];
  let stopReason = 'end_turn';
  let usage: ModelResponse['usage'];

  // A disconnected provider must not leave an agent run stuck forever. Keep
  // the caller's cancellation semantics while adding a hard upper bound for
  // connection and streaming stalls.
  const requestController = new AbortController();
  const abortFromCaller = () => requestController.abort(params.signal?.reason);
  if (params.signal?.aborted) abortFromCaller();
  else params.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const requestTimeout = setTimeout(() => requestController.abort(
    new Error('OpenRouter request timed out'),
  ), 180_000);

  try {
    let response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
        'HTTP-Referer': 'https://bubbly.app',
        'X-Title': 'Bubbly AI'
      },
      body: JSON.stringify(requestBody),
      signal: requestController.signal
    });

    if (!response.ok) {
      let errorText = await response.text();

      // A model may be text-only even when its alias is absent from the model
      // catalogue (or the catalogue was temporarily unavailable). If the only
      // provider-specific payload is a screenshot, retry once with the textual
      // tool result. This is the OpenRouter equivalent of Ollama's vision
      // fallback and keeps one screenshot from killing the whole run.
      const hadImages = JSON.stringify(requestBody.messages).includes('"image_url"');
      if ((response.status === 400 || response.status === 422) && hadImages) {
        noVisionModels.add(params.model);
        requestBody.messages = [
          ...(params.systemPrompt
            ? [{ role: 'system' as const, content: params.systemPrompt }]
            : []),
          ...toOpenRouterMessages(params.messages, false),
        ];
        modelLogger.warn('OpenRouter rejected image input; retrying once with text-only tool results', {
          status: response.status,
          detail: errorText.slice(0, 200),
        });
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${params.apiKey}`,
            'HTTP-Referer': 'https://bubbly.app',
            'X-Title': 'Bubbly AI',
          },
          body: JSON.stringify(requestBody),
          signal: requestController.signal,
        });
        if (!response.ok) errorText = await response.text();
      }

      if (!response.ok) {
        modelLogger.error('OpenRouter API error', {
          status: response.status,
          error: errorText
        });
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }
    }

    if (params.onToken && response.body) {
      // Streaming mode
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const pendingToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string; announced: boolean }
      >();

      const consumeData = (data: string) => {
        if (!data || data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;

          if (delta?.content) {
            const next = typeof delta.content === 'string'
              ? delta.content
              : Array.isArray(delta.content)
              ? delta.content.map((p: any) => p?.text ?? '').join('')
              : '';
            if (next) {
              textContent += next;
              params.onToken?.(next);
            }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (!pendingToolCalls.has(index)) {
                pendingToolCalls.set(index, {
                  id: tc.id || `call_${Date.now()}_${index}`,
                  name: tc.function?.name || '',
                  arguments: '',
                  announced: false,
                });
              }

              const pending = pendingToolCalls.get(index)!;
              if (tc.id && !pending.announced) pending.id = tc.id;
              if (tc.function?.name) pending.name = tc.function.name;
              if (pending.name && !pending.announced) {
                pending.announced = true;
                params.onToolStart?.({ id: pending.id, name: pending.name });
              }
              if (typeof tc.function?.arguments === 'string') {
                pending.arguments += tc.function.arguments;
                params.onToolProgress?.({
                  id: pending.id,
                  name: pending.name,
                  partialJson: pending.arguments,
                });
              }
            }
          }

          const finish = choice?.finish_reason;
          if (finish === 'length') stopReason = 'max_tokens';
          else if (finish === 'tool_calls') stopReason = 'tool_use';
          else if (finish) stopReason = String(finish);
          if (chunk.usage) {
            usage = {
              inputTokens: Number(chunk.usage.prompt_tokens ?? 0),
              outputTokens: Number(chunk.usage.completion_tokens ?? 0),
            };
          }
        } catch (e) {
          modelLogger.warn('Failed to parse streaming chunk', { error: e });
        }
      };

      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        consumeData(trimmed.slice(5).trimStart());
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) consumeLine(line);

      // Finalize tool calls
      for (const [_, tc] of pendingToolCalls) {
        if (tc.name) {
          try {
            const args = JSON.parse(tc.arguments || '{}');
            toolCalls.push({
              id: tc.id,
              name: tc.name,
              args
            });
          } catch (e) {
            modelLogger.error('Failed to parse tool arguments', { toolCall: tc, error: e });
          }
        }
      }
    } else {
      // Non-streaming mode
      const data: any = await response.json();
      const choice = data.choices?.[0];

      if (!choice) {
        throw new Error('No choices in OpenRouter response');
      }

      if (choice.message?.content) {
        textContent = typeof choice.message.content === 'string'
          ? choice.message.content
          : Array.isArray(choice.message.content)
          ? choice.message.content.map((p: any) => p?.text ?? '').join('')
          : '';
      }

      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          try {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            });
          } catch (e) {
            modelLogger.error('Failed to parse tool arguments', { toolCall: tc, error: e });
          }
        }
      }
      const finish = choice.finish_reason;
      stopReason = finish === 'length' ? 'max_tokens' : finish === 'tool_calls' ? 'tool_use' : (finish ?? 'end_turn');
      if (data.usage) {
        usage = {
          inputTokens: Number(data.usage.prompt_tokens ?? 0),
          outputTokens: Number(data.usage.completion_tokens ?? 0),
        };
      }
    }

    const duration = Date.now() - startTime;
    modelLogger.info('OpenRouter API call completed', {
      duration,
      textLength: textContent.length,
      toolCallCount: toolCalls.length
    });

    return {
      textContent,
      toolCalls,
      stopReason,
      usage,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    modelLogger.error('OpenRouter API call failed', {
      duration,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    clearTimeout(requestTimeout);
    params.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export interface OpenRouterModelInfo {
  id: string;
  context_length?: number;
  canonical_slug?: string;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
let modelCatalog: { fetchedAt: number; models: OpenRouterModelInfo[] } | null = null;
let modelCatalogRequest: Promise<OpenRouterModelInfo[] | null> | null = null;
const noVisionModels = new Set<string>();

function cachedModelInfo(modelId: string): OpenRouterModelInfo | undefined {
  const id = modelId.trim();
  if (!modelCatalog || Date.now() - modelCatalog.fetchedAt >= MODEL_CATALOG_TTL_MS) return undefined;
  return modelCatalog.models.find((m) => m.id === id || m.canonical_slug === id);
}

/**
 * The model catalogue backs the selector, context sizing and modality checks.
 * Fetch it once and share the in-flight request: opening Settings while a run
 * starts used to download and parse the same large catalogue two or three
 * times concurrently.
 */
async function getModelCatalog(apiKey: string): Promise<OpenRouterModelInfo[] | null> {
  if (modelCatalog && Date.now() - modelCatalog.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalog.models;
  }
  if (modelCatalogRequest) return modelCatalogRequest;

  modelCatalogRequest = (async () => {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        logger.warn('Failed to fetch OpenRouter models', { status: response.status });
        return null;
      }

      const data: any = await response.json();
      const models = (Array.isArray(data?.data) ? data.data : [])
        .filter((m: any) => m && typeof m.id === 'string')
        .map((m: any): OpenRouterModelInfo => ({
          id: String(m.id),
          canonical_slug: typeof m.canonical_slug === 'string' ? m.canonical_slug : undefined,
          context_length: Number.isFinite(Number(m.context_length)) && Number(m.context_length) > 0
            ? Number(m.context_length)
            : undefined,
          architecture: Array.isArray(m.architecture?.input_modalities)
            ? { input_modalities: m.architecture.input_modalities.map(String) }
            : undefined,
          supported_parameters: Array.isArray(m.supported_parameters)
            ? m.supported_parameters.map(String)
            : undefined,
        }));
      modelCatalog = { fetchedAt: Date.now(), models };
      return models;
    } catch (error) {
      logger.warn('Error fetching OpenRouter model catalogue', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      modelCatalogRequest = null;
    }
  })();

  return modelCatalogRequest;
}

/**
 * List available models from OpenRouter with context window info
 */
export async function listOpenRouterModels(apiKey: string): Promise<string[]> {
  const models = await getModelCatalog(apiKey);
  return (models ?? []).map((m) => m.id).sort();
}

/**
 * Get context window for a specific OpenRouter model
 */
export async function getOpenRouterModelContext(apiKey: string, modelId: string): Promise<number | null> {
  const models = await getModelCatalog(apiKey);
  const id = modelId.trim();
  const model = models?.find((m) => m.id === id || m.canonical_slug === id);
  const contextLength = Number(model?.context_length);

  if (Number.isFinite(contextLength) && contextLength > 0) {
    logger.info('Resolved OpenRouter model context', { model: id, contextLength });
    return contextLength;
  }
  logger.warn('OpenRouter model was absent from the catalogue or did not report a context window', { model: id });
  return null;
}

/** Resolve image-input capability from the same catalogue used at runtime. */
export async function getOpenRouterModelVision(apiKey: string, modelId: string): Promise<boolean | null> {
  const models = await getModelCatalog(apiKey);
  const id = modelId.trim();
  const model = models?.find((m) => m.id === id || m.canonical_slug === id);
  const modalities = model?.architecture?.input_modalities;
  if (!modalities) return null;
  return modalities.includes('image');
}

/** Test-only reset; kept explicit so cache behavior can be pinned reliably. */
export function resetOpenRouterCachesForTests(): void {
  modelCatalog = null;
  modelCatalogRequest = null;
  noVisionModels.clear();
}
