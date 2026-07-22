import type { ModelResponse, ToolDefinition, Message } from '../types';
import { logger } from '../utils/logger';

/**
 * Google Gemini provider via the Generative Language REST API.
 *
 * Implemented with plain fetch (like the Ollama client) so we don't add an SDK
 * dependency. Supports streaming (SSE), native function calling, and the same
 * Message/ContentBlock shape the rest of the agent uses.
 *
 * API shape (v1beta):
 *   POST /v1beta/models/{model}:generateContent?key=KEY
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse&key=KEY
 *
 * Roles: 'user' and 'model'. System prompt goes in `systemInstruction`.
 * Tool calls arrive as parts[].functionCall = { name, args }.
 * Tool results are sent back as parts[].functionResponse = { name, response }.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Extract Gemini's suggested retry delay from a 429 body. The API returns a
 * RetryInfo detail (`retryDelay: "18.2s"`) and usually also repeats it in the
 * message ("Please retry in 18.2s"). Returns milliseconds, or null if absent.
 */
function parseRetryDelayMs(body: string): number | null {
  // Structured RetryInfo: "retryDelay": "18.261216943s"
  const structured = /"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s"?/i.exec(body);
  if (structured) return Math.ceil(parseFloat(structured[1]) * 1000);
  // Fallback to the human message: "Please retry in 18.26s"
  const message = /retry in (\d+(?:\.\d+)?)s/i.exec(body);
  if (message) return Math.ceil(parseFloat(message[1]) * 1000);
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST to Gemini, transparently waiting out a 429 when the server tells us how
 * long to wait AND that wait is within budget. This honors the free-tier's
 * per-minute limits instead of hammering with a fixed backoff that just re-hits
 * the limit (which is what exhausts the daily request quota). On a 429 whose
 * retryDelay exceeds the budget, it returns the 429 response so the caller can
 * surface a clean "rate limited" error rather than blocking for a minute.
 */
async function fetchGeminiWithRateLimit(params: {
  url: string;
  apiKey: string;
  body: string;
  signal?: AbortSignal;
  maxRateLimitWaitMs: number;
  onWait?: (waitMs: number, reason: string) => void;
}): Promise<Response> {
  // At most two in-band waits, so a stuck limit can't block forever.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(params.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
      body: params.body,
      signal: params.signal,
    });
    if (response.status !== 429) return response;

    // Peek the body to read the retry hint (clone so the caller can still read it).
    let bodyText = '';
    try { bodyText = await response.clone().text(); } catch { /* ignore */ }
    const retryDelayMs = parseRetryDelayMs(bodyText);

    // No hint, last attempt, or wait exceeds budget → hand the 429 back.
    if (retryDelayMs == null || retryDelayMs > params.maxRateLimitWaitMs || attempt === 1) {
      return response;
    }
    const waitMs = retryDelayMs + 250; // small cushion past the server's window
    params.onWait?.(waitMs, `Gemini rate limit — waiting ${(waitMs / 1000).toFixed(1)}s as instructed`);
    if (params.signal?.aborted) return response;
    await sleep(waitMs);
  }
  // Unreachable, but satisfies the type checker.
  return fetch(params.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': params.apiKey },
    body: params.body,
    signal: params.signal,
  });
}


interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Convert our provider-neutral Message[] into Gemini `contents`.
 *
 * Gemini matches a functionResponse to its call by NAME (not an id), so we walk
 * the history once, remember each tool_use's id→name, and use that name when we
 * emit the corresponding tool_result as a functionResponse.
 */
function toGeminiContents(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const idToName = new Map<string, string>();

  for (const msg of messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) contents.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text.length > 0) parts.push({ text: block.text });
      } else if (block.type === 'thinking') {
        // Reasoning is never replayed back to the model.
        continue;
      } else if (block.type === 'tool_use') {
        idToName.set(block.id, block.name);
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === 'tool_result') {
        const name = idToName.get(block.tool_use_id) ?? block.tool_use_id;
        // functionResponse.response must be an object; wrap plain strings.
        parts.push({
          functionResponse: { name, response: { result: block.content } },
        });
        // Attach any images as inlineData so Gemini can SEE the rendered result.
        if (block.images && block.images.length > 0) {
          for (const img of block.images) {
            parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
          }
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  return contents;
}

function toGeminiTools(tools: ToolDefinition[]) {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeSchema(t.inputSchema),
      })),
    },
  ];
}

