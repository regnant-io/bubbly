import { Router } from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { readFile, writeFile, getFileTree } from '../agent/tools/filesystem';
import { getAllSettings } from '../db/index';
import { logger } from '../utils/logger';
import { ensureBrowserMeta, getBrowserMetaPath, setBrowserMetaPreviewUrl, primaryService } from '../agent/tools/browserControl';
import { backgroundProcesses } from '../agent/tools/backgroundProcess';
import { resolvePreviewTarget, isNavigableSource } from '../agent/tools/previewTarget';

export const filesRouter = Router();

/**
 * GET /api/files/browser-meta?workspacePath=...
 * Detect + create (if missing) the project's browser-meta.json lock file, so
 * the Bubbly Preview panel can show a Start button (meta present) and the agent's
 * browser_control/computer_control tools have the same gate to check before running.
 */
filesRouter.get('/browser-meta', (req, res) => {
  const workspacePath = String(req.query.workspacePath || '');
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  const r = ensureBrowserMeta(workspacePath);
  if (!r.ok) return res.status(200).json({ enabled: false, error: r.error });
  // "running" if ANY service (or a bare root process) is up.
  const anyRunning = r.meta.services.some((s) => backgroundProcesses.findRunningByCwd(path.join(workspacePath, s.cwd)))
    || !!backgroundProcesses.findRunningByCwd(workspacePath);
  res.json({
    enabled: r.meta.enabled,
    created: r.created,
    previewUrl: r.meta.previewUrl,
    install: r.meta.install,
    start: r.meta.start,
    services: r.meta.services,
    path: getBrowserMetaPath(workspacePath),
    running: anyRunning,
  });
});

/**
 * POST /api/files/preview/start  { workspacePath }
 * Launch the project's dev server (browser-meta.json `start`) as a background
 * process, if one isn't already running. Returns immediately with the process
 * id; the caller polls /preview/status for the detected URL.
 */
filesRouter.post('/preview/start', async (req, res) => {
  const workspacePath = String(req.body?.workspacePath || '');
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  const meta = ensureBrowserMeta(workspacePath);
  if (!meta.ok) return res.status(200).json({ ok: false, error: meta.error });

  const runnable = meta.meta.services.filter((s) => s.start);
  if (runnable.length === 0) {
    return res.status(200).json({ ok: false, error: 'No runnable services in browser-meta.json. Add a "start" command (e.g. "npm run dev") to a service to run it.' });
  }

  // The primary (frontend) service owns the preview URL; only its detected URL
  // is persisted back as the preview address.
  const primary = primaryService(meta.meta.services);
  const started: Array<{ name: string; kind: string; processId?: string; reused?: boolean; error?: string }> = [];
  let primaryProc: string | null = null;
  let primaryUrl: string | null = null;
  let primaryCmd: string | null = null;
  let previewNote: string | null = null;

  for (const s of runnable) {
    const cwd = path.join(workspacePath, s.cwd);
    const isPrimary = primary != null && s.cwd === primary.cwd && s.start === primary.start;
    const r = backgroundProcesses.start(
      s.start!,
      cwd,
      // 'detected' — the server printed this address itself, which is the
      // strongest evidence we can get.
      isPrimary ? (url) => setBrowserMetaPreviewUrl(workspacePath, url, 'detected') : undefined,
    );
    if (r.error) { started.push({ name: s.name, kind: s.kind, error: r.error }); continue; }
    started.push({ name: s.name, kind: s.kind, processId: r.id, reused: r.reused });
    if (isPrimary) {
      primaryProc = r.id;
      primaryCmd = s.start!;
    }
  }

  // v3: resolve the address instead of asserting one. A freshly-started server
  // usually has nothing yet — that returns url:null and the caller keeps
  // polling /preview/status. What it must NEVER do is hand back the service's
  // convention port (s.url), because that is a guess about someone else's
  // machine and was how an unrelated app — including Bubbly itself — ended up
  // being displayed as the user's project.
  if (primaryProc) {
    const info = backgroundProcesses.getInfo(primaryProc);
    const target = await resolvePreviewTarget({
      detectedUrl: info?.detectedUrl ?? null,
      pid: backgroundProcesses.getPid(primaryProc),
      configuredUrl: isNavigableSource(meta.meta.previewUrlSource) ? meta.meta.previewUrl : null,
    });
    primaryUrl = target.url;
    if (target.url && target.source && target.source !== 'configured') {
      setBrowserMetaPreviewUrl(workspacePath, target.url, target.source);
    }
    if (!target.url) previewNote = target.reason ?? null;
  }

  res.json({
    ok: true,
    processId: primaryProc,
    command: primaryCmd,
    url: primaryUrl,
    note: previewNote,
    services: started,
  });
});

