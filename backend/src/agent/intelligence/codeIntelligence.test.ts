import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildIndex,
  getIndex,
  invalidateIndex,
  findSymbol,
  findReferences,
  searchSymbols,
  getFileOutline,
  buildRepoMap,
  buildTaskContext,
} from './codeIntelligence';

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-ci-'));
  // A tiny multi-file TS project with import edges.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'db.ts'),
    `export function connect() { return true; }\nexport class Database { query(sql: string) { return sql; } }\n`
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'auth.ts'),
    `import { Database, connect } from './db';\nexport function login(user: string) { connect(); return user; }\nexport class AuthService { check() { return new Database(); } }\n`
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    `import { login } from './auth';\nlogin('alice');\n`
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', dependencies: {} }));
  return dir;
}

describe('code intelligence engine', () => {
  let ws: string;

  beforeAll(() => {
    ws = makeTempWorkspace();
    invalidateIndex(ws);
    buildIndex(ws);
  });

  afterAll(() => {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('indexes all code files', () => {
    const idx = getIndex(ws);
    expect(idx.fileCount).toBe(3);
    expect(idx.files.has('src/db.ts')).toBe(true);
    expect(idx.files.has('src/auth.ts')).toBe(true);
  });

  it('resolves local import edges', () => {
    const idx = getIndex(ws);
    const auth = idx.files.get('src/auth.ts')!;
    expect(auth.resolvedDeps).toContain('src/db.ts');
    const index = idx.files.get('src/index.ts')!;
    expect(index.resolvedDeps).toContain('src/auth.ts');
  });

  it('ranks central files (db.ts) above leaf files (index.ts)', () => {
    const idx = getIndex(ws);
    const db = idx.files.get('src/db.ts')!;
    const index = idx.files.get('src/index.ts')!;
    // db is imported by auth which is imported by index → highest centrality.
    expect(db.rank).toBeGreaterThan(index.rank);
  });

  it('finds symbol declarations by name', () => {
    const hits = findSymbol(ws, 'login');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].path).toBe('src/auth.ts');
    expect(hits[0].kind).toBe('function');
  });

  it('fuzzy-searches symbols', () => {
    const hits = searchSymbols(ws, 'auth');
    expect(hits.some((h) => h.name === 'AuthService')).toBe(true);
  });

  it('finds references excluding the declaration', () => {
    const refs = findReferences(ws, 'login');
    // login is referenced in index.ts (call) but declaration line excluded.
    expect(refs.some((r) => r.path === 'src/index.ts')).toBe(true);
    expect(refs.every((r) => !(r.path === 'src/auth.ts' && r.line === 2))).toBe(true);
  });

  it('returns a file outline', () => {
    const outline = getFileOutline(ws, 'src/db.ts');
    expect(outline).not.toBeNull();
    expect(outline!.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(['connect', 'Database'])
    );
  });

  it('builds a repo map containing key files and signatures', () => {
    const map = buildRepoMap(ws, { focus: 'auth login' });
    expect(map).toContain('# Repository Map');
    expect(map).toContain('src/auth.ts');
    expect(map).toContain('login');
  });

  it('builds focused task context', () => {
    const ctx = buildTaskContext(ws, 'fix the login flow in auth');
    expect(ctx.repoMap).toContain('Repository Map');
    expect(ctx.focusFiles.length).toBeGreaterThan(0);
    // auth.ts should be among the focus files for an auth/login task.
    expect(ctx.focusFiles.some((f) => f.path === 'src/auth.ts')).toBe(true);
  });

  it('refreshes after invalidation when files change', () => {
    fs.writeFileSync(
      path.join(ws, 'src', 'newmod.ts'),
      `export function brandNewFunction() { return 42; }\n`
    );
    invalidateIndex(ws);
    buildIndex(ws);
    const hits = findSymbol(ws, 'brandNewFunction');
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('src/newmod.ts');
  });
});
