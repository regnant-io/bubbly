import { callClaude } from './claude';
import { callOllama } from './ollama';
import { callGemini } from './gemini';
import type { ModelResponse, ToolDefinition, Message, AgentConfig } from '../types';

export async function callModel(params: {
  config: AgentConfig;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
  /** Fired the moment the model begins emitting a tool call, before its
   *  arguments have finished streaming — lets the UI show "Creating file…"
   *  immediately instead of after the whole (possibly large) call streams in. */
  onToolStart?: (info: { id: string; name: string }) => void;
  enableThinking?: boolean;
  signal?: AbortSignal;
  ollamaRetryConfig?: {
    maxAttempts: number;
    initialDelayMs: number;
    backoffMultiplier: number;
    timeoutMs: number;
  };
  onOllamaRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: string) => void;
  /** Notified when the Gemini client waits out a rate limit. */
  onRateLimitWait?: (waitMs: number, reason: string) => void;
}): Promise<ModelResponse> {
  const { config } = params;

  if (config.provider === 'claude') {
    if (!config.apiKey) {
      throw new Error('Anthropic API key not configured. Go to Settings to add it.');
    }
    return callClaude({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: params.tools,
      maxTokens: config.maxTokens,
      signal: params.signal,
      onToken: params.onToken,
      onToolStart: params.onToolStart,
    });
  } else if (config.provider === 'ollama') {
    return callOllama({
      baseUrl: config.baseUrl ?? 'http://localhost:11434',
      model: config.model,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: params.tools,
      maxTokens: config.maxTokens,
      numCtx: config.numCtx,
      autoNumCtxCeiling: config.autoNumCtxCeiling,
      signal: params.signal,
      onToken: params.onToken,
      onThinking: params.onThinking,
      enableThinking: params.enableThinking,
      retryConfig: params.ollamaRetryConfig,
      onRetry: params.onOllamaRetry,
    });
  } else if (config.provider === 'gemini') {
    if (!config.geminiApiKey) {
      throw new Error('Google Gemini API key not configured. Go to Settings to add it.');
    }
    return callGemini({
      apiKey: config.geminiApiKey,
      model: config.model,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: params.tools,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: params.signal,
      onToken: params.onToken,
      onRateLimitWait: params.onRateLimitWait,
    });
  } else {
    throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export { listOllamaModels } from './ollama';
export { listGeminiModels } from './gemini';
export { StreamBuffer, type BufferConfig } from './streamBuffer';
