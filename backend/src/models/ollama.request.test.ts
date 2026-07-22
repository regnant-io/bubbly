import { callOllama } from './ollama';

describe('ollama request body', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends num_ctx and unbounded num_predict (prevents immediate cutoff)', async () => {
    let capturedBody: any = null;
    global.fetch = (async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'hi there' },
          done: true,
          eval_count: 5,
          prompt_eval_count: 10,
        }),
      } as any;
    }) as any;

    const res = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 16384,
      numCtx: 16384,
      // no onToken → non-streaming path
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.options.num_ctx).toBe(16384);
    expect(capturedBody.options.num_predict).toBe(-1);
    expect(res.textContent).toBe('hi there');
  });

  it('defaults num_ctx to 16384 when not provided', async () => {
    let capturedBody: any = null;
    global.fetch = (async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
      } as any;
    }) as any;

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    expect(capturedBody.options.num_ctx).toBe(16384);
  });

  it('recovers from a host that rejects num_predict: -1 (uses a positive cap)', async () => {
    const bodies: any[] = [];
    let call = 0;
    global.fetch = (async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      call++;
      if (call === 1) {
        // First attempt: host rejects num_predict: -1.
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => '{"error":"max_tokens must be positive, got: -1"}',
        } as any;
      }
      // Retry succeeds.
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
      } as any;
    }) as any;

    const res = await callOllama({
      baseUrl: 'http://cloud-proxy.example',
      model: 'minimax-m2.5:cloud',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      numCtx: 16384,
    });

    // First body had -1, retry used a positive cap.
    expect(bodies[0].options.num_predict).toBe(-1);
    expect(bodies[1].options.num_predict).toBeGreaterThan(0);
    expect(res.textContent).toBe('ok');
  });

  it('caches the positive-cap workaround so later calls skip the failed round-trip', async () => {
    const bodies: any[] = [];
    global.fetch = (async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
      } as any;
    }) as any;

    // Same host/model as the previous test → already cached.
    await callOllama({
      baseUrl: 'http://cloud-proxy.example',
      model: 'minimax-m2.5:cloud',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    // Only one request, and it used the positive cap from the start.
    expect(bodies.length).toBe(1);
    expect(bodies[0].options.num_predict).toBeGreaterThan(0);
  });
});
