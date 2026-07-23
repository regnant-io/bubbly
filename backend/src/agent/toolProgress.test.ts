/**
 * Reading progress out of a tool call's partially-streamed JSON arguments.
 *
 * This runs against INCOMPLETE JSON by definition — it must never throw, and it
 * must surface the file path as early as possible, since that path is the only
 * useful thing on screen during the minute a large file takes to generate.
 */

import { describeToolProgress } from './orchestrator';

describe('describeToolProgress', () => {
  it('finds the path as soon as it has streamed, long before the content ends', () => {
    // Realistic mid-stream state: path complete, content barely started.
    const partial = '{"path": "src/components/App.tsx", "content": "import React';
    const r = describeToolProgress(partial);
    expect(r.path).toBe('src/components/App.tsx');
  });

  it('returns no path when the path value is still streaming', () => {
    const r = describeToolProgress('{"path": "src/comp');
    expect(r.path).toBeUndefined();
  });

  it('counts escaped newlines as the file\'s line count', () => {
    const partial = '{"path":"a.ts","content":"line1\\nline2\\nline3';
    expect(describeToolProgress(partial).lines).toBe(3);
  });

  it('reports a single line before any newline exists', () => {
    expect(describeToolProgress('{"path":"a.ts","content":"just one line').lines).toBe(1);
  });

  it('unescapes a path containing escaped characters', () => {
    const r = describeToolProgress('{"path": "src\\\\win\\\\file.ts", "content": "x');
    expect(r.path).toBe('src\\win\\file.ts');
  });

  it('accepts file_path and target as aliases', () => {
    expect(describeToolProgress('{"file_path": "a/b.ts"').path).toBe('a/b.ts');
    expect(describeToolProgress('{"target": "c/d.ts"').path).toBe('c/d.ts');
  });

  it('never throws on garbage or empty input', () => {
    for (const s of ['', '{', '{"path":', 'not json at all', '\\n\\n\\n']) {
      expect(() => describeToolProgress(s)).not.toThrow();
    }
  });

  it('tracks growth: bytes and lines both increase as content streams', () => {
    const early = describeToolProgress('{"path":"a.ts","content":"a\\nb');
    const later = describeToolProgress('{"path":"a.ts","content":"a\\nb\\nc\\nd');
    expect(later.lines).toBeGreaterThan(early.lines);
    expect(later.bytes).toBeGreaterThan(early.bytes);
  });

  it('does not mistake a literal backslash-n in prose for a newline pair', () => {
    // "\\n" in the JSON source is an escaped BACKSLASH followed by n — the file
    // contains the two characters, not a line break.
    const r = describeToolProgress('{"path":"a.ts","content":"a\\\\nb');
    // One real line: the sequence is an escaped backslash, not a newline.
    expect(r.lines).toBe(1);
  });
});
