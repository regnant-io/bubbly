import path from 'path';
import os from 'os';
import { resolveSafePath } from './filesystem';

describe('resolveSafePath', () => {
  const root = path.resolve(os.tmpdir(), 'bubbly-ws-root');

  it('resolves a normal relative path inside the workspace', () => {
    const r = resolveSafePath(root, 'src/index.ts');
    expect(r).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('allows the workspace root itself (".")', () => {
    expect(resolveSafePath(root, '.')).toBe(root);
  });

  it('blocks parent-directory traversal', () => {
    expect(() => resolveSafePath(root, '../secrets.txt')).toThrow(/Path escape/);
    expect(() => resolveSafePath(root, '../../etc/passwd')).toThrow(/Path escape/);
    expect(() => resolveSafePath(root, 'a/b/../../../escape')).toThrow(/Path escape/);
  });

  it('blocks the sibling-prefix bypass (the bug this replaced)', () => {
    // "<root>-evil" string-starts-with "<root>" but is OUTSIDE the workspace.
    const sibling = path.resolve(root + '-evil', 'file.txt');
    const relFromRoot = path.relative(root, sibling);
    expect(() => resolveSafePath(root, relFromRoot)).toThrow(/Path escape/);
  });

  it('blocks an absolute path outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\system32\\x' : '/etc/passwd';
    expect(() => resolveSafePath(root, outside)).toThrow(/Path escape/);
  });

  it('rejects non-string input instead of crashing deep in fs', () => {
    // @ts-expect-error testing runtime guard
    expect(() => resolveSafePath(root, undefined)).toThrow(/Invalid path/);
    // @ts-expect-error testing runtime guard
    expect(() => resolveSafePath(root, null)).toThrow(/Invalid path/);
  });
});
