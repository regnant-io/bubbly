import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeTool } from './index';
import { regexSearchInFiles, fuzzyFileSearch } from './filesystem';
import { createCheckpoint, revertToCheckpoint, listCheckpoints } from './checkpoint';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}));

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-newtools-'));
}

describe('grep_search (regex)', () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'a.ts'), 'import x from "y";\nfunction foo() {}\nconst bar = 1;\n');
    fs.writeFileSync(path.join(ws, 'b.py'), 'def baz():\n    return 42\n');
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('matches an anchored pattern', () => {
    const r = regexSearchInFiles(ws, '^import');
    expect(r.matches.some((m) => m.file === 'a.ts' && m.line === 1)).toBe(true);
  });

  it('matches a quantified pattern across files', () => {
    const r = regexSearchInFiles(ws, '(function|def)\\s+\\w+');
    const files = r.matches.map((m) => m.file);
    expect(files).toContain('a.ts');
    expect(files).toContain('b.py');
  });

  it('respects include glob', () => {
    const r = regexSearchInFiles(ws, '\\w+', { includeGlob: '**/*.py' });
    expect(r.matches.every((m) => m.file.endsWith('.py'))).toBe(true);
  });

  it('returns an error for invalid regex', () => {
    const r = regexSearchInFiles(ws, '(unclosed');
    expect(r.error).toMatch(/invalid regex/i);
  });

  it('includes context lines when requested', () => {
    const r = regexSearchInFiles(ws, 'function foo', { contextLines: 1 });
    expect(r.matches[0].context).toContain('import x');
  });
});

describe('find_files (fuzzy)', () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWs();
    fs.mkdirSync(path.join(ws, 'src', 'scraper'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'scraper', 'dynamic_page_scraper.py'), 'x');
    fs.writeFileSync(path.join(ws, 'src', 'userModel.ts'), 'x');
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('finds a file by loose subsequence', () => {
    const hits = fuzzyFileSearch(ws, 'scraper');
    expect(hits[0].path).toContain('dynamic_page_scraper.py');
  });

  it('finds by camel fragment', () => {
    const hits = fuzzyFileSearch(ws, 'usermodel');
    expect(hits.some((h) => h.path.includes('userModel.ts'))).toBe(true);
  });
});

describe('read_files batch', () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'one.txt'), 'AAA');
    fs.writeFileSync(path.join(ws, 'two.txt'), 'BBB');
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('reads multiple files in one call', async () => {
    const r = await executeTool('read_files', { paths: ['one.txt', 'two.txt'] }, ws);
    expect(r.result).toContain('AAA');
    expect(r.result).toContain('BBB');
    expect(r.result).toContain('### one.txt');
  });

  it('reports per-file errors without failing the whole call', async () => {
    const r = await executeTool('read_files', { paths: ['one.txt', 'missing.txt'] }, ws);
    expect(r.result).toContain('AAA');
    expect(r.result).toContain('error');
  });
});

describe('checkpoints', () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'keep.txt'), 'original');
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('creates, lists, and reverts to a checkpoint', () => {
    const cp = createCheckpoint(ws, 'before changes');
    expect(cp.ok).toBe(true);
    expect(listCheckpoints(ws).length).toBe(1);

    // Mutate + add a new file.
    fs.writeFileSync(path.join(ws, 'keep.txt'), 'CHANGED');
    fs.writeFileSync(path.join(ws, 'added.txt'), 'new');

    const r = revertToCheckpoint(ws, cp.id!);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8')).toBe('original'); // restored
    expect(fs.existsSync(path.join(ws, 'added.txt'))).toBe(false); // removed
  });
});

describe('background process tools', () => {
  let ws: string;
  beforeEach(() => { ws = tmpWs(); });
  afterEach(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* process may still hold cwd on Windows */ } });

  it('starts a process, reads output, lists, and stops it', async () => {
    const cmd = 'echo hello-bg';
    const start = await executeTool('run_background', { command: cmd }, ws);
    const idMatch = /proc_[a-z0-9]+/.exec(start.result);
    expect(idMatch).not.toBeNull();
    const id = idMatch![0];

    // Poll for output — PowerShell startup on Windows can be slow.
    let out = { result: '' };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      out = await executeTool('get_process_output', { process_id: id, full: true }, ws);
      if (out.result.includes('hello-bg')) break;
    }
    expect(out.result).toContain('hello-bg');

    const list = await executeTool('list_processes', {}, ws);
    expect(list.result).toContain(id);

    const stop = await executeTool('stop_process', { process_id: id }, ws);
    expect(stop.result).toContain(id);
  }, 15000);

  it('reports a clear error for unknown process id', async () => {
    const out = await executeTool('get_process_output', { process_id: 'proc_nope' }, ws);
    expect(out.result).toMatch(/no background process/i);
  });
});

describe('rename_symbol', () => {
  let ws: string;
  beforeEach(() => {
    ws = tmpWs();
    fs.writeFileSync(path.join(ws, 'm.ts'), 'export function oldFn() { return 1; }\n');
    fs.writeFileSync(path.join(ws, 'use.ts'), 'import { oldFn } from "./m";\noldFn();\nconst oldFnTwo = 2;\n');
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('renames whole-word occurrences across files but not substrings', async () => {
    const r = await executeTool('rename_symbol', { old_name: 'oldFn', new_name: 'newFn' }, ws);
    expect(r.result).toMatch(/Renamed/);
    const m = fs.readFileSync(path.join(ws, 'm.ts'), 'utf8');
    const use = fs.readFileSync(path.join(ws, 'use.ts'), 'utf8');
    expect(m).toContain('newFn');
    expect(use).toContain('newFn();');
    // The substring identifier "oldFnTwo" must NOT be renamed.
    expect(use).toContain('oldFnTwo');
  });

  it('rejects an invalid identifier', async () => {
    const r = await executeTool('rename_symbol', { old_name: 'oldFn', new_name: '123bad' }, ws);
    expect(r.result).toMatch(/not a valid identifier/i);
  });
});
