/**
 * v3 run-config guarantees.
 *
 * These lock in the two behaviours that made the preview untrustworthy in v2:
 * navigating to a convention-guessed port, and being able to display Bubbly
 * itself. Both produced a page that LOOKED fine, which is what made them so
 * hard to notice.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import {
  registerSelfPort, isSelfOrigin, isNavigableSource, probeUrl,
  resolvePreviewTarget, SELF_HEADER,
} from './previewTarget';
import {
  ensureBrowserMeta, writeRunConfig, readRunConfig, setBrowserMetaPreviewUrl,
  getBrowserMetaPath, RUN_CONFIG_VERSION,
} from './browserControl';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-v3-'));
}

/** A throwaway HTTP server, optionally pretending to be Bubbly. */
function startServer(asBubbly: boolean): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      if (asBubbly) res.setHeader(SELF_HEADER, '1');
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      resolve({ port, close: () => srv.close() });
    });
  });
}

describe('self-origin guard', () => {
  it('recognises Bubbly\'s own registered port', () => {
    registerSelfPort(49517);
    expect(isSelfOrigin('http://localhost:49517')).toBe(true);
    expect(isSelfOrigin('http://127.0.0.1:49517/some/path')).toBe(true);
    expect(isSelfOrigin('http://localhost:5173')).toBe(false);
  });

  it('only applies to loopback — a remote host on the same port is not us', () => {
    registerSelfPort(49518);
    expect(isSelfOrigin('http://example.com:49518')).toBe(false);
  });

  it('detects Bubbly by response header even on an unknown port', async () => {
    const srv = await startServer(true);
    const probe = await probeUrl(`http://127.0.0.1:${srv.port}`);
    srv.close();
    expect(probe.alive).toBe(true);
    expect(probe.isSelf).toBe(true);
  });

  it('does not mistake an ordinary dev server for Bubbly', async () => {
    const srv = await startServer(false);
    const probe = await probeUrl(`http://127.0.0.1:${srv.port}`);
    srv.close();
    expect(probe.alive).toBe(true);
    expect(probe.isSelf).toBe(false);
  });

  it('reports a dead address as not alive rather than assuming it works', async () => {
    // Port 1 is reserved and nothing will be listening on it.
    const probe = await probeUrl('http://127.0.0.1:1', 800);
    expect(probe.alive).toBe(false);
  });
});

describe('url provenance', () => {
  it('never treats a convention guess as navigable', () => {
    expect(isNavigableSource('guess')).toBe(false);
    expect(isNavigableSource(undefined)).toBe(false);
    expect(isNavigableSource('detected')).toBe(true);
    expect(isNavigableSource('owned')).toBe(true);
    expect(isNavigableSource('configured')).toBe(true);
  });
});

describe('resolvePreviewTarget', () => {
  it('uses the URL the dev server printed, once it answers', async () => {
    const srv = await startServer(false);
    const url = `http://127.0.0.1:${srv.port}`;
    const t = await resolvePreviewTarget({ detectedUrl: url });
    srv.close();
    expect(t.url).toBe(url);
    expect(t.source).toBe('detected');
  });

  it('refuses a detected URL that turns out to be Bubbly, and explains why', async () => {
    const srv = await startServer(true);
    const url = `http://127.0.0.1:${srv.port}`;
    const t = await resolvePreviewTarget({ detectedUrl: url });
    srv.close();
    expect(t.url).toBeNull();
    expect(t.reason).toMatch(/Bubbly inside Bubbly/i);
  });

  it('returns nothing — not a guess — when the server has not reported yet', async () => {
    const t = await resolvePreviewTarget({ detectedUrl: null, pid: null, configuredUrl: null });
    expect(t.url).toBeNull();
    expect(t.source).toBeNull();
    expect(t.reason).toBeTruthy();
  });

  it('does not hand back a configured URL that nothing is serving', async () => {
    const t = await resolvePreviewTarget({ configuredUrl: 'http://127.0.0.1:1' });
    expect(t.url).toBeNull();
  });
});

