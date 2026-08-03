import fs from 'fs';
import os from 'os';
import path from 'path';
import { globToRegExp, buildMatcher, runSearch, formatSearchOutcome, diagnoseEmptySearch } from './search';

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-search-'));
  const write = (rel: string, body: string) => {
    const full = path.join(ws, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  write('index.ts', 'import { useState } from "react";\nexport const App = () => null;\n');
  write('src/app.ts', 'const useState = 1;\n// TODO: fix this\nconst usestate = 2;\n');
  write('src/deep/nested.ts', 'export function handler() {\n  return "TODO";\n}\n');
  write('src/app.test.ts', 'test("useState", () => {});\n');
  write('README.md', 'A project about useState.\n');
  write('node_modules/pkg/index.js', 'useState everywhere\n');
  write('.git/config', 'useState\n');
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('globToRegExp', () => {
  const m = (glob: string, p: string) => !!globToRegExp(glob)?.test(p);

  it('matches nested files with a leading double star', () => {
    expect(m('**/*.ts', 'src/deep/nested.ts')).toBe(true);
  });

  it('ALSO matches a top-level file with a leading double star', () => {
    // The subtle one. If this regresses, searches silently skip root files.
    expect(m('**/*.ts', 'index.ts')).toBe(true);
  });

  it('keeps a single star inside one path segment', () => {
    expect(m('src/*.ts', 'src/app.ts')).toBe(true);
    expect(m('src/*.ts', 'src/deep/nested.ts')).toBe(false);
  });

  it('handles a bare double star', () => {
    expect(m('src/**', 'src/deep/nested.ts')).toBe(true);
  });

  it('treats dots literally rather than as any-character', () => {
    expect(m('*.ts', 'axts')).toBe(false);
    expect(m('*.ts', 'a.ts')).toBe(true);
  });

  it('supports ? as a single non-separator character', () => {
    expect(m('src/a??.ts', 'src/app.ts')).toBe(true);
    expect(m('a?c', 'a/c')).toBe(false);
  });

  it('returns null for an empty glob rather than a match-everything regex', () => {
    expect(globToRegExp('')).toBeNull();
  });
});

describe('smart case', () => {
  it('is case-insensitive for an all-lowercase query', () => {
    const r = runSearch(ws, { query: 'usestate' });
    // Matches both `useState` and `usestate`.
    expect(r.totalHits).toBeGreaterThan(1);
  });

  it('is case-sensitive once the query contains a capital', () => {
    const withCap = runSearch(ws, { query: 'useState' });
    const lower = runSearch(ws, { query: 'usestate' });
    expect(withCap.totalHits).toBeLessThan(lower.totalHits);
  });

  it('can be forced either way', () => {
    expect(runSearch(ws, { query: 'useState', caseSensitive: false }).totalHits)
      .toEqual(runSearch(ws, { query: 'usestate' }).totalHits);
  });
});

describe('literal vs regex', () => {
  it('treats metacharacters literally by default', () => {
    fs.writeFileSync(path.join(ws, 'lit.txt'), 'a.c\nabc\n');
    const r = runSearch(ws, { query: 'a.c', include: '**/lit.txt' });
    expect(r.totalHits).toBe(1);           // only the real "a.c", not "abc"
  });

  it('honours a pattern when regex:true', () => {
    fs.writeFileSync(path.join(ws, 'lit.txt'), 'a.c\nabc\n');
    const r = runSearch(ws, { query: 'a.c', regex: true, include: '**/lit.txt' });
    expect(r.totalHits).toBe(2);
  });

  it('reports a bad regex as advice instead of throwing', () => {
    const r = runSearch(ws, { query: '(unclosed', regex: true });
    expect(r.error).toMatch(/Invalid regex/);
    expect(formatSearchOutcome({ query: '(unclosed', regex: true }, r)).toMatch(/drop regex:true/);
  });
});

describe('whole word', () => {
  it('does not match a substring when enabled', () => {
    fs.writeFileSync(path.join(ws, 'w.txt'), 'use\nuser\n');
    expect(runSearch(ws, { query: 'use', include: '**/w.txt' }).totalHits).toBe(2);
    expect(runSearch(ws, { query: 'use', wholeWord: true, include: '**/w.txt' }).totalHits).toBe(1);
  });
});

describe('scope', () => {
  it('never walks into node_modules or .git', () => {
    const r = runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(r.files.some((f) => f.includes('.git/'))).toBe(false);
  });

  it('respects include and exclude globs', () => {
    const included = runSearch(ws, { query: 'useState', caseSensitive: false, include: '**/*.ts' });
    expect(included.files.every((f) => f.endsWith('.ts'))).toBe(true);

    const excluded = runSearch(ws, { query: 'useState', caseSensitive: false, include: '**/*.ts', exclude: '**/*.test.ts' });
    expect(excluded.files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('can be limited to a subdirectory', () => {
    const r = runSearch(ws, { query: 'TODO', searchPath: 'src/deep' });
    expect(r.files).toEqual(['src/deep/nested.ts']);
  });

  it('errors clearly on a search path that does not exist', () => {
    expect(runSearch(ws, { query: 'x', searchPath: 'nope' }).error).toMatch(/does not exist/);
  });
});

describe('targets and modes', () => {
  it('searches filenames when asked', () => {
    const r = runSearch(ws, { query: 'nested', target: 'filenames' });
    expect(r.files).toEqual(['src/deep/nested.ts']);
  });

  it('returns per-file counts in count mode', () => {
    const r = runSearch(ws, { query: 'TODO', mode: 'count' });
    expect(r.counts?.length).toBe(2);
    const text = formatSearchOutcome({ query: 'TODO', mode: 'count' }, r);
    expect(text).toMatch(/src\/app\.ts/);
  });

  it('returns just paths in files mode', () => {
    const r = runSearch(ws, { query: 'TODO', mode: 'files' });
    const text = formatSearchOutcome({ query: 'TODO', mode: 'files' }, r);
    expect(text).not.toMatch(/fix this/);
    expect(text).toMatch(/src\/app\.ts/);
  });

  it('includes surrounding context when asked, marking the hit line', () => {
    const r = runSearch(ws, { query: 'TODO', searchPath: 'src', include: '**/app.ts', contextLines: 1 });
    const text = formatSearchOutcome({ query: 'TODO', contextLines: 1 }, r);
    expect(text).toMatch(/>/);            // the hit line is marked
    expect(text).toMatch(/const useState = 1;/);  // the line before it is shown
  });
});

describe('honesty about truncation', () => {
  it('reports the real total and says it truncated', () => {
    const many = Array.from({ length: 50 }, () => 'needle').join('\n');
    fs.writeFileSync(path.join(ws, 'many.txt'), many);
    const opts = { query: 'needle', maxResults: 5, include: '**/many.txt' };
    const r = runSearch(ws, opts);
    expect(r.hits.length).toBe(5);
    expect(r.totalHits).toBe(50);
    expect(r.truncated).toBe(true);
    const text = formatSearchOutcome(opts, r);
    expect(text).toMatch(/TRUNCATED/);
    expect(text).toMatch(/50 matches exist/);
  });

  it('does not claim truncation when everything was shown', () => {
    const r = runSearch(ws, { query: 'TODO' });
    expect(r.truncated).toBe(false);
    expect(formatSearchOutcome({ query: 'TODO' }, r)).not.toMatch(/TRUNCATED/);
  });

  it('groups output by file rather than repeating the path per line', () => {
    const r = runSearch(ws, { query: 'const', include: '**/app.ts' });
    const text = formatSearchOutcome({ query: 'const' }, r);
    // The path appears once as a heading, not once per matching line.
    expect(text.split('src/app.ts').length - 1).toBe(1);
  });
});

describe('empty results are diagnosed, not just reported', () => {
  it('explains an include glob that matched nothing', () => {
    // `src/*.ts` cannot reach src/deep/nested.ts — a single star stays inside
    // one path segment. This is the mistake the diagnosis exists to name.
    const opts = { query: 'handler', include: 'src/*.ts' };
    const r = runSearch(ws, opts);
    expect(r.totalHits).toBe(0);
    const text = formatSearchOutcome(opts, r);
    expect(text).toMatch(/\*\*\//);
  });

  it('says plainly when nothing at all was scanned', () => {
    const opts = { query: 'anything', include: '**/*.nosuchext' };
    const r = runSearch(ws, opts);
    expect(r.filesScanned).toBe(0);
    expect(formatSearchOutcome(opts, r)).toMatch(/matched no files/);
  });

  it('points out that smart case narrowed the search', () => {
    const opts = { query: 'NOSUCHTHING' };
    const note = diagnoseEmptySearch(opts, runSearch(ws, opts));
    expect(note).toMatch(/case-SENSITIVELY/);
  });

  it('suggests filename search and the symbol tools', () => {
    const opts = { query: 'zzz-not-here' };
    const note = diagnoseEmptySearch(opts, runSearch(ws, opts));
    expect(note).toMatch(/target:"filenames"/);
    expect(note).toMatch(/find_symbol/);
  });
});

describe('buildMatcher', () => {
  it('escapes a literal query so it cannot be read as a pattern', () => {
    const m = buildMatcher({ query: 'a+b' });
    expect('error' in m).toBe(false);
    if (!('error' in m)) expect(m.re.test('a+b')).toBe(true);
  });
});
