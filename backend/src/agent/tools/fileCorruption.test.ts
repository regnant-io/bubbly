import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeFile, editFile, readFile, appendFile } from './filesystem';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}));

describe('file corruption safeguards', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-corrupt-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  describe('line-ending preservation', () => {
    it('keeps CRLF when editing a CRLF file with LF new_str', async () => {
      const crlf = 'line1\r\nline2\r\nline3\r\n';
      fs.writeFileSync(path.join(ws, 'crlf.txt'), crlf, 'utf8');
      await editFile(ws, 'crlf.txt', 'line2', 'LINE2\nEXTRA');
      const out = fs.readFileSync(path.join(ws, 'crlf.txt'), 'utf8');
      // No bare LF should remain (all newlines are CRLF).
      expect(/(?<!\r)\n/.test(out)).toBe(false);
      expect(out).toContain('LINE2\r\nEXTRA');
    });

    it('keeps CRLF when overwriting a CRLF file via write_file', async () => {
      fs.writeFileSync(path.join(ws, 'c.txt'), 'a\r\nb\r\n', 'utf8');
      await writeFile(ws, 'c.txt', 'x\ny\nz\n');
      const out = fs.readFileSync(path.join(ws, 'c.txt'), 'utf8');
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });

    it('leaves LF files as LF', async () => {
      fs.writeFileSync(path.join(ws, 'lf.txt'), 'a\nb\n', 'utf8');
      await editFile(ws, 'lf.txt', 'b', 'B');
      const out = fs.readFileSync(path.join(ws, 'lf.txt'), 'utf8');
      expect(out.includes('\r\n')).toBe(false);
    });
  });

  describe('ambiguous fuzzy edit rejection', () => {
    it('refuses an ambiguous fuzzy match across near-identical blocks', async () => {
      // Two near-identical blocks; a slightly-wrong old_str must NOT silently
      // edit the wrong one.
      const file = [
        'function a() {',
        '  const value = compute(1);',
        '  return value;',
        '}',
        '',
        'function b() {',
        '  const value = compute(2);',
        '  return value;',
        '}',
      ].join('\n');
      fs.writeFileSync(path.join(ws, 'dup.ts'), file, 'utf8');
      // old_str matches both blocks closely (only the compute arg differs).
      await expect(
        editFile(ws, 'dup.ts', '  const value = compute(9);\n  return value;', '  return 0;')
      ).rejects.toThrow();
    });
  });

  describe('partial read marker is unmistakable', () => {
    it('marks large reads as partial and non-writable', async () => {
      const big = 'x'.repeat(600_000);
      fs.writeFileSync(path.join(ws, 'big.txt'), big, 'utf8');
      const out = await readFile(ws, 'big.txt');
      expect(out).toContain('PARTIAL FILE VIEW');
      expect(out).toContain('Do NOT write this content back');
    });
  });

  describe('append_file incremental building', () => {
    it('creates a file when appending to a non-existent path', async () => {
      const r = await appendFile(ws, 'new.py', 'import os\n');
      expect(r.success).toBe(true);
      expect(fs.readFileSync(path.join(ws, 'new.py'), 'utf8')).toBe('import os\n');
    });

    it('appends to existing content with exactly one separating newline', async () => {
      fs.writeFileSync(path.join(ws, 'a.py'), 'line1', 'utf8'); // no trailing newline
      await appendFile(ws, 'a.py', 'line2\n');
      expect(fs.readFileSync(path.join(ws, 'a.py'), 'utf8')).toBe('line1\nline2\n');
    });

    it('builds a large file in chunks without truncation', async () => {
      await writeFile(ws, 'big.py', '# header\n');
      for (let i = 0; i < 50; i++) {
        await appendFile(ws, 'big.py', `def fn_${i}():\n    return ${i}\n`);
      }
      const out = fs.readFileSync(path.join(ws, 'big.py'), 'utf8');
      expect(out).toContain('# header');
      expect(out).toContain('def fn_0');
      expect(out).toContain('def fn_49');
      expect((out.match(/def fn_/g) || []).length).toBe(50);
    });

    it('preserves CRLF when appending to a CRLF file', async () => {
      fs.writeFileSync(path.join(ws, 'c.py'), 'a\r\n', 'utf8');
      await appendFile(ws, 'c.py', 'b\nc\n');
      const out = fs.readFileSync(path.join(ws, 'c.py'), 'utf8');
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });
  });
});
