/**
 * Integration tests for Stream Buffer in Agent Orchestrator
 *
 * Tests streaming behavior with various response sizes to ensure:
 * - Small responses are buffered and flushed correctly
 * - Large responses are streamed in chunks
 * - Buffer finalization ensures no content is lost
 * - Thresholds (minTokens, minChars, flushIntervalMs) work as expected
 *
 * FIRST-PAINT CONTRACT: StreamBuffer.push() deliberately flushes the VERY FIRST
 * token immediately, so the user sees the model start responding without
 * waiting for a batch to fill. Batching thresholds only apply from the second
 * token onward. These tests originally predated that behaviour and asserted
 * that nothing flushed until a threshold was hit, which made them fail against
 * the (intentional) implementation.
 */

import { StreamBuffer } from '../models/streamBuffer';

describe('StreamBuffer Integration', () => {
  describe('Small Response Streaming', () => {
    it('flushes the first token immediately, then batches the rest', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // The first token paints immediately.
      buffer.push('token0 ');
      expect(flushedChunks.length).toBe(1);
      expect(flushedChunks[0]).toBe('token0 ');

      // The next few sit in the buffer — below minTokens.
      for (let i = 1; i < 5; i++) buffer.push(`token${i} `);
      expect(flushedChunks.length).toBe(1);

      // Reaching minTokens (10 buffered since the last flush) flushes again.
      for (let i = 5; i < 11; i++) buffer.push(`token${i} `);
      expect(flushedChunks.length).toBe(2);
      expect(flushedChunks[1]).toContain('token1');
      expect(flushedChunks[1]).toContain('token10');

      buffer.finalize();
      // Nothing is ever lost across the flushes.
      expect(flushedChunks.join('')).toBe(
        Array.from({ length: 11 }, (_, i) => `token${i} `).join('')
      );
      done();
    });

    it('should flush on finalize even with partial buffer', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('Hello ');   // first token → immediate paint
      buffer.push('World ');   // buffered
      buffer.push('!');        // buffered
      expect(flushedChunks.length).toBe(1);

      // Finalize flushes whatever is still buffered.
      buffer.finalize();

      expect(flushedChunks.length).toBe(2);
      expect(flushedChunks.join('')).toBe('Hello World !');
      done();
    });
  });

  describe('Large Response Streaming', () => {
    it('should flush when minChars threshold is reached', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 100, flushIntervalMs: 1000 },
        (text) => flushedChunks.push(text)
      );

      const longToken = 'a'.repeat(50);
      buffer.push(longToken); // first token → immediate paint
      expect(flushedChunks.length).toBe(1);
      expect(flushedChunks[0].length).toBe(50);

      // From here batching applies: two more tokens reach minChars (100).
      buffer.push(longToken);
      expect(flushedChunks.length).toBe(1);
      buffer.push(longToken);
      expect(flushedChunks.length).toBe(2);
      expect(flushedChunks[1].length).toBe(100);

      buffer.finalize();
      done();
    });

    it('should handle very large responses with multiple flushes', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 5, minChars: 50, flushIntervalMs: 1000 },
        (text) => flushedChunks.push(text)
      );

      // Simulate streaming a large response
      const tokens = Array.from({ length: 100 }, (_, i) => `token${i} `);
      
      tokens.forEach(token => buffer.push(token));

      // Should have flushed multiple times
      expect(flushedChunks.length).toBeGreaterThan(1);

      // Finalize to get remaining content
      buffer.finalize();

      // Verify all content was flushed
      const allContent = flushedChunks.join('');
      tokens.forEach(token => {
        expect(allContent).toContain(token);
      });

      done();
    });
  });

  describe('Time-based Flushing', () => {
    it('should flush after flushIntervalMs even if thresholds not met', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 100, minChars: 1000, flushIntervalMs: 50 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('Hello');            // first token → immediate paint
      expect(flushedChunks.length).toBe(1);

      buffer.push(' there');           // buffered: far below minTokens/minChars
      expect(flushedChunks.length).toBe(1);

      // The pending timer must flush it even though no threshold was met and no
      // further token arrives.
      setTimeout(() => {
        expect(flushedChunks.length).toBe(2);
        expect(flushedChunks.join('')).toBe('Hello there');
        buffer.finalize();
        done();
      }, 80);
    });
  });

  describe('Configuration Thresholds', () => {
    it('should respect custom minTokens threshold', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 3, minChars: 1000, flushIntervalMs: 1000 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('one ');   // first token → immediate paint
      expect(flushedChunks.length).toBe(1);

      buffer.push('two ');
      buffer.push('three ');
      expect(flushedChunks.length).toBe(1);

      // Third buffered token hits minTokens: 3.
      buffer.push('four ');
      expect(flushedChunks.length).toBe(2);
      expect(flushedChunks[1]).toBe('two three four ');

      buffer.finalize();
      done();
    });

    it('should respect custom minChars threshold', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 100, minChars: 20, flushIntervalMs: 1000 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('12345');       // first token → immediate paint
      expect(flushedChunks.length).toBe(1);

      buffer.push('67890');       // 5 buffered chars — under minChars: 20
      expect(flushedChunks.length).toBe(1);

      buffer.push('12345678901'); // 16 buffered
      expect(flushedChunks.length).toBe(1);

      buffer.push('12345');       // 21 buffered → crosses minChars
      expect(flushedChunks.length).toBe(2);

      buffer.finalize();
      done();
    });

    it('should use default configuration values', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // Push 10 tokens to trigger default minTokens
      for (let i = 0; i < 10; i++) {
        buffer.push(`t${i} `);
      }

      expect(flushedChunks.length).toBe(1);
      buffer.finalize();
      done();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty tokens gracefully', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 5, minChars: 100, flushIntervalMs: 1000 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('');
      buffer.push('');
      buffer.push('Hello');
      buffer.push('');
      buffer.push('World');

      buffer.finalize();
      expect(flushedChunks.join('')).toBe('HelloWorld');
      done();
    });

    it('should handle multiple finalize calls safely', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      buffer.push('Test');
      buffer.finalize();
      
      const firstFlushCount = flushedChunks.length;
      
      // Second finalize should not cause issues
      buffer.finalize();
      
      expect(flushedChunks.length).toBe(firstFlushCount);
      done();
    });

    it('should handle rapid token pushes', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // Rapidly push many tokens
      for (let i = 0; i < 1000; i++) {
        buffer.push('x');
      }

      buffer.finalize();

      // Verify all content was captured
      const totalChars = flushedChunks.join('').length;
      expect(totalChars).toBe(1000);
      done();
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle typical AI response streaming pattern', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // Simulate typical AI streaming: words and punctuation
      const response = "Hello! I'm here to help you with your coding task. Let me analyze the codebase first.";
      const tokens = response.split(' ');

      tokens.forEach(token => buffer.push(token + ' '));
      buffer.finalize();

      const reconstructed = flushedChunks.join('').trim();
      expect(reconstructed).toContain('Hello!');
      expect(reconstructed).toContain('coding task');
      done();
    });

    it('should handle code block streaming', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // Simulate streaming a code block
      const codeLines = [
        'function example() {\n',
        '  const x = 10;\n',
        '  const y = 20;\n',
        '  return x + y;\n',
        '}\n'
      ];

      codeLines.forEach(line => buffer.push(line));
      buffer.finalize();

      const code = flushedChunks.join('');
      expect(code).toContain('function example()');
      expect(code).toContain('return x + y');
      done();
    });

    it('should handle mixed content streaming (text + code)', (done) => {
      const flushedChunks: string[] = [];
      const buffer = new StreamBuffer(
        { minTokens: 10, minChars: 500, flushIntervalMs: 100 },
        (text) => flushedChunks.push(text)
      );

      // Simulate mixed content
      const content = [
        'Here is the solution:\n\n',
        '```typescript\n',
        'function add(a: number, b: number): number {\n',
        '  return a + b;\n',
        '}\n',
        '```\n\n',
        'This function adds two numbers together.'
      ];

      content.forEach(chunk => buffer.push(chunk));
      buffer.finalize();

      const result = flushedChunks.join('');
      expect(result).toContain('Here is the solution');
      expect(result).toContain('```typescript');
      expect(result).toContain('function add');
      expect(result).toContain('This function adds');
      done();
    });
  });
});
