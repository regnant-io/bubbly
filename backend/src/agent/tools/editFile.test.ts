import fs from 'fs';
import os from 'os';
import path from 'path';
import { editFile } from './filesystem';

function tmpFile(content: string): { dir: string; rel: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-edit-'));
  fs.writeFileSync(path.join(dir, 'f.ts'), content);
  return { dir, rel: 'f.ts' };
}

describe('forgiving editFile', () => {
  it('applies an exact unique edit', async () => {
    const { dir, rel } = tmpFile(`const a = 1;\nconst b = 2;\n`);
    await editFile(dir, rel, 'const b = 2;', 'const b = 3;');
    expect(fs.readFileSync(path.join(dir, rel), 'utf8')).toContain('const b = 3;');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches despite different inner whitespace', async () => {
    const { dir, rel } = tmpFile(`function f() {\n    return   1 +  2;\n}\n`);
    // old_str uses single spaces; file has irregular spacing.
    await editFile(dir, rel, 'return 1 + 2;', 'return 42;');
    const out = fs.readFileSync(path.join(dir, rel), 'utf8');
    expect(out).toContain('return 42;');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches despite different indentation (line-trimmed)', async () => {
    const { dir, rel } = tmpFile(`class C {\n        method() {\n            doThing();\n        }\n}\n`);
    // old_str has no indentation at all.
    await editFile(dir, rel, 'method() {\ndoThing();\n}', 'method() {\ndoOther();\n}');
    const out = fs.readFileSync(path.join(dir, rel), 'utf8');
    expect(out).toContain('doOther();');
    expect(out).not.toContain('doThing();');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an ambiguous match with a helpful error', async () => {
    const { dir, rel } = tmpFile(`x();\nx();\n`);
    await expect(editFile(dir, rel, 'x();', 'y();')).rejects.toThrow(/appears 2 times|matches/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives a closest-region hint when nothing matches', async () => {
    const { dir, rel } = tmpFile(`const greeting = "hello world";\n`);
    await expect(editFile(dir, rel, 'const greeting = "goodbye";', 'x')).rejects.toThrow(/Closest region|Could not find/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves surrounding content', async () => {
    const { dir, rel } = tmpFile(`line1\nTARGET\nline3\n`);
    await editFile(dir, rel, 'TARGET', 'REPLACED');
    const out = fs.readFileSync(path.join(dir, rel), 'utf8');
    expect(out).toBe(`line1\nREPLACED\nline3\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
