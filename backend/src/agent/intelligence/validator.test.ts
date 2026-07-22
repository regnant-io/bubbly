import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkBalancedDelimiters,
  validateFilesSyntax,
  runValidation,
  formatIssuesForRepair,
} from './validator';

describe('deterministic validator', () => {
  it('passes balanced TypeScript', () => {
    const issues = checkBalancedDelimiters('a.ts', `function f() { return [1, 2, 3]; }`);
    expect(issues).toHaveLength(0);
  });

  it('detects an unclosed brace', () => {
    const issues = checkBalancedDelimiters('a.ts', `function f() { return 1;`);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toMatch(/Unclosed/);
  });

  it('detects a mismatched closing bracket', () => {
    const issues = checkBalancedDelimiters('a.ts', `const x = [1, 2);`);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/Unbalanced/);
  });

  it('ignores brackets inside strings and comments', () => {
    const src = `const s = "a ) { not real"; // ] also fake\nconst t = 1;`;
    const issues = checkBalancedDelimiters('a.ts', src);
    expect(issues).toHaveLength(0);
  });

  it('detects an unterminated string', () => {
    const issues = checkBalancedDelimiters('a.ts', `const s = "open;`);
    expect(issues.some((i) => /Unterminated string/.test(i.message))).toBe(true);
  });

  it('validates files on disk and reports problems', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-val-'));
    try {
      const good = path.join(dir, 'good.ts');
      const bad = path.join(dir, 'bad.ts');
      fs.writeFileSync(good, `export const a = () => 1;`);
      fs.writeFileSync(bad, `export const b = () => {`);
      const issues = validateFilesSyntax(dir, ['good.ts', 'bad.ts']);
      expect(issues.some((i) => i.file === 'bad.ts')).toBe(true);
      expect(issues.some((i) => i.file === 'good.ts')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runValidation returns ok for syntactically valid changes (toolchain disabled)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-val2-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.ts'), `export function ok() { return true; }`);
      const report = await runValidation({
        workspacePath: dir,
        changedFiles: ['x.ts'],
        enableToolchain: false,
      });
      expect(report.ok).toBe(true);
      expect(report.checkedWith).toContain('syntax');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runValidation flags syntactically broken changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-val3-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.ts'), `export function broken() { return (1; }`);
      const report = await runValidation({
        workspacePath: dir,
        changedFiles: ['x.ts'],
        enableToolchain: false,
      });
      expect(report.ok).toBe(false);
      const brief = formatIssuesForRepair(report);
      expect(brief).toMatch(/x\.ts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
