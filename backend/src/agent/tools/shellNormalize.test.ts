import { normalizeForWindows } from './shell';

describe('normalizeForWindows', () => {
  const isWin = process.platform === 'win32';

  it('converts && chains to ; on Windows (no-op elsewhere)', () => {
    const out = normalizeForWindows('npm install && npm run build');
    if (isWin) {
      expect(out).toBe('npm install; npm run build');
      expect(out).not.toContain('&&');
    } else {
      expect(out).toBe('npm install && npm run build');
    }
  });

  it('leaves a simple command unchanged', () => {
    expect(normalizeForWindows('npm test')).toBe('npm test');
  });

  it('does not rewrite operators inside quotes', () => {
    const cmd = `echo "a && b"`;
    // Has quotes → we skip rewriting to avoid corrupting string literals.
    expect(normalizeForWindows(cmd)).toBe(cmd);
  });
});
