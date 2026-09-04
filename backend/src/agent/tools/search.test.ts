import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  globToRegExp, buildMatcher, runSearch, formatSearchOutcome, diagnoseEmptySearch,
  normalizeGlob, expandBraces, effectiveGlobs, parseGitignore, splitPatterns,
} from './search';

let ws: string;

const write = (root: string, rel: string, body: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-search-'));
  write(ws, 'index.ts', 'import { useState } from "react";\nexport const App = () => null;\n');
  write(ws, 'src/app.ts', 'const useState = 1;\n// TODO: fix this\nconst usestate = 2;\n');
  write(ws, 'src/deep/nested.ts', 'export function handler() {\n  return "TODO";\n}\n');
  write(ws, 'src/app.test.ts', 'test("useState", () => {});\n');
  write(ws, 'README.md', 'A project about useState.\n');
  write(ws, 'node_modules/pkg/index.js', 'useState everywhere\n');
  write(ws, '.git/config', 'useState\n');
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

describe('pattern normalization — the bug that made searches lie', () => {
  it('anchors a bare extension glob at any depth', () => {
    // `include: "*.ts"` used to match ONLY top-level files, so a search for a
    // symbol "in the TypeScript files" scanned two of them and confidently
    // reported that the symbol did not exist.
    expect(normalizeGlob('*.ts')).toEqual(['**/*.ts']);
  });

  it('understands a bare extension with no star', () => {
    expect(normalizeGlob('ts')).toContain('**/*.ts');
  });

  it('expands a named language group', () => {
    expect(normalizeGlob('web')).toEqual(expect.arrayContaining(['**/*.tsx', '**/*.css']));
  });

  it('treats a bare directory as everything beneath it', () => {
    expect(normalizeGlob('src/components')).toEqual(['src/components/**', 'src/components']);
  });

  it('leaves an explicit deep glob exactly as written', () => {
    expect(normalizeGlob('src/**/*.spec.ts')).toEqual(['src/**/*.spec.ts']);
  });

  it('expands brace groups', () => {
    expect(expandBraces('*.{ts,tsx}').sort()).toEqual(['*.ts', '*.tsx']);
  });

  it('splits a comma-separated list', () => {
    expect(splitPatterns('ts, tsx , md')).toEqual(['ts', 'tsx', 'md']);
  });

  it('composes all of the above', () => {
    expect(effectiveGlobs('*.{ts,tsx}')).toEqual(['**/*.ts', '**/*.tsx']);
  });

  it('actually finds nested files with the forgiving pattern', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false, include: '*.ts' });
    expect(r.files).toEqual(expect.arrayContaining(['index.ts', 'src/app.ts']));
  });
});

describe('smart case', () => {
  it('an all-lowercase query matches any case', async () => {
    const r = await runSearch(ws, { query: 'usestate' });
    expect(r.totalHits).toBeGreaterThan(1);
  });

  it('a query with a capital is case-sensitive', async () => {
    const withCap = await runSearch(ws, { query: 'useState' });
    const lower = await runSearch(ws, { query: 'usestate' });
    expect(withCap.totalHits).toBeLessThan(lower.totalHits);
  });

  it('case_sensitive:false overrides smart case', async () => {
    const a = await runSearch(ws, { query: 'useState', caseSensitive: false });
    const b = await runSearch(ws, { query: 'usestate' });
    expect(a.totalHits).toEqual(b.totalHits);
  });
});

describe('literal vs regex', () => {
  beforeEach(() => write(ws, 'lit.txt', 'a.c\nabc\n'));

  it('is literal by default, so a dot is a dot', async () => {
    const r = await runSearch(ws, { query: 'a.c', include: '**/lit.txt' });
    expect(r.totalHits).toBe(1);
  });

  it('regex:true makes the dot a wildcard', async () => {
    const r = await runSearch(ws, { query: 'a.c', regex: true, include: '**/lit.txt' });
    expect(r.totalHits).toBe(2);
  });

  it('reports a malformed regex as advice, not a crash', async () => {
    const r = await runSearch(ws, { query: '(unclosed', regex: true });
    expect(r.error).toMatch(/Invalid regex/);
    expect(formatSearchOutcome({ query: '(unclosed', regex: true }, r)).toMatch(/drop regex:true/);
  });

  it('multiline lets a pattern span lines', async () => {
    write(ws, 'multi.ts', 'function a(\n  x: number,\n) {}\n');
    const r = await runSearch(ws, {
      query: 'function a\\([\\s\\S]*?\\)', multiline: true, include: '**/multi.ts',
    });
    expect(r.totalHits).toBe(1);
  });
});

