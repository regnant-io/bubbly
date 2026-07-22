import { callOllama } from './ollama';
import type { Message } from '../types';

/**
 * Regression tests for the screenshot failure:
 *
 * A browser_control screenshot attaches an image to the tool result. Ollama
 * Cloud (and OpenAI-compatible proxies) reject image-bearing requests with a
 * bare schema error — `{"error":"Input should be a valid string"}` — that never
 * mentions "image" or "vision". The retry used to require an explicitly
 * image-shaped error message, so it re-sent the identical payload and the whole
 * agent run died right after taking a screenshot.
 */
describe('ollama 400 retry with images', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  /** A tool result carrying a screenshot, as browser_control produces. */
  const messagesWithImage = (): Message[] => ([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'browser_control', input: { action: 'screenshot' } }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'Screenshot captured.',
        images: [{ mediaType: 'image/png', data: 'AAABBBCCC' }],
      }],
    },
  ]);

  it('strips images and retries when a 400 does not mention images at all', async () => {
    const bodies: any[] = [];
    let call = 0;
    global.fetch = (async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      call++;
      if (call === 1) {
        // Exactly what Ollama Cloud returned in the reported failure.
        return {
          ok: false,
          status: 400,
          text: async () => '{"error":"Input should be a valid string (ref: 67b376d7)"}\n',
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'saw it' }, done: true }),
      } as any;
    }) as any;

    const res = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'gemma4:31b-cloud',
      systemPrompt: 'sys',
      messages: messagesWithImage(),
      tools: [],
    });

    expect(call).toBe(2); // it retried rather than throwing
    // First attempt carried the image...
    expect(bodies[0].messages.some((m: any) => m.images?.length)).toBe(true);
    // ...the retry must NOT.
    expect(bodies[1].messages.some((m: any) => m.images?.length)).toBe(false);
    expect(res.textContent).toBe('saw it');
  });

  it('remembers the host rejects images and strips them proactively next time', async () => {
    const bodies: any[] = [];
    let call = 0;
    global.fetch = (async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      call++;
      if (call === 1) {
        return { ok: false, status: 400, text: async () => '{"error":"Input should be a valid string"}\n' } as any;
      }
      return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }) } as any;
    }) as any;

    const base = {
      baseUrl: 'http://localhost:11434',
      model: 'vision-reject-test',
      systemPrompt: 'sys',
      tools: [],
    };

    await callOllama({ ...base, messages: messagesWithImage() });
    expect(call).toBe(2);

    // A SECOND call must not repeat the failed round-trip — the image should be
    // gone from the very first request this time.
    await callOllama({ ...base, messages: messagesWithImage() });
    expect(call).toBe(3);
    expect(bodies[2].messages.some((m: any) => m.images?.length)).toBe(false);
  });

  it('does not blame images when the 400 is clearly about thinking', async () => {
    let call = 0;
    global.fetch = (async (_url: string, opts: any) => {
      call++;
      if (call === 1) {
        return { ok: false, status: 400, text: async () => '{"error":"think is not supported"}' } as any;
      }
      return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }) } as any;
    }) as any;

    const base = {
      baseUrl: 'http://localhost:11434',
      model: 'think-reject-test',
      systemPrompt: 'sys',
      tools: [],
      enableThinking: true,
    };

    await callOllama({ ...base, messages: messagesWithImage() });

    // The think-related 400 must NOT permanently mark this model as blind, so a
    // later request still gets to send its image.
    const bodies: any[] = [];
    global.fetch = (async (_url: string, opts: any) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }) } as any;
    }) as any;
    await callOllama({ ...base, messages: messagesWithImage() });
    expect(bodies[0].messages.some((m: any) => m.images?.length)).toBe(true);
  });
});