/**
 * Gemini's function-declaration schema is an OpenAPI 3 subset. Strip JSON-Schema
 * keywords it rejects (e.g. $schema, additionalProperties) and recurse into
 * nested properties/items. An object type with no properties is also rejected,
 * so we drop empty parameter schemas entirely (handled by the caller).
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const src = schema as Record<string, unknown>;
  const allowed = new Set([
    'type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!allowed.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        const cleaned = sanitizeSchema(pv);
        if (cleaned) props[pk] = cleaned;
      }
      out.properties = props;
    } else if (k === 'items') {
      const cleaned = sanitizeSchema(v);
      if (cleaned) out.items = cleaned;
    } else {
      out[k] = v;
    }
  }
  // Gemini rejects an object schema that declares no properties.
  if (out.type === 'object' && (!out.properties || Object.keys(out.properties as object).length === 0)) {
    return { type: 'object', properties: {} };
  }
  return out;
}

export async function callGemini(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  /** Max time to wait out a 429 rate limit before giving up (default 30s). */
  maxRateLimitWaitMs?: number;
  /** Notified when we sleep to respect a rate-limit retry hint. */
  onRateLimitWait?: (waitMs: number, reason: string) => void;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
}): Promise<ModelResponse> {
  const modelLogger = logger.child({ component: 'model-gemini', model: params.model });

  modelLogger.info('Gemini API call starting', {
    messageCount: params.messages.length,
    maxTokens: params.maxTokens,
    toolCount: params.tools.length,
    streaming: !!params.onToken,
  });

  const startTime = Date.now();
  const baseUrl = (params.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const tools = toGeminiTools(params.tools);

  const body: Record<string, unknown> = {
    contents: toGeminiContents(params.messages),
    systemInstruction: { parts: [{ text: params.systemPrompt }] },
    generationConfig: {
      // Gemini rejects maxOutputTokens above a model's per-model cap (often
      // 8192). The agent passes a large Claude-oriented cap, so we clamp to a
      // safe value rather than risk a 400. Omitted entirely when not provided
      // so the model uses its own (usually maximal) default.
      ...(params.maxTokens ? { maxOutputTokens: Math.min(params.maxTokens, 8192) } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    },
  };
  if (tools) {
    body.tools = tools;
    // Let the model decide when to call a function.
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const streaming = !!params.onToken;
  const method = streaming ? 'streamGenerateContent' : 'generateContent';
  const url =
    `${baseUrl}/v1beta/models/${encodeURIComponent(params.model)}:${method}` +
    (streaming ? '?alt=sse' : '');

  let textContent = '';
  const toolCalls: ModelResponse['toolCalls'] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = '';

  const collectParts = (parts: GeminiPart[] | undefined, emit: boolean) => {
    if (!parts) return;
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        textContent += part.text;
        if (emit && params.onToken) params.onToken(part.text);
      } else if (part.functionCall) {
        toolCalls.push({
          id: `gemini_tc_${toolCalls.length}_${Date.now()}`,
          name: part.functionCall.name,
          args: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }
  };

  try {
    // Make the request, transparently honoring Gemini's own 429 retry hint.
    // Free-tier limits are tiny (per-minute), and Gemini tells us EXACTLY how
    // long to wait via RetryInfo.retryDelay. Sleeping that long here (instead
    // of a fixed 1/2/4s backoff that just re-hits the limit) is the difference
    // between recovering and burning the whole daily quota on doomed retries.
    const response = await fetchGeminiWithRateLimit({
      url,
      apiKey: params.apiKey,
      body: JSON.stringify(body),
      signal: params.signal,
      maxRateLimitWaitMs: params.maxRateLimitWaitMs ?? 30_000,
      onWait: params.onRateLimitWait,
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        /* ignore */
      }
      const err = new Error(`Gemini API error ${response.status}: ${detail.slice(0, 500)}`);
      (err as any).httpStatus = response.status;
      if (response.status === 429) (err as any).isRateLimit = true;
      throw err;
    }

    if (streaming && response.body) {
      // SSE stream: lines prefixed with "data: ", one JSON object per event. A
      // single event can be split across network reads, so buffer until newline.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleEvent = (jsonText: string) => {
        const trimmed = jsonText.trim();
        if (!trimmed || trimmed === '[DONE]') return;
        let data: any;
        try {
          data = JSON.parse(trimmed);
        } catch {
          return;
        }
        const cand = data.candidates?.[0];
        if (cand?.content?.parts) collectParts(cand.content.parts, true);
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (data.usageMetadata) {
          usage = {
            inputTokens: data.usageMetadata.promptTokenCount ?? usage.inputTokens,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
          };
        }
      };

      try {
        while (true) {
          if (params.signal?.aborted) {
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nlIndex: number;
          while ((nlIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIndex);
            buffer = buffer.slice(nlIndex + 1);
            const t = line.trim();
            if (t.startsWith('data:')) handleEvent(t.slice(5));
          }
        }
      } finally {
        buffer += decoder.decode();
        const t = buffer.trim();
        if (t.startsWith('data:')) handleEvent(t.slice(5));
        reader.releaseLock();
      }
    } else {
      const data = (await response.json()) as any;
      const cand = data.candidates?.[0];
      collectParts(cand?.content?.parts, false);
      if (cand?.finishReason) finishReason = cand.finishReason;
      if (data.usageMetadata) {
        usage = {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
      if (params.onToken && textContent) params.onToken(textContent);
    }

    const duration = Date.now() - startTime;
    modelLogger.info('Gemini API call succeeded', {
      duration,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      finishReason,
      toolCallCount: toolCalls.length,
      textLength: textContent.length,
      streaming,
    });

    return {
      textContent,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    modelLogger.error('Gemini API call failed', {
      error: error instanceof Error ? error.message : String(error),
      duration,
    });
    throw error;
  }
}

/** List available Gemini models for the configured API key. */
export async function listGeminiModels(apiKey: string, baseUrl?: string): Promise<string[]> {
  if (!apiKey) return [];
  try {
    const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/v1beta/models`;
    const res = await fetch(url, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/i.test(n));
  } catch (err) {
    logger.warn('Could not list Gemini models', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
