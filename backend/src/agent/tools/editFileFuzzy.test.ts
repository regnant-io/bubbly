import fs from 'fs';
import os from 'os';
import path from 'path';
import { editFile } from './filesystem';

function tmp(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-fuzzy-'));
  fs.writeFileSync(path.join(dir, 'f.ts'), content);
  return { dir, rel: 'f.ts' };
}

describe('editFile fuzzy + hallucination guard', () => {
  it('applies a high-confidence fuzzy match when one line differs slightly', async () => {
    const file = `function add(a, b) {\n  // adds two numbers\n  return a + b;\n}\n`;
    const { dir, rel } = tmp(file);
    // old_str matches the block but the comment text is slightly off.
    await editFile(dir, rel, 'function add(a, b) {\n  // sum two numbers\n  return a + b;\n}', 'function add(a, b) {\n  return a + b + 1;\n}');
    const out = fs.readFileSync(path.join(dir, rel), 'utf8');
    expect(out).toContain('a + b + 1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to edit when old_str is hallucinated (not in the file at all)', async () => {
    const { dir, rel } = tmp(`export const x = 1;\nexport const y = 2;\n`);
    await expect(
      editFile(dir, rel, 'const handleOpenModal = () => {}; // placeholder', 'const handleOpenModal = () => { open(); };')
    ).rejects.toThrow(/Could not find the text|does not appear|read the file/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
