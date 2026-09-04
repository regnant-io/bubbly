import { checkBalancedDelimiters } from './validator';

describe('checkBalancedDelimiters — regex literal handling', () => {
  it('does not flag a regex literal containing brackets/braces', () => {
    const code = 'const re = /[{(]/g;\nconst ok = true;\n';
    expect(checkBalancedDelimiters('a.ts', code)).toEqual([]);
  });

  it('does not flag a character class with an unmatched-looking bracket', () => {
    const code = 'function f() {\n  return "x".replace(/[\\])}]/g, "");\n}\n';
    expect(checkBalancedDelimiters('a.ts', code)).toEqual([]);
  });

  it('treats division as division (not regex) without false positives', () => {
    const code = 'const x = (a + b) / (c - d);\nconst y = e / f / g;\n';
    expect(checkBalancedDelimiters('a.ts', code)).toEqual([]);
  });

  it('still catches a genuinely unbalanced brace', () => {
    const code = 'function f() {\n  if (x) {\n    doThing();\n}\n'; // missing one closing brace
    const issues = checkBalancedDelimiters('a.ts', code);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].source).toBe('syntax');
  });

  it('handles regex after return / assignment / comma positions', () => {
    const code = 'const m = [/[a]/, /(b)/];\nfunction g() { return /{c}/.test("x"); }\n';
    expect(checkBalancedDelimiters('a.ts', code)).toEqual([]);
  });

  it('ignores braces inside strings and template literals', () => {
    const code = 'const s = "a {b} c";\nconst t = `x ${y} z`;\nconst u = 1;\n';
    expect(checkBalancedDelimiters('a.ts', code)).toEqual([]);
  });
});
