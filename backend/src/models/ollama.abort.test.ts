import { callOllama } from './ollama';

describe('ollama abort handling', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('aborts an in-flight request when the signal fires (Stop button)', async () => {
    let fetchAborted = false;

    // Simulate a long-running fetch that rejects when its signal aborts.
    global.fetch = ((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal = opts.signal;
        if (sig.aborted) {
          fetchAborted = true;
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return;
        }
        sig.addEventListener('abort', () => {
          fetchAborted = true;
          const e = new Error('The operation was aborted'); e.name = 'AbortError';
          reject(e);
        });
        // never resolves on its own
      });
    }) as any;

    const controller = new AbortController();
    // Fire the abort shortly after the call starts.
    setTimeout(() => controller.abort(), 100);

    await expect(
      callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: controller.signal,
        // non-streaming path
      })
    ).rejects.toThrow(/abort/i);

    expect(fetchAborted).toBe(true);
  }, 10000);

  it('does not retry after a user abort', async () => {
    let callCount = 0;
    global.fetch = ((_url: string, opts: any) => {
      callCount++;
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal = opts.signal;
        sig.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }) as any;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);

    await expect(
      callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: controller.signal,
        retryConfig: { maxAttempts: 5, initialDelayMs: 10, backoffMultiplier: 2, timeoutMs: 30000 },
      })
    ).rejects.toThrow(/abort/i);

    // Aborted on the first attempt — must NOT have retried 5 times.
    expect(callCount).toBe(1);
  }, 10000);
});