/**
 * GET /api/files/preview/status?workspacePath=...
 * Poll the running dev server: whether it's alive and its detected URL.
 */
filesRouter.get('/preview/status', async (req, res) => {
  const workspacePath = String(req.query.workspacePath || '');
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  const meta = ensureBrowserMeta(workspacePath);
  const services = meta.ok ? meta.meta.services : [];

  // Per-service running state (keyed by each service's own cwd).
  // NOTE: `s.url` is deliberately NOT used as a fallback here. It is a
  // convention guess, and reporting it as this service's live address is what
  // made the preview open whatever unrelated app owned that port.
  const perService = services.map((s) => {
    const running = backgroundProcesses.findRunningByCwd(path.join(workspacePath, s.cwd));
    return {
      name: s.name,
      kind: s.kind,
      running: !!running,
      processId: running?.id ?? null,
      url: running?.detectedUrl ?? null,
    };
  });

  // Legacy top-level fields track the primary (frontend) service, falling back
  // to any running service (covers a bare workspace with no meta services).
  const primary = perService.find((p) => p.kind === 'frontend' && p.running) ?? perService.find((p) => p.running);
  const bare = !primary ? backgroundProcesses.findRunningByCwd(workspacePath) : null;
  const processId = primary?.processId ?? bare?.id ?? null;

  // Resolve — and verify — before handing an address to the browser. This is
  // the poll the preview panel sits on while a dev server boots, so it is the
  // right place to wait for real evidence rather than to guess.
  let url: string | null = null;
  let note: string | null = null;
  if (processId) {
    const target = await resolvePreviewTarget({
      detectedUrl: primary?.url ?? bare?.detectedUrl ?? null,
      pid: backgroundProcesses.getPid(processId),
      configuredUrl: meta.ok && isNavigableSource(meta.meta.previewUrlSource) ? meta.meta.previewUrl : null,
    });
    url = target.url;
    note = target.reason ?? null;
    if (target.url && target.source && target.source !== 'configured') {
      setBrowserMetaPreviewUrl(workspacePath, target.url, target.source);
    }
  }

  res.json({
    running: !!primary || !!bare,
    processId,
    url,
    note,
    services: perService,
  });
});

/**
 * POST /api/files/preview/stop  { workspacePath }
 * Stop the project's running dev server (kills the whole process tree).
 */
filesRouter.post('/preview/stop', (req, res) => {
  const workspacePath = String(req.body?.workspacePath || '');
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  const meta = ensureBrowserMeta(workspacePath);
  const services = meta.ok ? meta.meta.services : [];

  // Stop every service's process, plus any process at the workspace root (a
  // bare single-service start that predates the services[] config).
  const cwds = new Set<string>(services.map((s) => path.join(workspacePath, s.cwd)));
  cwds.add(workspacePath);
  let count = 0;
  for (const cwd of cwds) {
    const running = backgroundProcesses.findRunningByCwd(cwd);
    if (running) { backgroundProcesses.stop(running.id); count++; }
  }
  res.json({ ok: true, stopped: count > 0, count });
});

/**
 * GET /api/files/background/list
 * All background processes Bubbly is running (dev servers, watchers, builds the
 * agent or the preview started). Powers the right-panel "Background" tab.
 */
filesRouter.get('/background/list', (_req, res) => {
  res.json({ processes: backgroundProcesses.list() });
});

/**
 * GET /api/files/background/output?id=...&lines=...
 * The captured output buffer for one background process, for the expandable
 * live-log view. Returns the FULL buffer (bounded ring buffer, so it's cheap).
 */
