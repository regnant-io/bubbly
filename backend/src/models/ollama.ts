import type { ModelResponse, ToolDefinition, Message } from '../types';
import { logger } from '../utils/logger';

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Base64 images (no data: prefix) for vision-capable models. */
  images?: string[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Retry configuration for Ollama API calls
 */
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  timeoutMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  // Per-attempt ceiling. Generous by default — model generation on local /
  // tunneled hosts can take minutes; aborting at 30s killed healthy requests.
  timeoutMs: 120000,
};

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip raw model CONTROL sigils that some chat templates leak into the content
 * stream (e.g. gemma/gpt-oss "<channel|>", "<|channel|>", "<|start|>", "<|end|>",
 * "<|message|>", "<|return|>", "<|call|>", "<|constrain|>"). These are protocol
 * artifacts, never user-facing text.
 *
 * This is NOT reasoning/tool-call parsing — reasoning still comes only from the
 * native `thinking` field and tool calls only from the structured channel. We
 * are simply discarding meaningless control tokens so they don't render as the
 * answer (or, when they're the only output, cause a false "empty response").
 */
const CONTROL_SIGIL_RE = /<\|?(?:start|end|message|channel|constrain|return|call|system|user|assistant|tool)\|?>/gi;

function stripControlSigils(text: string): string {
  return text.replace(CONTROL_SIGIL_RE, '');
}

/**
 * Detect if error is a connection timeout
 */
function isConnectionTimeout(error: Error): boolean {
  return (
    error.name === 'AbortError' ||
    error.message.includes('timeout') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ENOTFOUND')
  );
}

/**
 * Determine if an HTTP status code represents a retryable error
 * 
 * Non-retryable errors (client errors that won't be fixed by retrying):
 * - 400 Bad Request: Invalid request format
 * - 401 Unauthorized: Invalid credentials
 * - 403 Forbidden: Access denied
 * - 404 Not Found: Endpoint doesn't exist
 * - 405 Method Not Allowed: Wrong HTTP method
 * - 422 Unprocessable Entity: Invalid parameters
 * 
 * Retryable errors (server errors or transient issues):
 * - 408 Request Timeout
 * - 429 Too Many Requests (rate limiting)
 * - 500 Internal Server Error
 * - 502 Bad Gateway
 * - 503 Service Unavailable
 * - 504 Gateway Timeout
 */
function isRetryableHttpStatus(status: number): boolean {
  // Client errors (4xx) are generally not retryable, except for specific cases
  if (status >= 400 && status < 500) {
    // These specific 4xx errors are retryable
    return status === 408 || status === 429;
  }
  
  // Server errors (5xx) are generally retryable
  if (status >= 500 && status < 600) {
    return true;
  }
  
  // All other status codes (2xx, 3xx) should not reach this function
  return false;
}

/**
 * Determine if an error is retryable
 */
function isRetryableError(error: Error, httpStatus?: number): boolean {
  // Check HTTP status if available
  if (httpStatus !== undefined) {
    return isRetryableHttpStatus(httpStatus);
  }
  
  // Network errors are retryable
  if (isConnectionTimeout(error)) {
    return true;
  }

  // Node's fetch (undici) reports connection-level failures as a bare
  // "fetch failed" TypeError and stashes the real reason in error.cause.
  // These are transient/connection issues — retryable, NOT fatal.
  const causeMsg = (() => {
    const c = (error as any)?.cause;
    if (!c) return '';
    if (typeof c === 'string') return c;
    return `${c.code ?? ''} ${c.message ?? ''}`;
  })();
  const combined = `${error.message} ${causeMsg}`.toLowerCase();

  // Other network-related errors that are retryable
  const retryablePatterns = [
    'fetch failed',
    'econnreset',
    'econnrefused',
    'epipe',
    'ehostunreach',
    'enetunreach',
    'eai_again',
    'enotfound',
    'etimedout',
    'socket hang up',
    'network error',
    'und_err',          // undici errors
    'terminated',       // undici stream terminated
  ];

  return retryablePatterns.some((pattern) => combined.includes(pattern));
}

/**
 * Enhanced wrapper for fetch with exponential backoff retry logic and timeout handling
 * 
 * Features:
 * - Configurable max attempts (default: 5)
 * - Exponential backoff with delays: 1s, 2s, 4s, 8s, 16s
 * - Timeout handling with AbortController (default: 30s)
 * - Connection timeout detection
 * - Detailed logging of each retry attempt with timing
 * - Comprehensive error messages after all retries exhausted
 * - Optional callback for retry events
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: string) => void,
  externalSignal?: AbortSignal
): Promise<Response> {
  let lastError: Error | null = null;
  const startTime = Date.now();
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const attemptStartTime = Date.now();
    let controller: AbortController | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let onExternalAbort: (() => void) | null = null;
    
    try {
      // If the caller already aborted (e.g. user pressed Stop), bail immediately.
      if (externalSignal?.aborted) {
        const e = new Error('Aborted by user');
        e.name = 'AbortError';
        throw e;
      }

      logger.debug('Ollama API call attempt', { 
        attempt, 
        maxAttempts: config.maxAttempts,
        url,
        timeoutMs: config.timeoutMs
      });
      
      // Create AbortController for timeout handling, and forward an external
      // abort (Stop button) to it so the in-flight request is actually killed.
      controller = new AbortController();
      timeoutId = setTimeout(() => controller!.abort(), config.timeoutMs);
      if (externalSignal) {
        onExternalAbort = () => controller!.abort();
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
      
      // Make the fetch request with timeout signal
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      // Clear timeout on successful response
      clearTimeout(timeoutId);
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
      
      // Check HTTP status
      if (!response.ok) {
        // Capture Ollama's response BODY — it almost always explains a 400
        // (unsupported option, bad num_ctx, model error). Logging only the
        // status string hid the real cause.
        let body = '';
        try { body = await response.text(); } catch { /* ignore */ }
        const detail = body ? `: ${body.slice(0, 500)}` : '';
        const error = new Error(`HTTP ${response.status}: ${response.statusText}${detail}`);
        (error as any).httpStatus = response.status;
        (error as any).responseBody = body;
        throw error;
      }
      
      const attemptDuration = Date.now() - attemptStartTime;
      const totalDuration = Date.now() - startTime;
      
      logger.info('Ollama API call succeeded', { 
        attempt,
        attemptDurationMs: attemptDuration,
        totalDurationMs: totalDuration,
        url
      });
      
      return response;
      
    } catch (error) {
      // Clear timeout if it exists
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);

      lastError = error instanceof Error ? error : new Error(String(error));

      // User-initiated abort (Stop button): do NOT retry — surface immediately.
      if (externalSignal?.aborted) {
        const e = new Error('Aborted by user');
        e.name = 'AbortError';
        throw e;
      }

      const attemptDuration = Date.now() - attemptStartTime;
      const isLastAttempt = attempt >= config.maxAttempts;
      const isTimeout = isConnectionTimeout(lastError);
      const httpStatus = (lastError as any).httpStatus;
      const retryable = isRetryableError(lastError, httpStatus);
      
      // Log the failure with detailed context
      logger.warn('Ollama API call failed', { 
        attempt,
        maxAttempts: config.maxAttempts,
        isTimeout,
        isLastAttempt,
        retryable,
        httpStatus,
        attemptDurationMs: attemptDuration,
        errorName: lastError.name,
        errorMessage: lastError.message,
        url
      });
      
      // If error is not retryable, fail immediately
      if (!retryable) {
        const totalDuration = Date.now() - startTime;
        
        logger.error('Ollama API call failed with non-retryable error', { 
          attempts: attempt,
          totalDurationMs: totalDuration,
          httpStatus,
          errorMessage: lastError.message,
          url
        });
        
        const wrapped = new Error(
          `Ollama API failed with non-retryable error: ${lastError.message}. ` +
          `This error cannot be resolved by retrying. ` +
          `Please check your request parameters and Ollama configuration.`
        );
        // Preserve the status + body so callers can do graceful degradation
        // (e.g. drop `think` and retry on a 400).
        (wrapped as any).httpStatus = httpStatus;
        (wrapped as any).responseBody = (lastError as any).responseBody;
        throw wrapped;
      }
      
      // If this was the last attempt, throw detailed error
      if (isLastAttempt) {
        const totalDuration = Date.now() - startTime;
        const errorType = isTimeout ? 'Connection timeout' : 'API error';
        
        logger.error('Ollama API call failed after all retries', { 
          attempts: attempt,
          totalDurationMs: totalDuration,
          errorType,
          errorMessage: lastError.message,
          url
        });
        
        throw new Error(
          `Ollama API failed after ${attempt} attempts (${errorType}): ${lastError.message}. ` +
          `Total time: ${(totalDuration / 1000).toFixed(1)}s. ` +
          `Please check your Ollama connection and try again.`
        );
      }
      
      // Calculate exponential backoff delay: 1s, 2s, 4s, 8s, 16s
      const delayMs = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
      
      logger.info('Retrying Ollama API call', { 
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        delaySeconds: (delayMs / 1000).toFixed(1),
        url
      });
      
      // Notify caller about retry
      if (onRetry) {
        onRetry(attempt, config.maxAttempts, delayMs, lastError.message);
      }
      
      // Wait before retrying
      await sleep(delayMs);
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw lastError!;
}

