import { callModel } from './index';
import type { AgentConfig, Message, ToolDefinition } from '../types';

/**
 * Cordon is Regnant's confidential inference engine. Bubbly reaches it through
 * Cordon's OpenAI-compatible route, so the wire contract is what matters here:
 * the right URL, the client identity Cordon admits the request under, the
 * tool definitions, and the model's tool calls coming back as Bubbly's own.
 */
describe('Cordon provider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const tools: ToolDefinition[] = [{
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  } as ToolDefinition];

  const config: AgentConfig = {
    provider: 'cordon',
    model: 'default',
    cordonUrl: 'http://cordon.test:8443/',
    cordonClientId: 'bubbly',
    maxTokens: 4096,
  };

  it('calls the node as the enrolled client and returns its tool calls', async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};
    global.fetch = jest.fn(async (url: any, init: any) => {
      seen.url = String(url);
      seen.headers = init.headers;
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        object: 'chat.completion',
        model: 'default',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ index: 0, id: 'call_1', type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } }],
          },
        }],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        cordon: { request_id: 'req-1', signature: { value: 'sig', key_provenance: 'cmk_derived' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const messages: Message[] = [{ role: 'user', content: 'What is in main.ts?' }];
    const res = await callModel({ config, systemPrompt: 'You are Bubbly.', messages, tools });

    expect(seen.url).toBe('http://cordon.test:8443/openai/v1/chat/completions');
    expect(seen.headers?.['x-client-id']).toBe('bubbly');
    expect(seen.headers?.Authorization).toBe('Bearer bubbly');
    expect(seen.body.model).toBe('default');
    expect(seen.body.max_tokens).toBe(4096);
    expect(seen.body.tools[0].function.name).toBe('read_file');
    expect(seen.body.messages[0]).toEqual({ role: 'system', content: 'You are Bubbly.' });

    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('read_file');
    expect(res.toolCalls[0].args).toEqual({ path: 'src/main.ts' });
  });

  it('surfaces a refusal from Cordon instead of an empty answer', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      error: { message: 'client bubbly is not permitted to use model default', type: 'authentication_error', code: 'auth_failed' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await expect(callModel({
      config, systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], tools: [],
    })).rejects.toThrow(/403|not permitted/);
  });
});
