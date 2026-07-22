/**
 * Tests for Stream Buffer Manager.
 *
 * Behavior contract (post-2026-07 latency fix):
 *   - The FIRST non-empty token flushes immediately (instant first paint).
 *   - After that, tokens batch until minTokens / minChars, OR a timer flushes
 *     them within flushIntervalMs even if no new token arrives.
 *   - finalize() drains whatever remains and resets first-paint state.
 */

import { StreamBuffer, BufferConfig } from './streamBuffer';

describe('StreamBuffer', () => {
  let flushedTexts: string[];
  let onFlush: (text: string) => void;
  let config: BufferConfig;

  beforeEach(() => {
    flushedTexts = [];
    onFlush = (text: string) => flushedTexts.push(text);
    config = {
      minTokens: 10,
      minChars: 500,
      flushIntervalMs: 100,
    };
  });

  describe('instant first paint', () => {
    it('flushes the very first token immediately', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('hi');
      expect(flushedTexts).toEqual(['hi']);
    });

    it('does not spend the instant paint on an empty first token', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('');
      expect(flushedTexts).toHaveLength(0);
      buffer.push('real');
      expect(flushedTexts).toEqual(['real']);
    });
  });

  describe('batching after first paint', () => {
    it('should flush when minTokens threshold is reached', () => {
      const buffer = new StreamBuffer(config, onFlush);

      buffer.push('first'); // instant flush
      expect(flushedTexts).toHaveLength(1);

      // Buffer 9 more — not enough to hit minTokens (10).
      for (let i = 0; i < 9; i++) buffer.push('token');
      expect(flushedTexts).toHaveLength(1);

      // 10th buffered token triggers a flush.
      buffer.push('token');
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('token'.repeat(10));
    });

    it('should flush when minChars threshold is reached', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('x'); // instant flush
      expect(flushedTexts).toHaveLength(1);

      const longToken = 'a'.repeat(100);
      for (let i = 0; i < 4; i++) buffer.push(longToken); // 400 chars buffered
      expect(flushedTexts).toHaveLength(1);

      buffer.push(longToken); // 500 chars → flush
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe(longToken.repeat(5));
    });

    it('flushes buffered tokens on the timer even with no new tokens', async () => {
      const buffer = new StreamBuffer({ ...config, flushIntervalMs: 50 }, onFlush);
      buffer.push('a'); // instant flush
      buffer.push('b');
      buffer.push('c'); // buffered, below thresholds
      expect(flushedTexts).toHaveLength(1);

      // No further pushes — the timer must flush the stuck tokens.
      await new Promise((r) => setTimeout(r, 70));
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('bc');
    });

    it('should not flush empty buffer', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.flush();
      expect(flushedTexts).toHaveLength(0);
    });

    it('should clear buffer after flush', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('x'); // instant
      for (let i = 0; i < 10; i++) buffer.push('token'); // → flush at 10
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('token'.repeat(10));

      for (let i = 0; i < 10; i++) buffer.push('new');
      expect(flushedTexts).toHaveLength(3);
      expect(flushedTexts[2]).toBe('new'.repeat(10));
    });
  });

  describe('finalize', () => {
    it('should flush remaining content when finalized', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('token1'); // instant flush
      buffer.push('token2');
      buffer.push('token3'); // buffered
      expect(flushedTexts).toHaveLength(1);

      buffer.finalize();
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('token2token3');
    });

    it('should handle finalize on empty buffer', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.finalize();
      expect(flushedTexts).toHaveLength(0);
    });

    it('should handle finalize after already flushed', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('token'); // instant flush; buffer now empty
      expect(flushedTexts).toHaveLength(1);

      buffer.finalize(); // nothing left to flush
      expect(flushedTexts).toHaveLength(1);
    });

    it('re-enables instant first paint for the next response', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('a'); // instant
      buffer.push('b'); // buffered
      buffer.finalize(); // flushes 'b', resets first-paint
      expect(flushedTexts).toEqual(['a', 'b']);

      buffer.push('c'); // first token of next response → instant again
      expect(flushedTexts).toEqual(['a', 'b', 'c']);
    });
  });

  describe('edge cases', () => {
    it('should handle single character tokens', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('a'); // instant flush
      for (let i = 0; i < 10; i++) buffer.push('a'); // 10 buffered → flush
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('aaaaaaaaaa');
    });

    it('should handle very long single token', () => {
      const buffer = new StreamBuffer(config, onFlush);
      const longToken = 'a'.repeat(1000);
      buffer.push(longToken); // instant flush (also over char threshold)
      expect(flushedTexts).toHaveLength(1);
      expect(flushedTexts[0]).toBe(longToken);
    });

    it('should work with custom config values', () => {
      const customConfig: BufferConfig = { minTokens: 3, minChars: 50, flushIntervalMs: 200 };
      const buffer = new StreamBuffer(customConfig, onFlush);

      buffer.push('a'); // instant
      buffer.push('b');
      expect(flushedTexts).toHaveLength(1);

      buffer.push('c'); // 3 buffered after first? b,c = 2 buffered, minTokens 3 not met
      expect(flushedTexts).toHaveLength(1);

      buffer.push('d'); // b,c,d = 3 → flush
      expect(flushedTexts).toHaveLength(2);
      expect(flushedTexts[1]).toBe('bcd');
    });
  });

  describe('logger integration', () => {
    it('should call logger when a flush emits content', () => {
      const debugLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
      const mockLogger = { debug: (msg: string, ctx?: Record<string, unknown>) => { debugLogs.push({ msg, ctx }); } };

      const buffer = new StreamBuffer(config, onFlush, mockLogger);
      buffer.push('token'); // instant flush of the first token

      expect(debugLogs).toHaveLength(1);
      expect(debugLogs[0].msg).toBe('Stream buffer flushed');
      expect(debugLogs[0].ctx).toEqual({ charCount: 5, tokenCount: 1 });
    });

    it('should call logger on finalize', () => {
      const debugLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
      const mockLogger = { debug: (msg: string, ctx?: Record<string, unknown>) => { debugLogs.push({ msg, ctx }); } };

      const buffer = new StreamBuffer(config, onFlush, mockLogger);
      buffer.push('a'); // instant flush → logs 'flushed'
      buffer.push('b'); // buffered
      buffer.finalize(); // flushes 'b' → 'flushed', then 'finalized'

      const messages = debugLogs.map((l) => l.msg);
      expect(messages).toContain('Stream buffer flushed');
      expect(messages[messages.length - 1]).toBe('Stream buffer finalized');
    });

    it('should work without logger', () => {
      const buffer = new StreamBuffer(config, onFlush);
      buffer.push('token');
      expect(flushedTexts).toHaveLength(1);
    });
  });
});