function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Handle content blocks
    let textParts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    const toolResults: { id: string; content: string; images?: string[] }[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        // Reasoning is never replayed back to the model as input — drop it.
        continue;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          function: { name: block.name, arguments: block.input },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          id: block.tool_use_id,
          content: block.content,
          images: block.images && block.images.length > 0 ? block.images.map((i) => i.data) : undefined,
        });
      }
    }

    if (toolResults.length > 0) {
      // Ollama expects tool results as separate `tool` messages — but ONLY
      // immediately after an assistant message that issued tool_calls. After
      // context compaction the matching assistant turn can be dropped, leaving
      // an orphaned tool result; emitting role:'tool' there makes strict
      // servers reject the request ("Unexpected role 'tool' after role 'user'").
      // So we only use role:'tool' when the previous emitted message is an
      // assistant with tool_calls; otherwise we fold the result into a normal
      // user message so the model still sees the output without a role error.
      for (const tr of toolResults) {
        const prev = result[result.length - 1];
        const canUseToolRole = prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0;
        if (canUseToolRole) {
          result.push({ role: 'tool', content: tr.content, ...(tr.images ? { images: tr.images } : {}) });
        } else {
          // Images ride on a user message (vision models read `images` there).
          result.push({ role: 'user', content: `[tool result]\n${tr.content}`, ...(tr.images ? { images: tr.images } : {}) });
        }
      }
    } else if (toolCalls.length > 0) {
      result.push({
        role: msg.role,
        content: textParts.join('\n'),
        tool_calls: toolCalls,
      });
    } else {
      result.push({ role: msg.role, content: textParts.join('\n') });
    }
  }

  return sanitizeRoleSequence(result);
}

