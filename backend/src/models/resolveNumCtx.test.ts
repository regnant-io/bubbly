import { resolveNumCtx, resolveModelContextLength, isOllamaCloudModel } from './ollama';

describe('isOllamaCloudModel', () => {
  it('detects :cloud and -cloud suffixes, not plain local names', () => {
    expect(isOllamaCloudModel('minimax-m2.5:cloud')).toBe(true);
    expect(isOllamaCloudModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isOllamaCloudModel('llama3.1')).toBe(false);
    expect(isOllamaCloudModel('qwen2.5-coder:7b')).toBe(false);
  });
});

describe('resolveModelContextLength', () => {
  afterEach(() => { jest.restoreAllMocks(); delete (global as any).fetch; });

  it('reads <arch>.context_length from /api/show', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model_info: { 'qwen2.context_length': 32768, 'qwen2.embedding_length': 3584 } }),
    }));
    const len = await resolveModelContextLength('http://x', 'qwen2.5-coder-fresh1');
    expect(len).toBe(32768);
  });

  it('returns null when /api/show fails', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
    const len = await resolveModelContextLength('http://x', 'missing-model-xyz');
    expect(len).toBeNull();
  });
});

describe('resolveNumCtx', () => {
  afterEach(() => { jest.restoreAllMocks(); delete (global as any).fetch; });

  it('uses the model max (capped to ceiling) when larger than configured', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model_info: { 'llama.context_length': 131072 } }),
    }));
    const r = await resolveNumCtx({ baseUrl: 'http://x', model: 'big-ctx-model-a', configuredNumCtx: 16384, ceiling: 32768 });
    expect(r.numCtx).toBe(32768); // capped
    expect(r.source).toBe('model-max');
  });

  it('never goes below the configured value', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model_info: { 'tiny.context_length': 4096 } }),
    }));
    const r = await resolveNumCtx({ baseUrl: 'http://x', model: 'tiny-ctx-model-b', configuredNumCtx: 16384, ceiling: 32768 });
    expect(r.numCtx).toBe(16384); // raised floor to configured
    expect(r.source).toBe('configured');
  });

  it('falls back to configured when /api/show is unavailable', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
    const r = await resolveNumCtx({ baseUrl: 'http://x', model: 'unknown-model-c', configuredNumCtx: 20000 });
    expect(r.numCtx).toBe(20000);
  });

  it('uses default 16384 when nothing configured and show fails', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
    const r = await resolveNumCtx({ baseUrl: 'http://x', model: 'unknown-model-d' });
    expect(r.numCtx).toBe(16384);
  });

  it('does NOT cap a cloud model at the local memory ceiling', async () => {
    // Same 200k-window model, but a :cloud id — the gateway owns memory, so the
    // ceiling must not clamp it. This is the core fix for early migration.
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model_info: { 'minimax.context_length': 200_000 } }),
    }));
    const r = await resolveNumCtx({ baseUrl: 'http://x', model: 'minimax-cloud-e:cloud', configuredNumCtx: 16384, ceiling: 32768 });
    expect(r.numCtx).toBe(200_000); // uncapped for cloud
    expect(r.source).toBe('model-max');
  });
});
