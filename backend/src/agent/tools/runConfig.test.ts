/**
 * Run-config (browser-meta.json) lifecycle.
 *
 * The contract these lock down:
 *   - Absence is a REPORTED state, never silently auto-authored.
 *   - An existing config is authoritative: reading it never rewrites it, and
 *     hand-edited commands survive.
 *   - A v1 (flat install/start) file still works — migrated in memory.
 *   - Drift (missing dir, new service, no start) is reported, not guessed away.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readRunConfig, writeRunConfig, getBrowserMetaPath } from './browserControl';

jest.mock('../../db/index', () => ({ getSetting: () => 'false' }));

let root: string;

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-runconfig-'));
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

beforeEach(() => { root = makeWorkspace(); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('readRunConfig — no config yet', () => {
  it('reports absence WITHOUT creating the file', () => {
    const status = readRunConfig(root);
    expect(status.exists).toBe(false);
    expect(status.meta).toBeNull();
    // The whole point of the gate: reading must not author anything.
    expect(fs.existsSync(getBrowserMetaPath(root))).toBe(false);
  });

  it('still offers a detection suggestion to author from', () => {
    writeJson(path.join(root, 'package.json'), {
      name: 'app', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' },
    });
    const status = readRunConfig(root);
    expect(status.exists).toBe(false);
    expect(status.suggestion.length).toBeGreaterThan(0);
    expect(status.suggestion[0].start).toContain('dev');
  });
});

describe('readRunConfig — config already available', () => {
  it('uses it as-is and does not rewrite the file', () => {
    const metaPath = getBrowserMetaPath(root);
    const authored = {
      workspacePath: root,
      enabled: true,
      createdAt: '2020-01-01T00:00:00.000Z',
      previewUrl: 'http://localhost:4321',
      install: null,
      start: 'pnpm start:custom',
      services: [{ name: 'web', cwd: '', install: null, start: 'pnpm start:custom', port: 4321, url: 'http://localhost:4321', kind: 'frontend' }],
    };
    writeJson(metaPath, authored);
    const before = fs.readFileSync(metaPath, 'utf8');

    const status = readRunConfig(root);
    expect(status.exists).toBe(true);
    expect(status.meta?.services[0].start).toBe('pnpm start:custom');
    expect(status.meta?.createdAt).toBe('2020-01-01T00:00:00.000Z');
    // Hand-edited config must survive a read byte-for-byte.
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(before);
  });

  it('honours the per-project kill switch', () => {
    writeJson(getBrowserMetaPath(root), {
      enabled: false,
      services: [{ name: 'web', cwd: '', install: null, start: 'npm run dev', port: 5173, url: 'http://localhost:5173', kind: 'frontend' }],
    });
    expect(readRunConfig(root).enabled).toBe(false);
  });

  it('migrates a v1 (flat install/start) file in memory, preserving its commands', () => {
    writeJson(getBrowserMetaPath(root), {
      workspacePath: root,
      enabled: true,
      createdAt: '2021-05-05T00:00:00.000Z',
      previewUrl: 'http://localhost:8080',
      install: 'yarn',
      start: 'yarn serve',
    });
    const status = readRunConfig(root);
    expect(status.migrated).toBe(true);
    expect(status.meta?.services).toHaveLength(1);
    expect(status.meta?.services[0].start).toBe('yarn serve');
    expect(status.meta?.services[0].install).toBe('yarn');
    expect(status.meta?.previewUrl).toBe('http://localhost:8080');
  });

  it('reports a corrupt file as an error instead of throwing', () => {
    const metaPath = getBrowserMetaPath(root);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ not json');
    const status = readRunConfig(root);
    expect(status.exists).toBe(true);
    expect(status.issues.some((i) => i.level === 'error')).toBe(true);
  });
});

describe('drift detection on an existing config', () => {
  it('flags a service whose directory is gone', () => {
    writeJson(getBrowserMetaPath(root), {
      enabled: true,
      services: [{ name: 'web', cwd: 'frontend', install: null, start: 'npm run dev', port: 5173, url: 'http://localhost:5173', kind: 'frontend' }],
    });
    const status = readRunConfig(root);
    expect(status.issues.some((i) => i.level === 'error' && /no longer exists/.test(i.message))).toBe(true);
  });

  it('warns about a detected service the config never mentions', () => {
    fs.mkdirSync(path.join(root, 'api'), { recursive: true });
    writeJson(path.join(root, 'package.json'), { name: 'root', workspaces: ['api'] });
    writeJson(path.join(root, 'api', 'package.json'), {
      name: 'api', scripts: { dev: 'node server.js' }, dependencies: { express: '^4.0.0' },
    });
    writeJson(getBrowserMetaPath(root), {
      enabled: true,
      services: [{ name: 'root', cwd: '', install: null, start: 'npm run dev', port: 5173, url: 'http://localhost:5173', kind: 'frontend' }],
    });
    const status = readRunConfig(root);
    expect(status.issues.some((i) => i.level === 'warn' && /unconfigured service at "api"/.test(i.message))).toBe(true);
  });

  it('errors when no service can actually be started', () => {
    writeJson(getBrowserMetaPath(root), {
      enabled: true,
      services: [{ name: 'web', cwd: '', install: 'npm i', start: null, port: null, url: null, kind: 'frontend' }],
    });
    expect(readRunConfig(root).issues.some((i) => i.level === 'error' && /nothing can be run/.test(i.message))).toBe(true);
  });

  it('warns when nothing is marked frontend (no page to preview)', () => {
    writeJson(getBrowserMetaPath(root), {
      enabled: true,
      services: [{ name: 'api', cwd: '', install: null, start: 'node server.js', port: 3001, url: null, kind: 'backend' }],
    });
    expect(readRunConfig(root).issues.some((i) => i.level === 'warn' && /kind:"frontend"/.test(i.message))).toBe(true);
  });
});

describe('writeRunConfig — the agent authoring path', () => {
  it('saves a multi-service config and unblocks preview', () => {
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.mkdirSync(path.join(root, 'api'), { recursive: true });
    const r = writeRunConfig(root, {
      services: [
        { name: 'web', cwd: 'web', install: 'npm i', start: 'npm run dev', port: 5173, kind: 'frontend' },
        { name: 'api', cwd: 'api', install: 'npm i', start: 'npm start', port: 3001, kind: 'backend' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.exists).toBe(true);
    expect(r.status.meta?.services).toHaveLength(2);
    // A frontend port becomes the preview URL without the agent spelling it out.
    expect(r.status.meta?.previewUrl).toBe('http://localhost:5173');
    expect(r.status.issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('rejects a service pointing at a directory that does not exist', () => {
    const r = writeRunConfig(root, {
      services: [{ name: 'web', cwd: 'nope', start: 'npm run dev', kind: 'frontend' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/do not exist/);
  });

  it('rejects a config where nothing can start', () => {
    const r = writeRunConfig(root, { services: [{ name: 'web', cwd: '', kind: 'frontend' }] });
    expect(r.ok).toBe(false);
  });

  it('rejects an empty service list', () => {
    const r = writeRunConfig(root, { services: [] });
    expect(r.ok).toBe(false);
  });

  it('preserves createdAt and the user kill switch when re-authoring', () => {
    writeJson(getBrowserMetaPath(root), {
      enabled: false,
      createdAt: '2019-09-09T00:00:00.000Z',
      services: [{ name: 'old', cwd: '', install: null, start: 'old cmd', port: null, url: null, kind: 'frontend' }],
    });
    const r = writeRunConfig(root, {
      services: [{ name: 'web', cwd: '', start: 'npm run dev', port: 5173, kind: 'frontend' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Re-authoring is an edit, not a reset: it must not silently re-enable a
    // project the user turned off, nor lose when it was first configured.
    expect(r.status.meta?.enabled).toBe(false);
    expect(r.status.meta?.createdAt).toBe('2019-09-09T00:00:00.000Z');
  });

  it('normalizes messy cwd values from the model', () => {
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    const r = writeRunConfig(root, {
      services: [{ name: 'web', cwd: './web', start: 'npm run dev', port: 5173, kind: 'frontend' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.meta?.services[0].cwd).toBe('web');
  });

  it('strips ANSI junk from a supplied preview URL', () => {
    const r = writeRunConfig(root, {
      services: [{ name: 'web', cwd: '', start: 'npm run dev', port: 5173, kind: 'frontend' }],
      previewUrl: 'http://localhost:\x1b[1m4200\x1b[22m/',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.meta?.previewUrl).toBe('http://localhost:4200/');
  });
});
