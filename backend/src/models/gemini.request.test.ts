import { callGemini } from './gemini';
import type { Message, ToolDefinition } from '../types';

describe('gemini request body', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const okJson = (body: any) => ({ ok: true, status: 200, json: async () => body } as any);

  it('maps messages to contents, system prompt to systemInstruction, and parses text', async () => {
    let url = '';
    let captured: any = null;
    global.fetch = (async (u: string, opts: any) => {
      url = u;
      captured = JSON.parse(opts.body);
      return okJson({
        candidates: [{ content: { parts: [{ text: 'hello world' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
      });
    }) as any;

    const res = await callGemini({
      apiKey: 'k',
      model: 'gemini-2.0-flash',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      // non-streaming path
    });

    expect(url).toContain(':generateContent');
    expect(captured.systemInstruction.parts[0].text).toBe('be helpful');
    expect(captured.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(res.textContent).toBe('hello world');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    expect(res.stopReason).toBe('end_turn');
  });

  it('parses functionCall parts into toolCalls', async () => {
    global.fetch = (async () =>
      okJson({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'write_file', args: { path: 'a.txt', content: 'x' } } }] },
            finishReason: 'STOP',
          },
        ],
      })) as any;

    const tools: ToolDefinition[] = [
      { name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ];
    const res = await callGemini({
      apiKey: 'k', model: 'gemini-2.0-flash', systemPrompt: 's', messages: [{ role: 'user', content: 'go' }], tools,
    });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('write_file');
    expect(res.toolCalls[0].args).toEqual({ path: 'a.txt', content: 'x' });
    expect(res.stopReason).toBe('tool_use');
  });

  it('encodes tool results as functionResponse matched by name', async () => {
    let captured: any = null;
    global.fetch = (async (_u: string, opts: any) => {
      captured = JSON.parse(opts.body);
      return okJson({ candidates: [{ content: { parts: [{ text: 'done' }] } }] });
    }) as any;

    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] },
    ];

    await callGemini({ apiKey: 'k', model: 'gemini-2.0-flash', systemPrompt: 's', messages, tools: [] });

    const last = captured.contents[captured.contents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts[0].functionResponse.name).toBe('read_file');
    expect(last.parts[0].functionResponse.response).toEqual({ result: 'file body' });
  });

  it('clamps maxOutputTokens to the model cap', async () => {
    let captured: any = null;
    global.fetch = (async (_u: string, opts: any) => {
      captured = JSON.parse(opts.body);
      return okJson({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }) as any;

    await callGemini({
      apiKey: 'k', model: 'gemini-2.0-flash', systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 32000,
    });

    expect(captured.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('throws a descriptive error on non-ok response', async () => {
    global.fetch = (async () => ({ ok: false, status: 403, text: async () => 'API key invalid' } as any)) as any;
    await expect(
      callGemini({ apiKey: 'bad', model: 'gemini-2.0-flash', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })
    ).rejects.toThrow(/Gemini API error 403/);
  });

  it('waits out a 429 using the server retryDelay, then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const body429 = JSON.stringify({ error: { code: 429, message: 'Please retry in 1s', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
    global.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, clone: () => ({ text: async () => body429 }), text: async () => body429 } as any;
      }
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'recovered' }] } }] }) } as any;
    }) as any;

    const res = await callGemini({
      apiKey: 'k', model: 'gemini-2.0-flash', systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }], tools: [],
      maxRateLimitWaitMs: 5000,
      onRateLimitWait: (ms) => waits.push(ms),
    });

    expect(calls).toBe(2);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(res.textContent).toBe('recovered');
  });

  it('does NOT wait when the retryDelay exceeds the budget, surfaces 429', async () => {
    let calls = 0;
    const body429 = JSON.stringify({ error: { code: 429, message: 'Please retry in 55s', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '55s' }] } });
    global.fetch = (async () => {
      calls++;
      return { ok: false, status: 429, clone: () => ({ text: async () => body429 }), text: async () => body429 } as any;
    }) as any;

    await expect(
      callGemini({
        apiKey: 'k', model: 'gemini-2.0-flash', systemPrompt: 's',
        messages: [{ role: 'user', content: 'hi' }], tools: [],
        maxRateLimitWaitMs: 5000,
      })
    ).rejects.toThrow(/Gemini API error 429/);
    // One request, no wait: the hint (55s) is over the 5s budget.
    expect(calls).toBe(1);
  });
});
