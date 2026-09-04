/**
 * Project data relocation + migration.
 *
 * The contract:
 *   - A project's private state lives OUTSIDE the project folder, so a fresh
 *     workspace stays empty enough for clean-slate scaffolds (`npm create vite .`).
 *   - The same project always maps to the same external dir (stable), and two
 *     different projects never collide.
 *   - Existing in-project `.bubbly/` is migrated OUT on first access, preserving
 *     its contents and leaving the project folder clean.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-pd-'));
  // Point the external store at a temp dir so tests never touch the real ~/.bubbly.
  process.env.BUBBLY_PROJECTS_ROOT = path.join(root, 'store');
  jest.resetModules();
});

afterEach(() => {
  delete process.env.BUBBLY_PROJECTS_ROOT;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Fresh module each time so the once-per-process migration guard resets. */
function load() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./projectData') as typeof import('./projectData');
}

describe('external, never-in-project location', () => {
  it('resolves a data dir OUTSIDE the workspace', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    const dir = getProjectDataDir(ws);
    expect(dir.startsWith(path.resolve(ws))).toBe(false);
    // And nothing was created inside the project.
    expect(fs.existsSync(path.join(ws, '.bubbly'))).toBe(false);
  });

  it('maps the same project to the same dir every time', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    expect(getProjectDataDir(ws)).toBe(getProjectDataDir(ws));
  });

  it('normalizes trailing separators and (on Windows) drive-letter case', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    const a = getProjectDataDir(ws);
    const b = getProjectDataDir(ws + path.sep);
    expect(a).toBe(b);
  });

  it('gives two different projects two different dirs', () => {
    const a = fs.mkdtempSync(path.join(root, 'a-'));
    const b = fs.mkdtempSync(path.join(root, 'b-'));
    const { getProjectDataDir } = load();
    expect(getProjectDataDir(a)).not.toBe(getProjectDataDir(b));
  });

  it('leaves the project empty enough for a clean-slate scaffold', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    getProjectDataDir(ws); // would previously have created ws/.bubbly
    // `npm create vite .` checks for a non-empty dir; only dotfiles it ignores.
    expect(fs.readdirSync(ws)).toHaveLength(0);
  });
});

describe('migration of legacy in-project state', () => {
  it('moves machine state OUT but leaves specs in the project', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    // Seed a legacy in-project layout.
    fs.mkdirSync(path.join(ws, '.bubbly', 'specs', 's1'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.bubbly', 'specs', 's1', 'requirements.md'), '# hi');
    fs.writeFileSync(path.join(ws, '.bubbly', 'browser-meta.json'), '{"enabled":true}');

    const { getProjectDataDir } = load();
    const dir = getProjectDataDir(ws);

    // Machine state moved out…
    expect(fs.existsSync(path.join(dir, 'browser-meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.bubbly', 'browser-meta.json'))).toBe(false);
    // …but the specs stayed put. Moving them would fight the specs module,
    // which exists to keep them in the repo where a human can read them.
    expect(fs.readFileSync(path.join(ws, '.bubbly', 'specs', 's1', 'requirements.md'), 'utf8')).toBe('# hi');
    expect(fs.existsSync(path.join(dir, 'specs'))).toBe(false);
  });

  it('removes .bubbly entirely when it held nothing but machine state', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    fs.mkdirSync(path.join(ws, '.bubbly'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.bubbly', 'browser-meta.json'), '{"enabled":true}');

    load().getProjectDataDir(ws);
    // A clean project folder is what lets `npm create vite .` run at all.
    expect(fs.existsSync(path.join(ws, '.bubbly'))).toBe(false);
  });

  it('does NOT clobber external state that already exists', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    // Establish external state first.
    const dir = getProjectDataDir(ws);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'external');

    // Now a stale legacy dir appears (e.g. an old checkout).
    fs.mkdirSync(path.join(ws, '.bubbly'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.bubbly', 'keep.txt'), 'legacy');

    jest.resetModules();
    const again = load().getProjectDataDir(ws);
    expect(again).toBe(dir);
    // External wins; legacy is left untouched rather than overwriting real state.
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('external');
  });

  it('is a no-op when there is nothing to migrate', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir } = load();
    expect(() => getProjectDataDir(ws)).not.toThrow();
    expect(fs.existsSync(path.join(ws, '.bubbly'))).toBe(false);
  });
});

describe('getProjectDataPath', () => {
  it('joins segments under the external data dir', () => {
    const ws = fs.mkdtempSync(path.join(root, 'ws-'));
    const { getProjectDataDir, getProjectDataPath } = load();
    const p = getProjectDataPath(ws, 'specs', 's1');
    expect(p).toBe(path.join(getProjectDataDir(ws), 'specs', 's1'));
  });
});
