/**
 * Tool calls the model writes into the answer instead of the tool channel.
 *
 * Two properties matter and they pull against each other: nothing that is
 * really a tool call may reach the user as text (a leaked write_file dumps a
 * whole file into the chat AND never runs), and nothing that is really prose
 * may be swallowed. The interesting cases are all at chunk boundaries, because
 * the filter has to decide what to emit while holding only a prefix.
 */

import { ToolCallLeakFilter, parseLeakedToolCall, looksLikeBareToolCall } from './toolCallLeak';

/** Feed a whole string one chunk at a time and collect the emitted text. */
function runChunked(text: string, size: number): { out: string; filter: ToolCallLeakFilter } {
  const filter = new ToolCallLeakFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) {
    out += filter.push(text.slice(i, i + size));
  }
  out += filter.finish();
  return { out, filter };
}

const CALL = '{"name": "write_file", "arguments": {"path": "a.ts", "content": "x"}}';

describe('recovering a tagged tool call', () => {
  it('suppresses the payload and converts it into a real call', () => {
    const { out, filter } = runChunked(`Sure, I'll do that.<tool_call>${CALL}</tool_call>`, 4096);
    expect(out).toBe("Sure, I'll do that.");
    expect(filter.recovered).toEqual([
      { name: 'write_file', args: { path: 'a.ts', content: 'x' } },
    ]);
  });

  it.each([1, 2, 3, 7, 13, 64])('works when the stream is split every %i chars', (size) => {
    // The marker, and the JSON body, land across chunk boundaries at these
    // sizes — which is exactly how a real network stream arrives.
    const { out, filter } = runChunked(`before <tool_call>${CALL}</tool_call> after`, size);
    expect(out).toBe('before  after');
    expect(filter.recovered).toHaveLength(1);
    expect(filter.recovered[0].name).toBe('write_file');
  });

  it('handles several calls in one response', () => {
    const { out, filter } = runChunked(
      `<tool_call>${CALL}</tool_call>and<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>`,
      5,
    );
    expect(out).toBe('and');
    expect(filter.recovered.map((c) => c.name)).toEqual(['write_file', 'read_file']);
  });

  it.each([
    ['<tool_call>', '</tool_call>'],
    ['<|tool_call|>', '<|/tool_call|>'],
    ['<function_call>', '</function_call>'],
  ])('recognises the %s marker style', (open, close) => {
    const { out, filter } = runChunked(`${open}${CALL}${close}`, 6);
    expect(out).toBe('');
    expect(filter.recovered).toHaveLength(1);
  });

  it('recovers a call whose closing marker never arrived', () => {
    // A model that hits its token limit mid-call often still emitted complete
    // JSON. Losing the call there would strand the turn.
    const { out, filter } = runChunked(`<tool_call>${CALL}`, 8);
    expect(out).toBe('');
    expect(filter.recovered).toHaveLength(1);
  });

  it('flags that a leak happened, for logging', () => {
    const { filter } = runChunked(`<tool_call>${CALL}</tool_call>`, 4096);
    expect(filter.sawLeak).toBe(true);
  });
});

describe('prose is never eaten', () => {
  it('passes ordinary text straight through', () => {
    const text = 'I read the file and it looks fine. 3 < 5 and 10 > 2.';
    const { out, filter } = runChunked(text, 3);
    expect(out).toBe(text);
    expect(filter.recovered).toHaveLength(0);
    expect(filter.sawLeak).toBe(false);
  });

  it('does not hold back a trailing "<" forever', () => {
    // Held back mid-stream in case a marker is arriving, but finish() must
    // release it — otherwise the answer silently loses its last characters.
    const filter = new ToolCallLeakFilter();
    const mid = filter.push('a < b');
    const end = filter.finish();
    expect(mid + end).toBe('a < b');
  });

  it('releases a held-back tail once the next chunk proves it is not a marker', () => {
    // "<" alone could begin "<tool_call>", so it is withheld; "<=" cannot, so
    // the whole thing must flow again immediately — not sit there until the
    // stream ends.
    const filter = new ToolCallLeakFilter();
    const first = filter.push('value <');
    const second = filter.push('= 10');
    expect(first + second).toBe('value <= 10');
    expect(filter.finish()).toBe('');
  });

  it('holds back only a genuine partial marker, not everything after a "<"', () => {
    const filter = new ToolCallLeakFilter();
    // "<too" is a prefix of "<tool_call>" — correctly withheld.
    expect(filter.push('a <too')).toBe('a ');
    // …and released the moment it turns out to be prose.
    expect(filter.push('ls are ready')).toBe('<tools are ready');
  });

  it('gives unparseable marker contents back as text rather than discarding them', () => {
    // Losing whatever the model actually said is worse than showing something
    // ugly, so a body that isn't a tool call is emitted.
    const { out, filter } = runChunked('<tool_call>not json at all</tool_call>', 4096);
    expect(out).toBe('not json at all');
    expect(filter.recovered).toHaveLength(0);
  });

  it('leaves a fenced JSON code block alone', () => {
    const text = 'Here is the config:\n```json\n{"name": "demo", "version": 1}\n```\n';
    const { out, filter } = runChunked(text, 9);
    expect(out).toBe(text);
    expect(filter.recovered).toHaveLength(0);
  });
});

describe('parsing a call body', () => {
  it('accepts the common key spellings', () => {
    expect(parseLeakedToolCall('{"name":"a","arguments":{"x":1}}')).toEqual({ name: 'a', args: { x: 1 } });
    expect(parseLeakedToolCall('{"tool":"a","args":{"x":1}}')).toEqual({ name: 'a', args: { x: 1 } });
    expect(parseLeakedToolCall('{"tool_name":"a","parameters":{"x":1}}')).toEqual({ name: 'a', args: { x: 1 } });
  });

  it('unwraps double-encoded arguments', () => {
    expect(parseLeakedToolCall('{"name":"a","arguments":"{\\"x\\":1}"}')).toEqual({ name: 'a', args: { x: 1 } });
  });

  it('defaults missing arguments to an empty object', () => {
    expect(parseLeakedToolCall('{"name":"list_specs"}')).toEqual({ name: 'list_specs', args: {} });
  });

  it('digs the object out of surrounding noise', () => {
    expect(parseLeakedToolCall('sure: {"name":"a","arguments":{}} ok')).toEqual({ name: 'a', args: {} });
  });

  it('unwraps a single call wrapped in an array, which some templates emit', () => {
    expect(parseLeakedToolCall('[{"name":"a","arguments":{"x":1}}]')).toEqual({ name: 'a', args: { x: 1 } });
  });

  it.each([
    'not json',
    '{"arguments":{"x":1}}',              // no name
    '[{"name":"a"},{"name":"b"}]',        // ambiguous: not one call
    '{"name":"","arguments":{}}',
    '',
  ])('rejects %p', (body) => {
    expect(parseLeakedToolCall(body)).toBeNull();
  });
});

describe('the untagged bare-JSON shape', () => {
  it.each([
    '{"name": "write_file", "arguments": {}}',
    '  {"tool":"read_file","args":{}}',
    '{"arguments": {"path": "a"}}',
  ])('recognises %p', (text) => {
    expect(looksLikeBareToolCall(text)).toBe(true);
  });

  it.each([
    'Here is some JSON: {"name": "x"}',
    '{"result": 1}',
    '{"path": "a.ts"}',
    'plain prose',
    '```json\n{"name":"x"}\n```',
  ])('does not claim %p', (text) => {
    // Narrow on purpose — a false positive here would blank a real answer.
    expect(looksLikeBareToolCall(text)).toBe(false);
  });
});