/**
 * Final guard on the message sequence sent to Ollama-compatible servers, which
 * validate role transitions strictly:
 *   - a `tool` message must immediately follow an `assistant` message that has
 *     `tool_calls`;
 *   - two consecutive messages of the same non-tool role are merged where it
 *     keeps the sequence valid.
 * Anything that would violate the first rule is downgraded to a `user` message
 * so the request is always accepted. This makes long, compacted histories
 * robust across providers (Ollama, llama.cpp, minimax proxies, etc.).
 */
function sanitizeRoleSequence(msgs: OllamaMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'tool') {
      const prev = out[out.length - 1];
      const ok = prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0;
      if (!ok) {
        // Orphaned tool result → fold into a user message (merge if the prev is
        // already a user message to avoid user→user chains some servers reject).
        const folded = `[tool result]\n${m.content}`;
        if (prev && prev.role === 'user') {
          prev.content = `${prev.content}\n\n${folded}`;
        } else {
          out.push({ role: 'user', content: folded });
        }
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * Strip all image data from a message array. Used when a model that doesn't
 * support vision is detected — we retry with text-only tool results.
 */
function stripImagesFromMessages(msgs: OllamaMessage[]): OllamaMessage[] {
  return msgs.map((m) => {
    if (m.images) {
      return { ...m, images: undefined };
    }
    return m;
  });
}

function toOllamaTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Models that have told us (via a 400) they don't support the `think`
 * parameter, keyed by `${baseUrl}::${model}`. Once a model rejects thinking we
 * stop sending it — otherwise every single request pays a failed round-trip +
 * retry. Cleared only on process restart (model capabilities don't change).
 */
const _noThinkModels = new Set<string>();

/**
 * Hosts/models that reject `num_predict: -1` (unbounded). Standard Ollama
 * accepts -1, but some OpenAI-compatible proxies (e.g. cloud gateways) map it to
 * `max_tokens` and require a POSITIVE value ("max_tokens must be positive, got:
 * -1"). Once we learn that, we send a positive cap instead — no repeated 400s.
 */
const _noNegativePredict = new Set<string>();

/**
 * Models that have told us (via a 400) they don't support image input.
 * Vision tool results can't be sent to these models — we strip images and
 * retry with text only. Cleared only on process restart.
 */
const _noVisionModels = new Set<string>();

/** Positive output cap used when a host refuses num_predict: -1. */
const POSITIVE_PREDICT_FALLBACK = 8192;

export async function callOllama(params: {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  numCtx?: number;
  /** Memory-safe ceiling when auto-sizing num_ctx to the model's max. */
  autoNumCtxCeiling?: number;
  enableThinking?: boolean;
  retryConfig?: Partial<RetryConfig>;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (info: { id: string; name: string }) => void;
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: string) => void;
}): Promise<ModelResponse> {
  const ollamaMessages: OllamaMessage[] = [
    { role: 'system', content: params.systemPrompt },
    ...toOllamaMessages(params.messages),
  ];

  // Proactively strip images from hosts/models we've already learned reject
  // image input, so we don't repeat the 400 → strip → retry cycle every call.
  const visionKey = `${params.baseUrl}::${params.model}`;
  let ollamaMessagesFinal = ollamaMessages;
  if (_noVisionModels.has(visionKey) && ollamaMessages.some((m) => m.images)) {
    // NOTE: this used to only LOG and never actually strip, so a model that had
    // already failed once kept being sent images on every subsequent call.
    ollamaMessagesFinal = stripImagesFromMessages(ollamaMessages);
    logger.debug('Stripped images from request — host rejected image input previously', { model: params.model });
  }

  // Auto-size the context window to what the MODEL actually supports (queried
  // from /api/show, cached) rather than a fixed guess that truncates the
  // model's generation. Only runs when a ceiling is provided (the agent path
  // always provides one); raw callers keep the configured/default num_ctx and
  // avoid the extra /api/show round-trip. Capped to the ceiling; never below
  // the configured value. This is the real fix for "files keep truncating".
  let effectiveNumCtx = params.numCtx ?? 16384;
  if (params.autoNumCtxCeiling && params.autoNumCtxCeiling > 0) {
    const resolved = await resolveNumCtx({
      baseUrl: params.baseUrl,
      model: params.model,
      configuredNumCtx: params.numCtx,
      ceiling: params.autoNumCtxCeiling,
    });
    effectiveNumCtx = resolved.numCtx;
    logger.debug('Resolved num_ctx for request', { model: params.model, numCtx: effectiveNumCtx, source: resolved.source });
  }

  const predictKey = `${params.baseUrl}::${params.model}`;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: ollamaMessagesFinal,
    stream: !!params.onToken, // Enable streaming if onToken callback provided
    options: {
      // OUTPUT cap: -1 means "generate until the model naturally stops" (bounded
      // by the context window). We deliberately do NOT forward the large Claude-
      // oriented maxTokens here, because a num_predict near num_ctx leaves no
      // room and causes responses to cut off almost immediately.
      // Some OpenAI-compatible proxies reject -1 (they require a positive
      // max_tokens); for those hosts we've learned about, send a positive cap.
      num_predict: _noNegativePredict.has(predictKey) ? POSITIVE_PREDICT_FALLBACK : -1,
      // CONTEXT WINDOW: sized to the model's real capacity (see resolveNumCtx).
      // Ollama's default (~4096) is far too small for agent prompts + file
      // output, which is what caused mid-file truncation.
      num_ctx: effectiveNumCtx,
    },
  };

  if (params.tools.length > 0) {
    body.tools = toOllamaTools(params.tools);
  }

  // Enable native thinking. Ollama's parameter is the TOP-LEVEL `think: true`.
  // When enabled, supported models return their reasoning in a dedicated
  // `message.thinking` field. We SKIP it for models we've already learned don't
  // support it (a prior 400) so we never repeat the failed request → strip →
  // retry cycle on every call.
  const thinkKey = `${params.baseUrl}::${params.model}`;
  if (params.enableThinking && !_noThinkModels.has(thinkKey)) {
    body.think = true;
  }

  const url = `${params.baseUrl.replace(/\/$/, '')}/api/chat`;

  // Merge provided retry config with defaults
  const retryConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...params.retryConfig,
  };

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      retryConfig,
      params.onRetry,
      params.signal,
    );
  } catch (err) {
    // GRACEFUL DEGRADATION on a 400: some Ollama options aren't supported by
    // every model (e.g. `think` on a non-reasoning model → 400 "does not
    // support thinking"). Rather than failing the whole request, strip the
    // optional knobs and retry ONCE so the model still works.
    const status = (err as any)?.httpStatus;
    const respBody: string = ((err as any)?.responseBody ?? '') + '';
    // Detect a host that refuses num_predict: -1 (wants a positive max_tokens).
    const rejectsNegativePredict =
      /max_tokens must be positive/i.test(respBody) ||
      (/num_predict/i.test(respBody) && /positive|must be|invalid/i.test(respBody)) ||
      (/max_tokens/i.test(respBody) && /-1/.test(respBody));
    const currentPredict = (body.options as Record<string, unknown>).num_predict;
    const canFixPredict = rejectsNegativePredict && currentPredict === -1;
    const hasOptionalKnobs = body.think === true || effectiveNumCtx !== (params.numCtx ?? 16384);
    // Detect models/hosts that don't support image input (vision).
    //
    // Hosts are wildly inconsistent about HOW they say this. Ollama Cloud and
    // OpenAI-compatible proxies often reject an image-bearing request with a
    // bare schema error like `{"error":"Input should be a valid string"}` that
    // names neither "image" nor "vision". Requiring an explicit image-shaped
    // message meant canStripImages stayed false, the retry re-sent the exact
    // same payload, and the whole run died right after a screenshot.
    //
    // So: an explicit image complaint is a strong signal, but ANY 400 on a
    // request that carries images is reason enough to drop them and try once
    // more. Images are by far the most likely thing a picky host rejects, and
    // if that wasn't the cause the retry just fails again and the real error
    // still surfaces — we only ever lose one extra round-trip.
    const rejectsImageInput = /image.*(input|support)|does not support.*image|vision.*not supported/i.test(respBody);
    const visionKey = `${params.baseUrl}::${params.model}`;
    const hasImages = (body.messages as OllamaMessage[]).some((m) => m.images);
    const canStripImages = hasImages && !_noVisionModels.has(visionKey);
    if (status === 400 && (hasOptionalKnobs || canFixPredict || canStripImages)) {
      // Strip the optional knobs that vary by model/host and retry once:
      //  - `think` (unsupported on non-reasoning models → 400)
      //  - an auto-raised num_ctx (some hosts/quantizations reject large windows)
      //  - num_predict: -1 (some OpenAI-compatible proxies require positive)
      //  - images (non-vision models reject image input → strip and retry)
      // If the 400 was specifically about thinking, REMEMBER it so future calls
      // to this model skip `think` entirely (no repeated failed round-trips).
      if (body.think === true && /think/i.test(respBody)) {
        _noThinkModels.add(thinkKey);
        logger.info('Model does not support thinking — caching to skip it next time', { model: params.model });
      }
      if (canFixPredict) {
        _noNegativePredict.add(predictKey);
        (body.options as Record<string, unknown>).num_predict = POSITIVE_PREDICT_FALLBACK;
        logger.info('Host rejects num_predict: -1 — using a positive cap and caching for future calls', {
          model: params.model, cap: POSITIVE_PREDICT_FALLBACK,
        });
      }
      if (canStripImages) {
        // Only remember "this host can't do images" when the images were
        // plausibly to blame — either the host said so outright, or there was
        // nothing else in the request that could explain the 400. Caching it on
        // a think-related 400 would permanently blind a vision-capable model.
        const nothingElseToBlame = body.think !== true && !canFixPredict;
        if (rejectsImageInput || nothingElseToBlame) {
          _noVisionModels.add(visionKey);
          logger.info('Host rejected image input — caching to strip images next time', {
            model: params.model, explicit: rejectsImageInput,
          });
        }
        body.messages = stripImagesFromMessages(body.messages as OllamaMessage[]);
      }
      logger.warn('Ollama 400 — retrying once without optional knobs (think / auto num_ctx / num_predict / images)', {
        model: params.model, hadThink: body.think === true, fixedPredict: canFixPredict, strippedImages: canStripImages, detail: respBody.slice(0, 200),
      });
      delete (body as Record<string, unknown>).think;
      (body.options as Record<string, unknown>).num_ctx = params.numCtx ?? 16384;
      response = await fetchWithRetry(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        retryConfig,
        params.onRetry,
        params.signal,
      );
    } else {
      throw err;
    }
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${errText}`);
  }

  // Handle streaming response
  if (params.onToken && response.body) {
    let textContent = '';
    let thinkingContent = '';
    const toolCalls: ModelResponse['toolCalls'] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    // Holds a trailing partial control sigil (e.g. a lone "<|chan") across
    // content chunks so we can strip it once it completes on the next chunk.
    let sigilPending = '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // NDJSON line buffer. Ollama streams one JSON object per line, but a single
    // line (especially a tool_call carrying a large file-content argument) can
    // be SPLIT ACROSS network reads. Parsing each raw chunk independently would
    // drop the fragment that spans a read boundary — which silently TRUNCATES
    // file writes. We must buffer and only parse complete (newline-terminated)
    // lines, carrying any trailing partial line to the next read.
    let lineBuffer = '';

    const handleLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let data: {
        message?: {
          role: string;
          content: string;
          thinking?: string;
          tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
        };
        done: boolean;
        eval_count?: number;
        prompt_eval_count?: number;
      };
      try {
        data = JSON.parse(trimmed);
      } catch {
        // A genuinely malformed line (not just a split one — splits never reach
        // here because we only pass complete lines). Skip it.
        return false;
      }

      if (data.message) {
        // Reasoning comes EXCLUSIVELY from Ollama's native `thinking` field.
        // We no longer parse <think> tags or harmony tokens out of content —
        // content is always the answer, tool calls always come structured.
        if (data.message.thinking) {
          thinkingContent += data.message.thinking;
          if (params.onThinking) params.onThinking(data.message.thinking);
        }
        if (data.message.content) {
          // Strip raw control sigils (gemma/gpt-oss templates leak these into
          // content). Hold back a trailing partial "<..." until it completes so
          // a sigil split across chunks is still removed cleanly.
          let buf = sigilPending + data.message.content;
          sigilPending = '';
          buf = stripControlSigils(buf);
          const lt = buf.lastIndexOf('<');
          if (lt !== -1 && buf.indexOf('>', lt) === -1 && buf.length - lt < 16) {
            sigilPending = buf.slice(lt);
            buf = buf.slice(0, lt);
          }
          if (buf) {
            textContent += buf;
            params.onToken!(buf);
          }
        }
        if (data.message.tool_calls) {
          for (let i = 0; i < data.message.tool_calls.length; i++) {
            const tc = data.message.tool_calls[i];
            let args = tc.function.arguments;
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { args = {}; }
            }
            const id = `ollama_tc_${i}_${Date.now()}`;
            // Signal the tool as starting the instant it's parsed. Ollama can't
            // stream a tool call's arguments the way Claude does — the whole
            // call (a large file included) arrives as ONE line at the END of
            // generation — so unlike Claude there is no live line-count to show.
            // Firing onToolStart here at least surfaces "Creating <file>…" the
            // moment the call lands, instead of the chat sitting frozen on the
            // previous message until the tool result comes back.
            params.onToolStart?.({ id, name: tc.function.name });
            toolCalls.push({
              id,
              name: tc.function.name,
              args: args as Record<string, unknown>,
            });
          }
        }
      }
      if (data.done) {
        usage = {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count ?? 0,
        };
      }
      return true;
    };

    try {
      while (true) {
        if (params.signal?.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;

        // Append decoded bytes to the buffer, then process only COMPLETE lines.
        lineBuffer += decoder.decode(value, { stream: true });
        let nlIndex: number;
        while ((nlIndex = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, nlIndex);
          lineBuffer = lineBuffer.slice(nlIndex + 1);
          handleLine(line);
        }
      }
    } finally {
      // Flush any final decoder state and a trailing line with no newline.
      lineBuffer += decoder.decode();
      if (lineBuffer.trim()) handleLine(lineBuffer);
      reader.releaseLock();
    }

    // Flush any held-back partial sigil. If it never completed into a full
    // sigil it's just stray text — strip what we can and keep the rest.
    if (sigilPending) {
      const tail = stripControlSigils(sigilPending);
      sigilPending = '';
      if (tail) {
        textContent += tail;
        params.onToken!(tail);
      }
    }

    // If the model put its entire answer on the THINKING channel and left
    // content empty (some models do this under think:true), treat the reasoning
    // AS the answer. Without this the turn looks "empty" and the answer only
    // ever shows in the thinking bubble — the exact bug we're fixing. No parsing
    // involved: we just promote the native thinking field when there's nothing
    // else to show.
    if (!textContent.trim() && toolCalls.length === 0 && thinkingContent.trim()) {
      textContent = thinkingContent;
      params.onToken!(thinkingContent);
    }

    return {
      textContent,
      toolCalls,
      thinking: thinkingContent || undefined,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage,
    };
  }

  // Handle non-streaming response (fallback)
  const data = await response.json() as {
    message: {
      role: string;
      content: string;
      thinking?: string;
      tool_calls?: Array<{
        function: { name: string; arguments: Record<string, unknown> | string };
      }>;
    };
    done: boolean;
    eval_count?: number;
    prompt_eval_count?: number;
  };

  const textContent = stripControlSigils(data.message.content ?? '');
  const toolCalls: ModelResponse['toolCalls'] = [];

  // Reasoning comes only from the native `thinking` field.
  const thinkingContent = data.message.thinking ?? '';
  if (thinkingContent && params.onThinking) {
    params.onThinking(thinkingContent);
  }

  if (data.message.tool_calls) {
    for (let i = 0; i < data.message.tool_calls.length; i++) {
      const tc = data.message.tool_calls[i];
      let args = tc.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      toolCalls.push({
        id: `ollama_tc_${i}_${Date.now()}`,
        name: tc.function.name,
        args: args as Record<string, unknown>,
      });
    }
  }

  // Same promotion as the streaming path: if the answer ended up on the
  // thinking channel and content is empty, treat the reasoning as the answer.
  let finalText = textContent;
  if (!finalText.trim() && toolCalls.length === 0 && thinkingContent.trim()) {
    finalText = thinkingContent;
  }

  if (params.onToken && finalText) {
    params.onToken(finalText);
  }

  return {
    textContent: finalText,
    toolCalls,
    thinking: thinkingContent || undefined,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
    },
  };
}

/**
 * Resolve a model's MAXIMUM context length from Ollama's /api/show, cached per
 * (baseUrl, model). Ollama reports the architecture's context_length in
 * model_info (e.g. "<arch>.context_length"). We read it so we can size num_ctx
 * to what the model actually supports instead of a fixed guess that truncates
 * generation. Falls back to null when unavailable.
 */
const _ctxLenCache = new Map<string, number | null>();

export async function resolveModelContextLength(baseUrl: string, model: string): Promise<number | null> {
  const key = `${baseUrl}::${model}`;
  if (_ctxLenCache.has(key)) return _ctxLenCache.get(key)!;
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/show`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { _ctxLenCache.set(key, null); return null; }
    const data = await res.json() as { model_info?: Record<string, unknown> };
    const info = data.model_info ?? {};
    // The key is "<architecture>.context_length"; find it generically.
    let ctxLen: number | null = null;
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
        ctxLen = v;
        break;
      }
    }
    _ctxLenCache.set(key, ctxLen);
    if (ctxLen) logger.info('Resolved model context length from Ollama', { model, contextLength: ctxLen });
    return ctxLen;
  } catch (err) {
    logger.warn('Could not resolve model context length', { model, error: err instanceof Error ? err.message : String(err) });
    _ctxLenCache.set(key, null);
    return null;
  }
}