filesRouter.get('/background/output', (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  const lines = req.query.lines ? Math.max(1, Math.min(5000, Number(req.query.lines))) : undefined;
  const r = backgroundProcesses.getOutput(id, { full: true, lines });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, output: r.output ?? '', status: r.status, exitCode: r.exitCode });
});

/**
 * POST /api/files/background/stop  { id }
 * Stop one background process (kills the whole tree) from the UI.
 */
filesRouter.post('/background/stop', (req, res) => {
  const id = String(req.body?.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  const r = backgroundProcesses.stop(id);
  res.json({ ok: r.ok, error: r.error });
});

/**
 * POST /api/files/browser-meta  { workspacePath, previewUrl }
 * Persist the last-known preview URL so "Start" reopens the right server.
 */
filesRouter.post('/browser-meta', (req, res) => {
  const workspacePath = String(req.body?.workspacePath || '');
  const previewUrl = String(req.body?.previewUrl || '');
  if (!workspacePath) return res.status(400).json({ error: 'workspacePath is required' });
  if (previewUrl) setBrowserMetaPreviewUrl(workspacePath, previewUrl);
  res.json({ ok: true });
});

/**
 * Serve a Bubbly-generated screenshot (browser/computer control) from the OS
 * temp dir. Strictly validated: only a bare filename matching our own naming
 * pattern is served — never an arbitrary path — so this can't leak other files.
 */
filesRouter.get('/screenshot', (req, res) => {
  try {
    const file = String(req.query.file || '');
    if (!/^bubbly_(browser|screen)[a-z0-9_]*\.png$/i.test(file)) {
      return res.status(400).json({ error: 'Invalid screenshot name' });
    }
    const full = path.join(os.tmpdir(), file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(full);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Directories that should never be expanded in the tree (huge/noise). */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache',
  '.turbo', '.parcel-cache', 'coverage', '.nuxt', '.svelte-kit', '.venv',
  '__pycache__', '.idea', '.vs',
]);

export interface DirEntry {
  name: string;
  /** Path relative to the workspace root, using forward slashes. */
  path: string;
  type: 'file' | 'directory';
}

/**
 * List one directory level with structured entries, sorted folders-first then
 * alphabetically (the VS Code convention). This powers the lazy tree: the UI
 * asks for a directory's children only when the user expands it, so structure
 * is never lost no matter how deep or large the project is.
 */
function listDirectoryDetailed(workspacePath: string, dirPath: string): DirEntry[] {
  const rel = dirPath === '.' || dirPath === '' ? '' : dirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = path.resolve(workspacePath, rel);
  // Containment guard: never escape the workspace.
  const root = path.resolve(workspacePath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Path escapes workspace');
  }
  if (!fs.existsSync(full)) throw new Error(`Directory not found: ${dirPath}`);

  const dirents = fs.readdirSync(full, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    // Hide noise dirs but still show dotfiles (VS Code shows them).
    if (d.isDirectory() && IGNORED_DIRS.has(d.name)) continue;
    const childRel = (rel ? rel + '/' : '') + d.name;
    let isDir = d.isDirectory();
    // Resolve symlinks to a best-effort type without following into them.
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(full + path.sep + d.name).isDirectory(); } catch { isDir = false; }
    }
    entries.push({ name: d.name, path: childRel, type: isDir ? 'directory' : 'file' });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

function getWorkspace(query: Record<string, unknown>): string {
  const ws = (query.workspace as string) || getAllSettings().workspacePath;
  if (!ws || !fs.existsSync(ws)) {
    logger.error('Invalid workspace path', { workspace: ws });
    throw new Error('Invalid workspace path');
  }
  return ws;
}

filesRouter.get('/tree', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    logger.info('Getting file tree', { workspace: ws });
    const tree = getFileTree(ws, '.', 5); // Get tree with depth 5
    res.json({ tree });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to get file tree', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

filesRouter.get('/list', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const dirPath = (req.query.path as string) || '.';
    const entries = listDirectoryDetailed(ws, dirPath);
    res.json({ entries });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to list directory', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

/** Fuzzy filename search — powers the title-bar search / command palette. */
filesRouter.get('/find', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ files: [] });
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { fuzzyFileSearch } = require('../agent/tools/filesystem');
    const hits = fuzzyFileSearch(ws, q, limit) as Array<{ path: string }>;
    return res.json({ files: hits.map((h) => h.path) });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to find files', { error: errorMsg });
    return res.status(400).json({ error: errorMsg });
  }
});

/**
 * GET /api/files/git-stats?workspace=...
 * Working-tree change totals for the composer's diff pill. Always 200: when git
 * is missing or the folder isn't a repo the pill simply hides itself.
 */
filesRouter.get('/git-stats', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const { getGitChangeStats } = require('../agent/tools/git');
    res.json(getGitChangeStats(ws));
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.debug('Git stats unavailable', { error: errorMsg });
    res.json({ available: false, branch: null, filesChanged: 0, insertions: 0, deletions: 0, untracked: 0 });
  }
});

