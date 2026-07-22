import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateBrowserAction, BROWSER_READ_ONLY, inferServices, primaryService } from './browserControl';

/** Build a throwaway project tree from a { relPath: contents } map. */
function scaffold(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-svc-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}
const pkg = (o: unknown) => JSON.stringify(o);

describe('validateBrowserAction', () => {
  it('rejects unknown actions', () => {
    expect(validateBrowserAction('teleport', {}).ok).toBe(false);
  });

  it('requires a url for open/goto and normalizes bare hosts to https', () => {
    expect(validateBrowserAction('open', {}).ok).toBe(false);
    const r = validateBrowserAction('goto', { url: 'example.com' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.url).toBe('https://example.com');
  });

  it('rejects non-http(s) schemes (sandbox to the web)', () => {
    expect(validateBrowserAction('goto', { url: 'file:///etc/passwd' }).ok).toBe(false);
  });

  it('click needs a selector, text, or coordinates', () => {
    expect(validateBrowserAction('click', {}).ok).toBe(false);
    expect(validateBrowserAction('click', { selector: '#go' }).ok).toBe(true);
    expect(validateBrowserAction('click', { text: 'Sign in' }).ok).toBe(true);
    expect(validateBrowserAction('click', { x: 10, y: 20 }).ok).toBe(true);
  });

  it('type requires text and bounds length', () => {
    expect(validateBrowserAction('type', {}).ok).toBe(false);
    expect(validateBrowserAction('type', { text: 'hello' }).ok).toBe(true);
    expect(validateBrowserAction('type', { text: 'x'.repeat(5001) }).ok).toBe(false);
  });

  it('press requires a key; scroll requires a numeric amount', () => {
    expect(validateBrowserAction('press', {}).ok).toBe(false);
    expect(validateBrowserAction('press', { key: 'Enter' }).ok).toBe(true);
    expect(validateBrowserAction('scroll', {}).ok).toBe(false);
    const s = validateBrowserAction('scroll', { amount: 99999 });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.params.amount).toBe(10000);
  });

  it('screenshot/snapshot are read-only and need no params', () => {
    expect(validateBrowserAction('screenshot', {}).ok).toBe(true);
    expect(validateBrowserAction('snapshot', {}).ok).toBe(true);
    expect(BROWSER_READ_ONLY.has('screenshot')).toBe(true);
    expect(BROWSER_READ_ONLY.has('snapshot')).toBe(true);
  });
});

describe('inferServices', () => {
  const made: string[] = [];
  const make = (files: Record<string, string>) => { const r = scaffold(files); made.push(r); return r; };
  afterAll(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

  it('detects a single Vite app on port 5173', () => {
    const root = make({ 'package.json': pkg({ name: 'app', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }) });
    const svcs = inferServices(root);
    expect(svcs).toHaveLength(1);
    expect(svcs[0]).toMatchObject({ cwd: '', kind: 'frontend', port: 5173, start: 'npm run dev', url: 'http://localhost:5173' });
  });

  it('detects a Next.js app on port 3000', () => {
    const root = make({ 'package.json': pkg({ name: 'web', scripts: { dev: 'next dev' }, dependencies: { next: '^14' } }) });
    const svcs = inferServices(root);
    expect(svcs[0]).toMatchObject({ kind: 'frontend', port: 3000 });
  });

  it('uses the lockfile package manager', () => {
    const root = make({
      'package.json': pkg({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'pnpm-lock.yaml': '',
    });
    expect(inferServices(root)[0].start).toBe('pnpm dev');
  });

  it('finds BOTH frontend and backend services in a monorepo', () => {
    const root = make({
      'package.json': pkg({ name: 'mono', workspaces: ['apps/*'], scripts: { dev: 'turbo run dev' } }),
      'apps/web/package.json': pkg({ name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'apps/api/package.json': pkg({ name: 'api', scripts: { dev: 'node server.js' }, dependencies: { express: '^4' } }),
    });
    const svcs = inferServices(root);
    const web = svcs.find((s) => s.cwd === 'apps/web');
    const api = svcs.find((s) => s.cwd === 'apps/api');
    expect(web).toMatchObject({ kind: 'frontend', port: 5173 });
    expect(api).toMatchObject({ kind: 'backend' });
    // The turbo orchestrator root is dropped once the real services are found.
    expect(svcs.some((s) => s.cwd === '')).toBe(false);
    // The preview follows the frontend service.
    expect(primaryService(svcs)?.cwd).toBe('apps/web');
  });

  it('classifies an Express-only project as a backend', () => {
    const root = make({ 'package.json': pkg({ scripts: { start: 'node index.js' }, dependencies: { express: '^4' } }) });
    expect(inferServices(root)[0].kind).toBe('backend');
  });
});
