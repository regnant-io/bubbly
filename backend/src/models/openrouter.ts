import type { ModelResponse, ToolDefinition, Message } from '../types';
import { logger } from '../utils/logger';

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
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

  // Convert messages to OpenRouter format
  const openRouterMessages: OpenRouterMessage[] = [];
  
  // Add system message first
  if (params.systemPrompt) {
    openRouterMessages.push({
      role: 'system',
      content: params.systemPrompt
    });
  }

  // Convert conversation messages
  for (const msg of params.messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        openRouterMessages.push({
          role: msg.role,
          content: msg.content
        });
      } else {
        // Handle content blocks
        const content: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content
            });
          } else if (block.type === 'tool_use') {
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input
            });
          }
        }
        openRouterMessages.push({
          role: msg.role,
          content: content.length > 0 ? content : ''
        });
      }
    }
  }

  const maxTokens = params.maxTokens ?? 8192;

  // OpenRouter uses OpenAI-compatible format
  const requestBody: any = {
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

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
        'HTTP-Referer': 'https://bubbly.app',
        'X-Title': 'Bubbly AI'
      },
      body: JSON.stringify(requestBody),
      signal: params.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      modelLogger.error('OpenRouter API error', {
        status: response.status,
        error: errorText
      });
      throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;

            if (!delta) continue;

            // Handle text content
            if (delta.content) {
              textContent += delta.content;
              params.onToken(delta.content);
            }

            // Handle tool calls
            if (delta.tool_calls) {
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

                // The name can arrive on the first delta or be repeated on every
                // one of them, depending on the upstream provider. Keep the
                // latest, but ANNOUNCE ONCE: a second onToolStart for the same
                // call draws a second spinner in the transcript that no result
                // will ever close, which is how one browser_control call became
                // thirty "Using the browser…" rows.
                if (tc.function?.name) pending.name = tc.function.name;
                if (pending.name && !pending.announced) {
                  pending.announced = true;
                  params.onToolStart?.({ id: pending.id, name: pending.name });
                }
                
                if (tc.function?.arguments) {
                  pending.arguments += tc.function.arguments;
                  params.onToolProgress?.({
                    id: pending.id,
                    name: pending.name,
                    partialJson: pending.arguments
                  });
                }
              }
            }
          } catch (e) {
            modelLogger.warn('Failed to parse streaming chunk', { error: e });
          }
        }
      }

      // Finalize tool calls
      for (const [_, tc] of pendingToolCalls) {
        if (tc.name && tc.arguments) {
          try {
            const args = JSON.parse(tc.arguments);
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
        textContent = choice.message.content;
      }

      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
          });
        }
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
      stopReason: 'end_turn'
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    modelLogger.error('OpenRouter API call failed', {
      duration,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export interface OpenRouterModelInfo {
  id: string;
  context_length?: number;
}

/**
 * List available models from OpenRouter with context window info
 */
export async function listOpenRouterModels(apiKey: string): Promise<string[]> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      logger.warn('Failed to fetch OpenRouter models', { status: response.status });
      return [];
    }

    const data: any = await response.json();
    const models = data.data || [];
    
    // Return model IDs, sorted by popularity/name
    return models
      .map((m: any) => m.id)
      .filter(Boolean)
      .sort();
  } catch (error) {
    logger.error('Error fetching OpenRouter models', {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

/**
 * Get context window for a specific OpenRouter model
 */
export async function getOpenRouterModelContext(apiKey: string, modelId: string): Promise<number | null> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      logger.warn('Failed to fetch OpenRouter model info', { status: response.status });
      return null;
    }

    const data: any = await response.json();
    const models = data.data || [];
    const model = models.find((m: any) => m.id === modelId);
    
    if (model && model.context_length) {
      logger.info('Resolved OpenRouter model context', {
        model: modelId,
        contextLength: model.context_length
      });
      return model.context_length;
    }
    
    return null;
  } catch (error) {
    logger.error('Error fetching OpenRouter model context', {
      model: modelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