/** List per-prompt checkpoints (for the "undo last N prompts" UI). */
filesRouter.get('/checkpoints', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    const { listPromptCheckpoints } = require('../agent/promptCheckpoints');
    res.json({ checkpoints: listPromptCheckpoints(ws, sessionId) });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to list prompt checkpoints', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

/** Revert the workspace to the state before a given prompt. */
filesRouter.post('/checkpoints/revert', (req, res) => {
  try {
    const ws = req.body.workspace || getAllSettings().workspacePath;
    const id = String(req.body.id ?? '');
    if (!ws || !fs.existsSync(ws)) return res.status(400).json({ error: 'Invalid workspace path' });
    if (!id) return res.status(400).json({ error: 'checkpoint id required' });
    const { revertToPromptCheckpoint } = require('../agent/promptCheckpoints');
    const result = revertToPromptCheckpoint(ws, id);
    res.json(result);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to revert prompt checkpoint', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

filesRouter.get('/read', async (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const filePath = req.query.path as string;
    if (!filePath) {
      logger.warn('Read file request missing path');
      return res.status(400).json({ error: 'path required' });
    }
    logger.info('Reading file', { workspace: ws, path: filePath });
    const content = await readFile(ws, filePath);
    return res.json({ content, path: filePath });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to read file', { error: errorMsg, path: req.query.path });
    return res.status(400).json({ error: errorMsg });
  }
});

filesRouter.post('/write', async (req, res) => {
  try {
    const settings = getAllSettings();
    const ws = req.body.workspace || settings.workspacePath;
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      logger.warn('Write file request missing path or content');
      return res.status(400).json({ error: 'path and content required' });
    }
    logger.info('Writing file', { workspace: ws, path: filePath, contentLength: content.length });
    const result = await writeFile(ws, filePath, content);
    return res.json(result);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to write file', { error: errorMsg, path: req.body.path });
    return res.status(400).json({ error: errorMsg });
  }
});

filesRouter.get('/specs', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    logger.info('Listing specs', { workspace: ws });
    const { listSpecs } = require('../agent/tools/specs');
    const specs = listSpecs(ws);
    res.json(specs);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to list specs', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

// Code-intelligence: compressed repo map for the current workspace.
filesRouter.get('/repomap', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const focus = req.query.focus ? String(req.query.focus) : undefined;
    const { buildRepoMap, getIndex } = require('../agent/intelligence/codeIntelligence');
    const map = buildRepoMap(ws, { focus });
    const idx = getIndex(ws);
    res.json({ map, fileCount: idx.fileCount });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to build repo map', { error: errorMsg });
    res.status(400).json({ error: errorMsg });
  }
});

// Code-intelligence: symbol search.
filesRouter.get('/symbols', (req, res) => {
  try {
    const ws = getWorkspace(req.query);
    const q = String(req.query.q ?? '');
    if (!q) return res.status(400).json({ error: 'q (query) required' });
    const { searchSymbols } = require('../agent/intelligence/codeIntelligence');
    return res.json({ symbols: searchSymbols(ws, q) });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to search symbols', { error: errorMsg });
    return res.status(400).json({ error: errorMsg });
  }
});