describe('browser-meta v3', () => {
  it('stamps the schema version', () => {
    const ws = tmpWorkspace();
    const r = ensureBrowserMeta(ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.version).toBe(RUN_CONFIG_VERSION);
  });

  it('leaves previewUrl null for an empty project instead of guessing localhost:3000', () => {
    const ws = tmpWorkspace();
    const r = ensureBrowserMeta(ws);
    expect(r.ok).toBe(true);
    // v2 wrote http://localhost:3000 here, so Start opened whatever owned that
    // port on the user's machine and presented it as their project.
    if (r.ok) expect(r.meta.previewUrl).toBeNull();
  });

  it('marks inferred service URLs as guesses, so they are never opened', () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
      name: 'app', scripts: { dev: 'vite' }, dependencies: { vite: '^5' },
    }));
    const status = readRunConfig(ws);
    const svc = status.suggestion.find((s) => s.kind === 'frontend');
    expect(svc?.url).toBe('http://localhost:5173'); // still suggested…
    expect(svc?.urlSource).toBe('guess');           // …but not navigable
    const r = ensureBrowserMeta(ws);
    if (r.ok) expect(r.meta.previewUrl).toBeNull();
  });

  it('refuses to author a config that previews Bubbly itself', () => {
    registerSelfPort(49519);
    const ws = tmpWorkspace();
    const r = writeRunConfig(ws, {
      services: [{ name: 'web', cwd: '', start: 'npm run dev', kind: 'frontend', port: 49519 }],
      previewUrl: 'http://localhost:49519',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Bubbly's own address/i);
  });

  it('refuses to persist Bubbly\'s address as a detected preview URL', () => {
    registerSelfPort(49520);
    const ws = tmpWorkspace();
    ensureBrowserMeta(ws);
    setBrowserMetaPreviewUrl(ws, 'http://localhost:49520', 'detected');
    const saved = JSON.parse(fs.readFileSync(getBrowserMetaPath(ws), 'utf8'));
    expect(saved.previewUrl).not.toBe('http://localhost:49520');
  });

  it('does not persist a guess, only evidence', () => {
    const ws = tmpWorkspace();
    ensureBrowserMeta(ws);
    setBrowserMetaPreviewUrl(ws, 'http://localhost:5173', 'guess');
    const saved = JSON.parse(fs.readFileSync(getBrowserMetaPath(ws), 'utf8'));
    expect(saved.previewUrl).toBeNull();

    setBrowserMetaPreviewUrl(ws, 'http://localhost:5199', 'detected');
    const after = JSON.parse(fs.readFileSync(getBrowserMetaPath(ws), 'utf8'));
    expect(after.previewUrl).toBe('http://localhost:5199');
    expect(after.previewUrlSource).toBe('detected');
  });

  it('drops a v2 config whose saved previewUrl points at Bubbly', () => {
    registerSelfPort(49521);
    const ws = tmpWorkspace();
    const metaPath = getBrowserMetaPath(ws);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      workspacePath: ws, enabled: true, createdAt: new Date().toISOString(),
      previewUrl: 'http://localhost:49521', install: 'npm install', start: 'npm run dev',
      services: [{ name: 'web', cwd: '', install: 'npm install', start: 'npm run dev', port: 49521, url: 'http://localhost:49521', kind: 'frontend' }],
    }));
    const r = ensureBrowserMeta(ws);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.previewUrl).toBeNull();
      expect(r.meta.version).toBe(RUN_CONFIG_VERSION);
    }
  });

  it('preserves a hand-authored, legitimate previewUrl across the v3 upgrade', () => {
    const ws = tmpWorkspace();
    const metaPath = getBrowserMetaPath(ws);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      workspacePath: ws, enabled: true, createdAt: '2026-01-01T00:00:00.000Z',
      previewUrl: 'http://localhost:8123', install: 'npm install', start: 'npm run dev',
      services: [{ name: 'web', cwd: '', install: 'npm install', start: 'npm run dev', port: 8123, url: 'http://localhost:8123', kind: 'frontend' }],
    }));
    const r = ensureBrowserMeta(ws);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.previewUrl).toBe('http://localhost:8123');
      expect(r.meta.start).toBe('npm run dev');
      expect(r.meta.createdAt).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('still honours the per-project kill switch', () => {
    const ws = tmpWorkspace();
    const metaPath = getBrowserMetaPath(ws);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ workspacePath: ws, enabled: false, services: [] }));
    const r = ensureBrowserMeta(ws);
    expect(r.ok).toBe(false);
  });
});
