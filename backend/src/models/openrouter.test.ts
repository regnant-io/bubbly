import {
  callOpenRouter,
  getOpenRouterModelContext,
  getOpenRouterModelVision,
  listOpenRouterModels,
  resetOpenRouterCachesForTests,
  toOpenRouterMessages,
} from './openrouter';
import type { Message } from '../types';

describe('OpenRouter adapter', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetOpenRouterCachesForTests();
  });

  it('translates neutral tool blocks to the OpenAI tool-call protocol', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'file contents',
            images: [{ mediaType: 'image/png', data: 'abc123' }],
          },
        ],
      },
    ];

    expect(toOpenRouterMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image returned by tool call call_1:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ]);
  });

  it('preserves orphaned compacted tool results as valid user context', () => {
    const messages: Message[] = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: 'important result' }],
    }];

    expect(toOpenRouterMessages(messages)).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: '[tool result]\nimportant result' }],
    }]);
  });

  it('does not emit an invalid empty assistant turn for reasoning-only history', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private reasoning' }],
    }];

    expect(toOpenRouterMessages(messages)).toEqual([]);
  });

  it('returns provider stop reason and token usage', async () => {
    let body: any;
    global.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 23, completion_tokens: 7 },
        }),
      } as Response;
    }) as typeof fetch;

    const response = await callOpenRouter({
      apiKey: 'secret',
      model: 'vendor/model',
      systemPrompt: 'system',
      messages: [],
      tools: [],
    });

    expect(body.messages).toEqual([{ role: 'system', content: 'system' }]);
    expect(response).toMatchObject({
      textContent: 'partial',
      stopReason: 'max_tokens',
      usage: { inputTokens: 23, outputTokens: 7 },
    });
  });

  it('shares and normalizes the model catalogue for listing and context resolution', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'z/model', context_length: '131072', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'a/model', context_length: 32768 },
        ],
      }),
    } as Response));
    global.fetch = fetchMock as typeof fetch;

    await expect(listOpenRouterModels('key')).resolves.toEqual(['a/model', 'z/model']);
    await expect(getOpenRouterModelContext('key', 'z/model')).resolves.toBe(131072);
    await expect(getOpenRouterModelVision('key', 'z/model')).resolves.toBe(true);
    await expect(getOpenRouterModelVision('key', 'a/model')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('consumes a final streaming event without a trailing newline', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}'));
        controller.close();
      },
    });
    global.fetch = (async () => ({ ok: true, body: stream } as Response)) as typeof fetch;
    const chunks: string[] = [];

    const response = await callOpenRouter({
      apiKey: 'key',
      model: 'vendor/model',
      systemPrompt: '',
      messages: [],
      tools: [],
      onToken: (token) => chunks.push(token),
    });

    expect(chunks).toEqual(['hello']);
    expect(response).toMatchObject({
      textContent: 'hello',
      stopReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 1 },
    });
  });
});
