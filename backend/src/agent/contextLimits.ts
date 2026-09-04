/**
 * Per-model context-limit registry + budgeting.
 *
 * Different models have very different context windows. A local 8B model on
 * Ollama might only see 8k tokens (whatever num_ctx is set to), while Claude
 * sees 200k+. The agent loop needs to know the OPERATIVE limit for the model
 * currently in use so it can summarize and migrate to a fresh thread BEFORE the
 * window overflows and the run breaks.
 *
 * Key insight for Ollama: the operative limit is num_ctx — the window we
 * actually send. The model never sees beyond it, so that is the real cap,
 * regardless of the model's theoretical maximum.
 */

export interface ContextLimit {
  /** Operative max tokens for the model's context window (input + output). */
  maxTokens: number;
  /** Where the number came from (for logging / UI). */
  /**
   * Where the number came from, so the UI can say whether it is measured or
   * guessed. 'provider-api' is the model's own answer; 'registry' is our table
   * keyed on the model name; 'default' means we had nothing to go on.
   */
  source: 'ollama-num-ctx' | 'provider-api' | 'registry' | 'default';
}

/**
 * Known Gemini context windows, matched by substring on the model id. Gemini
 * 1.5/2.x models have very large (1M+) windows. Conservative fallback below.
 */
const GEMINI_REGISTRY: Array<{ match: RegExp; tokens: number }> = [
  { match: /gemini-1\.5-pro|gemini-2\.5-pro|gemini-2\.0-pro/i, tokens: 2_000_000 },
  { match: /gemini-(1\.5|2\.0|2\.5|exp)/i, tokens: 1_048_576 },
  { match: /gemini/i, tokens: 1_048_576 },
];

const GEMINI_DEFAULT = 1_048_576;

/**
 * Known Claude context windows, matched by substring on the model id. Order
 * matters — more specific patterns first. These are conservative; a model not
 * matched falls back to the safe default.
 */
const CLAUDE_REGISTRY: Array<{ match: RegExp; tokens: number }> = [
  // 1M-context betas (opt-in). Matched explicitly so we don't assume it.
  { match: /(1m|1-million|200k-plus)/i, tokens: 1_000_000 },
  // Modern Claude families: 200k window.
  { match: /(claude-(?:opus|sonnet|haiku)-4|claude-3|claude-sonnet|claude-opus|claude-haiku)/i, tokens: 200_000 },
];

const CLAUDE_DEFAULT = 200_000;
const OLLAMA_DEFAULT_NUM_CTX = 16_384;

/**
 * Resolve the operative context limit for the active model.
 */
export function getContextLimit(params: {
  provider: 'claude' | 'ollama' | 'gemini' | 'openrouter';
  model: string;
  /** The configured Ollama num_ctx (the window we actually send). */
  numCtx?: number;
  /**
   * When Ollama auto-sizing is enabled the request raises num_ctx up to this
   * ceiling (see resolveNumCtx). The OPERATIVE window is therefore the ceiling,
   * not the base num_ctx — measuring pressure against the base makes the agent
   * migrate at half its real capacity ("too early").
   */
  autoNumCtxCeiling?: number;
  /**
   * The model's REAL operative window, resolved once per run from /api/show
   * (see resolveNumCtx / AgentConfig.resolvedContextTokens). When present this
   * is authoritative — it reflects each model's true capacity (a large cloud
   * model can far exceed num_ctx/ceiling), so pressure is measured against the
   * window the model actually attends to instead of a fixed 16k/32k guess.
   */
  resolvedContextTokens?: number;
}): ContextLimit {
  if (params.provider === 'ollama') {
    // Authoritative: the per-model window resolved from /api/show.
    if (params.resolvedContextTokens && params.resolvedContextTokens > 0) {
      return { maxTokens: params.resolvedContextTokens, source: 'ollama-num-ctx' };
    }
    const base = params.numCtx && params.numCtx > 0 ? params.numCtx : OLLAMA_DEFAULT_NUM_CTX;
    // If auto-sizing is on, the window we actually send can grow to the ceiling,
    // so that is the real operative limit for pressure evaluation.
    const operative = params.autoNumCtxCeiling && params.autoNumCtxCeiling > base
      ? params.autoNumCtxCeiling
      : base;
    return { maxTokens: operative, source: 'ollama-num-ctx' };
  }
  if (params.provider === 'gemini') {
    // The API's own answer always wins over a regex on the model name — see
    // resolveGeminiContextLength. The registry below is the fallback for when
    // the API could not be reached, not the primary source.
    if (params.resolvedContextTokens && params.resolvedContextTokens > 0) {
      return { maxTokens: params.resolvedContextTokens, source: 'provider-api' };
    }
    for (const entry of GEMINI_REGISTRY) {
      if (entry.match.test(params.model)) return { maxTokens: entry.tokens, source: 'registry' };
    }
    return { maxTokens: GEMINI_DEFAULT, source: 'default' };
  }
  if (params.provider === 'openrouter') {
    // Resolved from the OpenRouter models endpoint, when it answered.
    if (params.resolvedContextTokens && params.resolvedContextTokens > 0) {
      return { maxTokens: params.resolvedContextTokens, source: 'provider-api' };
    }
    // Default to 200k like Claude
    return { maxTokens: 200_000, source: 'default' };
  }
  for (const entry of CLAUDE_REGISTRY) {
    if (entry.match.test(params.model)) return { maxTokens: entry.tokens, source: 'registry' };
  }
  return { maxTokens: CLAUDE_DEFAULT, source: 'default' };
}

/**
 * How many tokens we can safely spend on INPUT (system prompt + history),
 * leaving room for the model's reply. We reserve a slice of the window for
 * output so the model never gets cut off immediately after a full prompt.
 */
export function usableInputTokens(limit: ContextLimit): number {
  // Reserve ~20% of the window for the response, clamped to a sane band.
  const reserve = Math.min(Math.max(Math.floor(limit.maxTokens * 0.2), 512), 8192);
  return Math.max(limit.maxTokens - reserve, 1024);
}

/** Rough token estimate for a plain string (≈ 4 chars/token). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ContextPressure {
  estimatedInputTokens: number;
  usableInputTokens: number;
  maxTokens: number;
  /** estimatedInputTokens / usableInputTokens, in [0, ∞). */
  ratio: number;
  /** True once we cross the migration threshold and should summarize+migrate. */
  shouldMigrate: boolean;
  source: ContextLimit['source'];
}

/**
 * Evaluate how close the current prompt is to the model's operative limit.
 *
 * @param threshold Fraction of usable input at which to trigger migration
 *   (default 0.85). Crossing it means "summarize and move to a fresh thread".
 */
export function evaluateContextPressure(params: {
  provider: 'claude' | 'ollama' | 'gemini' | 'openrouter';
  model: string;
  numCtx?: number;
  autoNumCtxCeiling?: number;
  resolvedContextTokens?: number;
  systemPromptTokens: number;
  historyTokens: number;
  threshold?: number;
}): ContextPressure {
  const limit = getContextLimit(params);
  const usable = usableInputTokens(limit);
  const estimated = params.systemPromptTokens + params.historyTokens;
  const ratio = estimated / usable;
  const threshold = params.threshold ?? 0.85;
  return {
    estimatedInputTokens: estimated,
    usableInputTokens: usable,
    maxTokens: limit.maxTokens,
    ratio,
    shouldMigrate: estimated > usable * threshold,
    source: limit.source,
  };
}