describe('whole word', () => {
  beforeEach(() => write(ws, 'w.txt', 'use\nuser\n'));

  it('matches substrings by default', async () => {
    const r = await runSearch(ws, { query: 'use', include: '**/w.txt' });
    expect(r.totalHits).toBe(2);
  });

  it('whole_word restricts to word boundaries', async () => {
    const r = await runSearch(ws, { query: 'use', wholeWord: true, include: '**/w.txt' });
    expect(r.totalHits).toBe(1);
  });
});

describe('scoping', () => {
  it('never scans node_modules or .git', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(r.files.some((f) => f.includes('.git/'))).toBe(false);
  });

  it('include narrows, exclude subtracts', async () => {
    const included = await runSearch(ws, { query: 'useState', caseSensitive: false, include: '**/*.ts' });
    expect(included.files).toContain('src/app.test.ts');
    const excluded = await runSearch(ws, {
      query: 'useState', caseSensitive: false, include: '**/*.ts', exclude: '**/*.test.ts',
    });
    expect(excluded.files).not.toContain('src/app.test.ts');
  });

  it('exclude accepts the forgiving syntax too', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false, exclude: '*.test.ts,*.md' });
    expect(r.files).not.toContain('src/app.test.ts');
    expect(r.files).not.toContain('README.md');
  });

  it('search_path limits the walk', async () => {
    const r = await runSearch(ws, { query: 'TODO', searchPath: 'src/deep' });
    expect(r.files).toEqual(['src/deep/nested.ts']);
  });

  it('a missing search_path is an error, not an empty result', async () => {
    const r = await runSearch(ws, { query: 'x', searchPath: 'nope' });
    expect(r.error).toMatch(/does not exist/);
  });
});

describe('.gitignore is respected', () => {
  beforeEach(() => {
    write(ws, '.gitignore', 'generated/\n*.gen.ts\n!keep.gen.ts\n');
    write(ws, 'generated/bundle.ts', 'useState '.repeat(50) + '\n');
    write(ws, 'src/thing.gen.ts', 'useState\n');
    write(ws, 'src/keep.gen.ts', 'useState\n');
  });

  it('skips an ignored directory', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files.some((f) => f.startsWith('generated/'))).toBe(false);
  });

  it('skips an ignored file pattern', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files).not.toContain('src/thing.gen.ts');
  });

  it('honours a negation', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files).toContain('src/keep.gen.ts');
  });

  it('include_ignored:true searches them anyway', async () => {
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false, includeIgnored: true });
    expect(r.files.some((f) => f.startsWith('generated/'))).toBe(true);
  });

  it('parses the common rule forms', () => {
    const rules = parseGitignore('# c\n\ndist/\n*.log\n/root-only\n!keep.log\n');
    expect(rules).toHaveLength(4);
    expect(rules[3].negated).toBe(true);
    expect(rules[0].dirOnly).toBe(true);
  });
});

