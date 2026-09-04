/**
 * Stream Buffer Manager
 *
 * Buffers streaming tokens and flushes them in small batches so the UI gets
 * smooth updates without a re-render per token. Three properties matter for
 * perceived latency:
 *   1. TIME TO FIRST TOKEN — the very first token flushes IMMEDIATELY, so the
 *      user sees output the instant the model starts producing it (no waiting
 *      for a 5-token / 100-char batch to fill).
 *   2. NO STUCK TOKENS — a real timer flushes whatever is buffered within
 *      flushIntervalMs even if no further tokens arrive. Without this, a slow or
 *      bursty model leaves tokens sitting in the buffer until enough accumulate,
 *      which reads as "streaming is laggy / too late".
 *   3. NO CUTOFFS — finalize() always drains the buffer at end of stream.
 */

export interface BufferConfig {
  minTokens: number;      // Flush once this many tokens are buffered
  minChars: number;       // …or this many characters
  flushIntervalMs: number; // …or after this long, even with no new tokens
}

export class StreamBuffer {
  private buffer: string[] = [];
  private config: BufferConfig;
  private onFlush: (text: string) => void;
  private lastFlushTime: number = Date.now();
  private logger?: { debug: (msg: string, ctx?: Record<string, unknown>) => void };
  /** Have we emitted anything since construction/finalize? Drives instant TTFT. */
  private hasEmitted = false;
  /** Pending time-based flush, so buffered tokens never get stuck. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: BufferConfig,
    onFlush: (text: string) => void,
    logger?: { debug: (msg: string, ctx?: Record<string, unknown>) => void }
  ) {
    this.config = config;
    this.onFlush = onFlush;
    this.logger = logger;
  }

  /**
   * Push a token into the buffer and flush if a threshold is met. The first
   * token of a response flushes immediately (instant first paint); after that,
   * tokens batch until a size threshold is hit or the flush timer fires.
   */
  push(token: string): void {
    this.buffer.push(token);

    // Instant first paint: never make the user wait for a batch to see that the
    // model has started responding.
    if (!this.hasEmitted) {
      this.flush();
      return;
    }

    const bufferText = this.buffer.join('');
    if (
      this.buffer.length >= this.config.minTokens ||
      bufferText.length >= this.config.minChars ||
      Date.now() - this.lastFlushTime >= this.config.flushIntervalMs
    ) {
      this.flush();
      return;
    }

    // Nothing to flush yet — make sure a timer is pending so these tokens are
    // emitted within flushIntervalMs even if the model pauses.
    this.scheduleTimer();
  }

  private scheduleTimer(): void {
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.config.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Flush the current buffer contents.
   */
  flush(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;

    const text = this.buffer.join('');
    const tokenCount = this.buffer.length;

    this.buffer = [];
    this.lastFlushTime = Date.now();

    // Don't emit an empty chunk (e.g. a leading empty token) — it would waste
    // an event and, worse, "spend" the instant first-paint on nothing.
    if (text.length === 0) return;
    this.hasEmitted = true;

    this.logger?.debug('Stream buffer flushed', {
      charCount: text.length,
      tokenCount: tokenCount,
    });

    this.onFlush(text);
  }

  /**
   * Finalize the buffer by flushing all remaining content. Resets first-paint
   * state so the buffer can be reused for the next response iteration.
   */
  finalize(): void {
    this.flush(); // Ensure all remaining content is sent
    this.clearTimer();
    this.hasEmitted = false;
    this.logger?.debug('Stream buffer finalized');
  }
}
