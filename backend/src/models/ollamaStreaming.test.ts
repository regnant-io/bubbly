import { callOllama } from './ollama';

/** A literal line feed, kept out of the string literals below. */
const NL = String.fromCharCode(10);

/**
 * Regression test for the truncation bug: Ollama streams NDJSON, and a single
 * large line (a tool_call carrying a big file-content argument) can be SPLIT
 * across network reads. The parser must buffer and only parse complete lines,
 * never dropping the fragment that spans a read boundary.
 */

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchOnce(chunks: string[]): void {
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    body: streamFromChunks(chunks),
    text: async () => '',
    json: async () => ({}),
  }));
}

describe('Ollama streaming NDJSON parser (truncation regression)', () => {
  afterEach(() => { jest.restoreAllMocks(); delete (global as any).fetch; });

  it('reassembles content split across read boundaries', async () => {
    // A content message whose JSON line is split mid-value across 3 chunks.
    const full = JSON.stringify({ message: { role: 'assistant', content: 'HELLO_WORLD_LONG_CONTENT' }, done: false }) + '\n';
    const a = full.slice(0, 20);
    const b = full.slice(20, 40);
    const c = full.slice(40) + JSON.stringify({ done: true, eval_count: 3, prompt_eval_count: 5 }) + '\n';

    mockFetchOnce([a, b, c]);
    let streamed = '';
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: (t) => { streamed += t; },
    });
    expect(res.textContent).toBe('HELLO_WORLD_LONG_CONTENT');
    expect(streamed).toBe('HELLO_WORLD_LONG_CONTENT');
  });

  it('reassembles a large tool_call argument split across many chunks', async () => {
    const bigContent = 'def f():\n' + '    x = 1\n'.repeat(500) + '    return x\n';
    const line = JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.py', content: bigContent } } }],
      },
      done: false,
    }) + '\n';
    const doneLine = JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + '\n';

    // Chop the whole stream into tiny 17-byte chunks to force mid-line splits.
    const whole = line + doneLine;
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 17) chunks.push(whole.slice(i, i + 17));

    mockFetchOnce(chunks);
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: () => {},
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('write_file');
    // The full, un-truncated content survived the split.
    expect((res.toolCalls[0].args as any).content).toBe(bigContent);
  });

  it('handles a final line with no trailing newline', async () => {
    const line = JSON.stringify({ message: { role: 'assistant', content: 'tail' }, done: true });
    mockFetchOnce([line]); // no '\n'
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: () => {},
    });
    expect(res.textContent).toBe('tail');
  });

  it('keeps native thinking separate from the answer (no leak into content)', async () => {
    // Model uses the native thinking channel, then emits the answer in content
    // that happens to contain a stray "<think>"-like fragment. The answer must
    // NOT be absorbed into the thinking bubble.
    const l1 = JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'reasoning here' }, done: false }) + '\n';
    const l2 = JSON.stringify({ message: { role: 'assistant', content: 'The final answer.' }, done: false }) + '\n';
    const l3 = JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + '\n';
    mockFetchOnce([l1, l2, l3]);
    const thinking: string[] = [];
    let answer = '';
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: (t) => { answer += t; },
      onThinking: (t) => { thinking.push(t); },
    });
    expect(thinking.join('')).toBe('reasoning here');
    expect(res.textContent).toBe('The final answer.');
    expect(answer).toBe('The final answer.');
  });

  it('strips leaked control sigils from content (gemma "<channel|>" etc.)', async () => {
    // gemma/gpt-oss chat templates can leak raw control sigils into content.
    // They must never render as the answer — and when they're the only output,
    // must not cause a false "empty response".
    const l1 = JSON.stringify({ message: { role: 'assistant', content: '<channel|>Hello ' }, done: false }) + '\n';
    const l2 = JSON.stringify({ message: { role: 'assistant', content: 'world<|end|>' }, done: false }) + '\n';
    const l3 = JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + '\n';
    mockFetchOnce([l1, l2, l3]);
    let answer = '';
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: (t) => { answer += t; },
    });
    expect(answer).toBe('Hello world');
    expect(res.textContent).toBe('Hello world');
  });

  it('strips a control sigil split across two chunks', async () => {
    const l1 = JSON.stringify({ message: { role: 'assistant', content: 'A<|ch' }, done: false }) + '\n';
    const l2 = JSON.stringify({ message: { role: 'assistant', content: 'annel|>B' }, done: false }) + '\n';
    const l3 = JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + '\n';
    mockFetchOnce([l1, l2, l3]);
    let answer = '';
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: (t) => { answer += t; },
    });
    expect(res.textContent).toBe('AB');
  });

  it('promotes thinking to the answer when content is empty (answer-only-on-thinking-channel bug)', async () => {
    // Some models under think:true emit the WHOLE answer on the thinking
    // channel and leave content empty. The turn must not look "empty" — the
    // reasoning is promoted to the answer so it renders as a real response.
    const l1 = JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'The workspace is empty. What would you like to build?' }, done: false }) + '\n';
    const l2 = JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + '\n';
    mockFetchOnce([l1, l2]);
    let answer = '';
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: (t) => { answer += t; },
      onThinking: () => { /* reasoning channel */ },
    });
    expect(res.textContent).toBe('The workspace is empty. What would you like to build?');
    expect(answer).toBe('The workspace is empty. What would you like to build?');
    expect(res.toolCalls).toHaveLength(0);
  });

  it('gracefully retries without `think` when the model 400s on thinking', async () => {
    let call = 0;
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      call++;
      const sentThink = JSON.parse(init.body).think === true;
      if (call === 1) {
        // First call has think:true → model rejects with 400.
        expect(sentThink).toBe(true);
        return { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'registry: model does not support thinking' };
      }
      // Retry must have dropped think.
      expect(sentThink).toBe(false);
      return {
        ok: true,
        body: null,
        json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
      };
    });

    const res = await callOllama({
      baseUrl: 'http://x', model: 'no-think-model', systemPrompt: '', messages: [], tools: [],
      enableThinking: true,
      retryConfig: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 1, timeoutMs: 5000 },
    });
    expect(res.textContent).toBe('ok');
    expect(call).toBe(2); // initial (400) + one fallback retry
  });

  it('remembers a model cannot think and skips `think` on the NEXT call (no repeated 400)', async () => {
    const MODEL = 'cache-no-think-model';
    // First call: think rejected once, fallback succeeds.
    let call = 0;
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      call++;
      const sentThink = JSON.parse(init.body).think === true;
      if (call === 1) {
        expect(sentThink).toBe(true);
        return { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'model does not support thinking' };
      }
      expect(sentThink).toBe(false);
      return { ok: true, body: null, json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }) };
    });
    await callOllama({
      baseUrl: 'http://cache-x', model: MODEL, systemPrompt: '', messages: [], tools: [],
      enableThinking: true,
      retryConfig: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 1, timeoutMs: 5000 },
    });

    // Second call: think must NOT be sent at all (learned from the cache), so
    // it succeeds on the very first request — no wasted 400 round-trip.
    let secondSentThink: boolean | undefined;
    let secondCalls = 0;
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      secondCalls++;
      secondSentThink = JSON.parse(init.body).think === true;
      return { ok: true, body: null, json: async () => ({ message: { role: 'assistant', content: 'ok2' }, done: true }) };
    });
    const res2 = await callOllama({
      baseUrl: 'http://cache-x', model: MODEL, systemPrompt: '', messages: [], tools: [],
      enableThinking: true,
      retryConfig: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 1, timeoutMs: 5000 },
    });
    expect(res2.textContent).toBe('ok2');
    expect(secondSentThink).toBe(false);
    expect(secondCalls).toBe(1); // no 400, no retry
  });

  /**
   * Regression: one tool call must be announced ONCE, however many NDJSON lines
   * repeat it. Every emission used to mint a fresh id, so the client drew a new
   * spinner per chunk — one browser_control call rendering as thirty "Using the
   * browser…" rows that no result ever closed.
   */
  it('announces a repeated tool call only once', async () => {
    const call = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'browser_control', arguments: { action: 'screenshot' } } }],
      },
      done: false,
    };
    const chunks = [
      JSON.stringify(call) + NL,
      JSON.stringify(call) + NL,
      JSON.stringify(call) + NL,
      JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 }) + NL,
    ];

    mockFetchOnce(chunks);
    const started: Array<{ id: string; name: string }> = [];
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: () => {},
      onToolStart: (info) => { started.push(info); },
    });

    expect(started).toHaveLength(1);
    expect(started[0].name).toBe('browser_control');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].id).toBe(started[0].id);
  });

  it('keeps two DIFFERENT calls to the same tool', async () => {
    const line = (action: string) => JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'browser_control', arguments: { action } } }],
      },
      done: false,
    }) + NL;

    mockFetchOnce([line('screenshot'), line('click'), JSON.stringify({ done: true }) + NL]);
    const started: string[] = [];
    const res = await callOllama({
      baseUrl: 'http://x', model: 'm', systemPrompt: '', messages: [], tools: [],
      onToken: () => {},
      onToolStart: (info) => { started.push(info.id); },
    });

    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    expect(res.toolCalls).toHaveLength(2);
  });
});