/**
 * Resolve whether an Ollama model supports VISION (image input) from its real
 * capabilities via /api/show, cached per (baseUrl, model). Modern Ollama reports
 * a `capabilities` array (e.g. ["completion","vision","tools"]); we also sniff
 * model_info / families / projector fields for older servers. This is far more
 * reliable than guessing from the model name (e.g. "minimax-m3" is multimodal
 * but the name gives no hint). Returns null when it genuinely can't be resolved
 * so callers can fall back to a name-based heuristic.
 */
const _visionCache = new Map<string, boolean | null>();

export async function resolveModelVision(baseUrl: string, model: string): Promise<boolean | null> {
  const key = `${baseUrl}::${model}`;
  if (_visionCache.has(key)) return _visionCache.get(key)!;
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/show`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { _visionCache.set(key, null); return null; }
    const data = await res.json() as {
      capabilities?: string[];
      details?: { families?: string[] };
      model_info?: Record<string, unknown>;
      projector_info?: Record<string, unknown>;
    };

    let vision: boolean | null = null;
    // 1. Explicit capabilities array (authoritative on modern Ollama).
    if (Array.isArray(data.capabilities)) {
      vision = data.capabilities.some((c) => /vision|image|multimodal/i.test(String(c)));
    }
    // 2. A projector (mmproj / clip) means the model can see images.
    if (vision !== true && data.projector_info && Object.keys(data.projector_info).length > 0) {
      vision = true;
    }
    // 3. Vision-family hints (llava/clip/mllama/…) or a *.vision.* model_info key.
    if (vision !== true) {
      const families = (data.details?.families ?? []).join(' ').toLowerCase();
      if (/clip|llava|mllama|vision|siglip|qwen2\.?vl/.test(families)) vision = true;
      else if (data.model_info && Object.keys(data.model_info).some((k) => /vision|clip|mm_/i.test(k))) vision = true;
    }

    _visionCache.set(key, vision);
    logger.info('Resolved model vision capability from Ollama', { model, vision });
    return vision;
  } catch (err) {
    logger.warn('Could not resolve model vision capability', { model, error: err instanceof Error ? err.message : String(err) });
    _visionCache.set(key, null);
    return null;
  }
}

/**
 * Whether an Ollama model id refers to a hosted CLOUD model (e.g.
 * `minimax-m2.5:cloud`, `gpt-oss:120b-cloud`). Cloud models are served by a
 * gateway that manages its own context window, so the local KV-cache memory
 * ceiling must NOT clamp them — clamping a 200k+ window down to 32k is what made
 * the pressure evaluator migrate to a fresh thread far too early.
 */
export function isOllamaCloudModel(model: string): boolean {
  return /[:\-]cloud\b/i.test(model);
}

/**
 * Decide the num_ctx to send. Priority:
 *   1. The model's real max context (from /api/show). For LOCAL models this is
 *      capped to a safe ceiling so we don't request more KV cache than memory
 *      allows; for CLOUD models the ceiling does not apply (the gateway owns
 *      memory), so the full window is used.
 *   2. The user-configured numCtx.
 *   3. A sane default (16384).
 * We never go BELOW the configured/default value (raising the floor only).
 */
export async function resolveNumCtx(params: {
  baseUrl: string;
  model: string;
  configuredNumCtx?: number;
  ceiling?: number;
}): Promise<{ numCtx: number; source: 'model-max' | 'configured' | 'default' }> {
  const configured = params.configuredNumCtx && params.configuredNumCtx > 0 ? params.configuredNumCtx : 16384;
  // The memory ceiling protects LOCAL KV cache from OOM. Cloud models are served
  // remotely, so they keep their full (uncapped) window.
  const ceiling = isOllamaCloudModel(params.model)
    ? Number.POSITIVE_INFINITY
    : (params.ceiling ?? 32768);
  const modelMax = await resolveModelContextLength(params.baseUrl, params.model);
  if (modelMax && modelMax > 0) {
    // Use the model's max, capped for local (memory) but not cloud, and never
    // below what the user configured.
    const chosen = Math.max(configured, Math.min(modelMax, ceiling));
    return { numCtx: chosen, source: chosen === configured ? 'configured' : 'model-max' };
  }
  return { numCtx: configured, source: params.configuredNumCtx ? 'configured' : 'default' };
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { models: Array<{ name: string }> };
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}