describe('targets and modes', () => {
  it('target filenames searches paths', async () => {
    const r = await runSearch(ws, { query: 'nested', target: 'filenames' });
    expect(r.files).toEqual(['src/deep/nested.ts']);
  });

  it('target both searches paths AND contents', async () => {
    const r = await runSearch(ws, { query: 'app', target: 'both', caseSensitive: false });
    expect(r.files).toEqual(expect.arrayContaining(['src/app.ts', 'src/app.test.ts']));
  });

  it('mode count reports per-file counts', async () => {
    const r = await runSearch(ws, { query: 'TODO', mode: 'count' });
    expect(r.counts?.length).toBeGreaterThan(0);
    expect(formatSearchOutcome({ query: 'TODO', mode: 'count' }, r)).toMatch(/src\/app\.ts/);
  });

  it('mode files returns just paths', async () => {
    const r = await runSearch(ws, { query: 'TODO', mode: 'files' });
    expect(formatSearchOutcome({ query: 'TODO', mode: 'files' }, r)).not.toMatch(/fix this/);
  });

  it('context lines are included when asked for', async () => {
    const r = await runSearch(ws, { query: 'TODO', searchPath: 'src', include: '**/app.ts', contextLines: 1 });
    expect(formatSearchOutcome({ query: 'TODO', contextLines: 1 }, r)).toMatch(/const useState = 1/);
  });

  it('records the column of a match for precise navigation', async () => {
    const r = await runSearch(ws, { query: 'useState', include: 'src/app.ts' });
    expect(r.hits[0]?.column).toBe(7);
  });
});

describe('honesty about what was NOT searched', () => {
  it('reports truncation rather than implying completeness', async () => {
    write(ws, 'many.txt', 'match\n'.repeat(50));
    const opts = { query: 'match', maxResults: 5, include: '**/many.txt' };
    const r = await runSearch(ws, opts);
    expect(r.truncated).toBe(true);
    expect(r.totalHits).toBe(50);
    expect(formatSearchOutcome(opts, r)).toMatch(/TRUNCATED/);
  });

  it('does not claim truncation when everything is shown', async () => {
    const r = await runSearch(ws, { query: 'TODO' });
    expect(r.truncated).toBe(false);
    expect(formatSearchOutcome({ query: 'TODO' }, r)).not.toMatch(/TRUNCATED/);
  });

  it('reports the effective include globs so a rewrite is never a mystery', async () => {
    const r = await runSearch(ws, { query: 'zzz', include: 'ts' });
    expect(r.effectiveInclude).toContain('**/*.ts');
  });
});

describe('empty-result diagnosis', () => {
  it('names an include glob that matched nothing', async () => {
    const opts = { query: 'useState', include: '**/*.rs' };
    const r = await runSearch(ws, opts);
    expect(formatSearchOutcome(opts, r)).toMatch(/matched no files/);
  });

  it('mentions .gitignore, because that is where the file usually went', async () => {
    const opts = { query: 'definitely-not-here' };
    expect(diagnoseEmptySearch(opts, await runSearch(ws, opts))).toMatch(/gitignore/);
  });

  it('points at find_symbol for code symbols', async () => {
    const opts = { query: 'definitely-not-here' };
    expect(diagnoseEmptySearch(opts, await runSearch(ws, opts))).toMatch(/find_symbol/);
  });

  it('explains smart case when the query has a capital', async () => {
    const opts = { query: 'NotPresentAnywhere' };
    expect(diagnoseEmptySearch(opts, await runSearch(ws, opts))).toMatch(/case-SENSITIVELY/);
  });
});

describe('buildMatcher', () => {
  it('escapes literal queries', () => {
    const m = buildMatcher({ query: 'a+b' });
    expect('error' in m).toBe(false);
    if (!('error' in m)) {
      m.re.lastIndex = 0;
      expect(m.re.test('a+b')).toBe(true);
      m.re.lastIndex = 0;
      expect(m.re.test('aab')).toBe(false);
    }
  });

  it('is global so every match on a line can be counted', () => {
    const m = buildMatcher({ query: 'x' });
    if (!('error' in m)) expect(m.re.flags).toContain('g');
  });
});

describe('binary files are never scanned', () => {
  it('skips a file with a NUL byte', async () => {
    fs.writeFileSync(path.join(ws, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const r = await runSearch(ws, { query: 'A' });
    expect(r.files).not.toContain('blob.dat');
  });

  it('skips known binary extensions without reading them', async () => {
    fs.writeFileSync(path.join(ws, 'img.png'), 'useState');
    const r = await runSearch(ws, { query: 'useState', caseSensitive: false });
    expect(r.files).not.toContain('img.png');
  });
});
