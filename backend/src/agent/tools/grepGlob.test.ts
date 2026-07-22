import fs from 'fs';
import os from 'os';
import path from 'path';
import { regexSearchInFiles } from './filesystem';

describe('regexSearchInFiles glob matching', () => {
  let ws: string;
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-grep-'));
    fs.writeFileSync(path.join(ws, 'root.ts'), 'const FINDME = 1;\n');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'const FINDME = 2;\n');
    fs.mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'deep', 'x.ts'), 'const FINDME = 3;\n');
    fs.writeFileSync(path.join(ws, 'notes.md'), 'FINDME in markdown\n');
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  const files = (glob?: string) => {
    const r = regexSearchInFiles(ws, 'FINDME', { includeGlob: glob });
    return r.matches.map((m) => m.file).sort();
  };

  it('** /*.ts matches top-level AND nested ts files (the bug that was fixed)', () => {
    expect(files('**/*.ts')).toEqual(['root.ts', 'src/app.ts', 'src/deep/x.ts']);
  });

  it('*.ts matches only top-level ts files', () => {
    expect(files('*.ts')).toEqual(['root.ts']);
  });

  it('src/**/*.ts matches everything under src', () => {
    expect(files('src/**/*.ts')).toEqual(['src/app.ts', 'src/deep/x.ts']);
  });

  it('*.md matches only markdown', () => {
    expect(files('*.md')).toEqual(['notes.md']);
  });

  it('no glob searches everything', () => {
    expect(files().length).toBe(4);
  });

  it('respects an excludeGlob', () => {
    const r = regexSearchInFiles(ws, 'FINDME', { includeGlob: '**/*.ts', excludeGlob: 'src/**' });
    expect(r.matches.map((m) => m.file)).toEqual(['root.ts']);
  });
});
