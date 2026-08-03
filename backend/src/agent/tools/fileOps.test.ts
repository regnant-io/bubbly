/**
 * Explorer file operations.
 *
 * These run without a review step — there is no diff to approve and no
 * checkpoint to revert — so the invariants here are the only thing between a
 * misclick and lost work. Two matter most: nothing can address a path outside
 * the workspace, and delete never means "destroy".
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEntry, renameEntry, duplicateEntry, trashEntry, revealEntry } from './fileOps';

jest.mock('../../db/index', () => ({ getSetting: () => 'false' }));

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-fileops-'));
  fs.mkdirSync(path.join(ws, 'src'));
  fs.writeFileSync(path.join(ws, 'src', 'index.ts'), 'export const a = 1;\n');
});

afterEach(() => {
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('create', () => {
  it('creates a file in a subfolder and reports its relative path', () => {
    const r = createEntry(ws, 'src', 'util.ts', 'file');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('src/util.ts');
    expect(fs.existsSync(path.join(ws, 'src', 'util.ts'))).toBe(true);
  });

  it('creates a folder at the workspace root', () => {
    expect(createEntry(ws, '', 'lib', 'directory').ok).toBe(true);
    expect(fs.statSync(path.join(ws, 'lib')).isDirectory()).toBe(true);
  });

  it('refuses to clobber something already there', () => {
    const r = createEntry(ws, 'src', 'index.ts', 'file');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/i);
    // And the original is untouched.
    expect(fs.readFileSync(path.join(ws, 'src', 'index.ts'), 'utf8')).toContain('export const a');
  });

  it.each([
    ['../escape.ts', /path separator/i],
    ['sub/dir.ts', /path separator/i],
    ['..', /not a usable name/i],
    ['bad:name.ts', /cannot contain/i],
    ['con.txt', /reserved device name/i],
    ['   ', /name is required/i],
  ])('rejects the name %p', (name, expected) => {
    const r = createEntry(ws, '', name, 'file');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(expected);
  });

  it('rejects a parent that climbs out of the workspace', () => {
    const r = createEntry(ws, '../..', 'evil.ts', 'file');
    expect(r.ok).toBe(false);
  });
});

describe('rename', () => {
  it('renames a file in place', () => {
    const r = renameEntry(ws, 'src/index.ts', 'main.ts');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('src/main.ts');
    expect(fs.existsSync(path.join(ws, 'src', 'main.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'src', 'index.ts'))).toBe(false);
  });

  it('handles a case-only rename, which is the same file on Windows and macOS', () => {
    fs.writeFileSync(path.join(ws, 'readme.md'), 'hi');
    const r = renameEntry(ws, 'readme.md', 'README.md');
    expect(r.ok).toBe(true);
    // The content survived the temp-name round trip.
    const names = fs.readdirSync(ws);
    expect(names).toContain('README.md');
    expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe('hi');
  });

  it('refuses to rename over an existing file', () => {
    fs.writeFileSync(path.join(ws, 'src', 'other.ts'), 'x');
    const r = renameEntry(ws, 'src/index.ts', 'other.ts');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(ws, 'src', 'other.ts'), 'utf8')).toBe('x');
  });

  it('cannot be used to move a file out of the workspace', () => {
    const r = renameEntry(ws, 'src/index.ts', '../../escaped.ts');
    expect(r.ok).toBe(false);
  });
});

describe('duplicate', () => {
  it('never overwrites — it finds the next free copy name', () => {
    const a = duplicateEntry(ws, 'src/index.ts');
    expect(a.ok).toBe(true);
    expect(a.path).toBe('src/index copy.ts');
    const b = duplicateEntry(ws, 'src/index.ts');
    expect(b.path).toBe('src/index copy 2.ts');
    expect(fs.readFileSync(path.join(ws, 'src', 'index copy 2.ts'), 'utf8')).toContain('export const a');
  });

  it('copies a folder and everything in it', () => {
    const r = duplicateEntry(ws, 'src');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(ws, 'src copy', 'index.ts'))).toBe(true);
  });

  it('reports a missing source rather than creating an empty copy', () => {
    const r = duplicateEntry(ws, 'src/nope.ts');
    expect(r.ok).toBe(false);
  });
});

describe('trash', () => {
  it('refuses to delete the workspace root', async () => {
    const r = await trashEntry(ws, '.');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/workspace root/i);
    expect(fs.existsSync(ws)).toBe(true);
  });

  it('refuses a path outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-outside-'));
    try {
      const r = await trashEntry(ws, path.relative(ws, outside).replace(/\\/g, '/'));
      expect(r.ok).toBe(false);
      // The point of the check: the directory is still there.
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a missing target instead of silently succeeding', async () => {
    const r = await trashEntry(ws, 'src/never-existed.ts');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer exists/i);
  });
});

describe('reveal', () => {
  it('refuses a path outside the workspace', async () => {
    const r = await revealEntry(ws, '../../..');
    expect(r.ok).toBe(false);
  });

  it('reports a missing target', async () => {
    const r = await revealEntry(ws, 'src/nope.ts');
    expect(r.ok).toBe(false);
  });
});
