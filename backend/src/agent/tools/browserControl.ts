/**
 * Browser control — gives the agent its OWN watchable browser to navigate.
 *
 * This is the safe, preferred alternative to PyAutoGUI: instead of hijacking the
 * user's real mouse/keyboard/screen, the agent drives a dedicated, sandboxed
 * Chromium window (via Playwright). The window is launched HEADED so the user
 * can literally watch it work, and a visible "Bubbly cursor" overlay is injected
 * into every page so its clicks/moves are easy to follow — not a black box.
 *
 * Guardrails:
 *   1. OPT-IN: does nothing unless `browserControlEnabled` is turned on.
 *   2. SANDBOXED: it can only touch its own browser — never the user's files,
 *      apps, or OS input — so it's far lower-risk than computer_control.
 *   3. WATCHABLE + STOPPABLE: headed window + screenshots returned to chat; the
 *      user can stop the run at any time.
 *   4. GRACEFUL: if Playwright isn't installed we return precise install steps.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from '../../db/index';
import { logger } from '../../utils/logger';
import { isPreviewClientAvailable, hasEverSeenCapableClient, runPreviewAction } from './previewBridge';
import { getProjectDataPath } from '../projectData';

export type BrowserAction =
  | 'open' | 'goto' | 'reload' | 'click' | 'type' | 'press' | 'scroll' | 'wait'
  | 'screenshot' | 'snapshot' | 'back' | 'forward' | 'close' | 'viewport' | 'console';

export const BROWSER_READ_ONLY: ReadonlySet<BrowserAction> = new Set(['screenshot', 'snapshot', 'viewport', 'console']);

/** Named device viewports for responsive QA. */
export const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },   // iPhone-ish
  tablet: { width: 820, height: 1180 },  // iPad-ish
  desktop: { width: 1280, height: 800 },
  wide: { width: 1680, height: 1050 },
};

export function isBrowserControlEnabled(): boolean {
  return getSetting('browserControlEnabled') === 'true';
}

/**
 * One runnable service in a project. A simple app has one (the root); a
 * monorepo has several (e.g. a Vite frontend + an Express API). Each is started
 * in its own `cwd`, so ONE Run brings the whole app up — frontend and backend.
 */
export interface RunService {
  /** Display name (relative dir, or the package/root name for the root). */
  name: string;
  /** Directory to run in, RELATIVE to the workspace root ('' = root). */
  cwd: string;
  install: string | null;
  /** The command the Run/Start button executes for this service. */
  start: string | null;
  /** Best-guess dev port (Vite 5173, Next 3000, …). Runtime URL detection from
   *  the server's own output overrides this; it's just the initial guess. */
  port: number | null;
  /** http://localhost:<port> for a frontend service; null for backends. */
  url: string | null;
  kind: 'frontend' | 'backend';
}

export interface BrowserMeta {
  workspacePath: string;
  enabled: boolean;
  createdAt: string;
  /** Where "Start" opens the preview. Points at the primary frontend service
   *  and is updated as the real URL is detected/typed. */
  previewUrl: string | null;
  /** Legacy single-service fields, kept for back-compat + the address bar.
   *  Derived from the primary (frontend) service. */
  install: string | null;
  start: string | null;
  /** Every runnable service detected in the project. One Run starts them all. */
  services: RunService[];
}

const DEFAULT_PREVIEW_URL = 'http://localhost:3000';

// --- Run-config inference (the auto-authored "Dockerfile") -------------------
// We learn HOW a project starts and WHERE its frontend serves BEFORE writing
// browser-meta.json, so the Run button works no matter how the project is laid
// out: a single app, or a monorepo with a separate frontend + backend.

type Pkg = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

function readPkg(dir: string): Pkg | null {
  try {
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Pkg;
  } catch { return null; }
}

/** Package manager for a dir, honouring a root lockfile (monorepos). */
function detectPm(dir: string, root: string): string {
  const has = (f: string) => fs.existsSync(path.join(dir, f)) || fs.existsSync(path.join(root, f));
  return has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
}
function runPrefix(pm: string): string {
  return pm === 'npm' ? 'npm run' : pm === 'bun' ? 'bun run' : pm;
}

/** Detect a frontend framework + its conventional dev port from deps/config. */
function detectFrontend(dir: string, deps: Record<string, string>): { framework: string; port: number } | null {
  const cfg = (name: string) => ['js', 'ts', 'mjs', 'cjs'].some((e) => fs.existsSync(path.join(dir, `${name}.${e}`)));
  if (deps.next || cfg('next.config')) return { framework: 'next', port: 3000 };
  if (deps.nuxt || deps.nuxt3) return { framework: 'nuxt', port: 3000 };
  if (deps['@remix-run/dev'] || deps['@remix-run/serve']) return { framework: 'remix', port: 3000 };
  if (deps['@angular/core']) return { framework: 'angular', port: 4200 };
  if (deps.astro || cfg('astro.config')) return { framework: 'astro', port: 4321 };
  if (deps.gatsby) return { framework: 'gatsby', port: 8000 };
  if (deps['react-scripts']) return { framework: 'cra', port: 3000 };
  if (deps['@vue/cli-service']) return { framework: 'vue-cli', port: 8080 };
  if (deps.vite || deps['@sveltejs/kit'] || cfg('vite.config') || cfg('svelte.config')) return { framework: 'vite', port: 5173 };
  return null;
}

/** Detect a backend server from deps/files. Port is often unknowable → null. */
function detectBackend(dir: string, deps: Record<string, string>): { framework: string; port: number | null } | null {
  if (deps.express || deps.fastify || deps.koa || deps['@nestjs/core'] || deps['@hapi/hapi'] || deps.hono) return { framework: 'node-server', port: null };
  if (fs.existsSync(path.join(dir, 'manage.py'))) return { framework: 'django', port: 8000 };
  if (fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) return { framework: 'python', port: null };
  if (fs.existsSync(path.join(dir, 'go.mod'))) return { framework: 'go', port: null };
  return null;
}

/** Build a RunService for one directory, or null if nothing runnable lives there. */
function serviceForDir(absDir: string, root: string): RunService | null {
  const rel = path.relative(root, absDir).replace(/\\/g, '/');
  const pkg = readPkg(absDir);

  if (pkg) {
    const scripts = pkg.scripts ?? {};
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null;
    if (!script) return null; // a package with no runnable dev/start/serve script
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const pm = detectPm(absDir, root);
    const name = rel || (pkg.name ? pkg.name.split('/').pop()! : path.basename(root));
    const fe = detectFrontend(absDir, deps);
    const be = fe ? null : detectBackend(absDir, deps);
    const hintFront = /(front|client|web|ui|app|site|dashboard)/i.test(rel);
    const hintBack = /(back|server|api|service|worker|daemon)/i.test(rel);

    let kind: 'frontend' | 'backend';
    let port: number | null;
    if (fe) { kind = 'frontend'; port = fe.port; }
    else if (be) { kind = 'backend'; port = be.port; }
    else if (hintBack && !hintFront) { kind = 'backend'; port = null; }
    else if (hintFront) { kind = 'frontend'; port = 3000; }
    else { kind = 'frontend'; port = 3000; } // lone web app default

    return {
      name,
      cwd: rel,
      install: `${pm} install`,
      start: `${runPrefix(pm)} ${script}`,
      port,
      url: kind === 'frontend' && port ? `http://localhost:${port}` : null,
      kind,
    };
  }

  // Non-Node conventions (only meaningful at a real service dir).
  const be = detectBackend(absDir, {});
  if (be?.framework === 'django') {
    return { name: rel || path.basename(root), cwd: rel, install: 'pip install -r requirements.txt', start: 'python manage.py runserver', port: 8000, url: 'http://localhost:8000', kind: 'backend' };
  }
  if (be?.framework === 'python') {
    return { name: rel || path.basename(root), cwd: rel, install: 'pip install -r requirements.txt', start: null, port: null, url: null, kind: 'backend' };
  }
  return null;
}

/** Workspace globs from package.json `workspaces` and pnpm-workspace.yaml. */
function readWorkspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  const pkg = readPkg(root);
  if (pkg?.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
    globs.push(...ws);
  }
  try {
    const pnpmWs = path.join(root, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmWs)) {
      for (const line of fs.readFileSync(pnpmWs, 'utf8').split('\n')) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (m) globs.push(m[1].trim());
      }
    }
  } catch { /* ignore */ }
  return globs;
}

/**
 * Discover every runnable service in a project. Checks common monorepo service
 * dirs, workspace globs (apps/*, packages/*), and the root. Library packages
 * (no dev/start/serve script) are naturally skipped. A monorepo root whose dev
 * script is just an orchestrator (turbo/concurrently) is dropped once we have
 * the real per-service commands, so we don't start everything twice.
 */
export function inferServices(root: string): RunService[] {
  const services: RunService[] = [];
  const seen = new Set<string>();
  const add = (absDir: string) => {
    const key = path.resolve(absDir);
    if (seen.has(key)) return;
    seen.add(key);
    const s = serviceForDir(absDir, root);
    if (s) services.push(s);
  };

  const candidates = [
    'frontend', 'client', 'web', 'app', 'ui', 'apps/web', 'apps/frontend', 'apps/client', 'apps/app',
    'backend', 'server', 'api', 'apps/api', 'apps/server', 'apps/backend', 'services/api',
    'packages/web', 'packages/app',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c, 'package.json'))) add(path.join(root, c));
  }

  for (const glob of readWorkspaceGlobs(root)) {
    const m = glob.match(/^(.*)\/\*$/);
    if (!m) continue;
    const base = path.join(root, m[1]);
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'package.json'))) {
          add(path.join(base, entry.name));
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  add(root);

  // If we found real per-service commands AND the root's own dev/start script is
  // just an orchestrator (turbo/concurrently/npm-run-all) that fans out to those
  // same services, drop the root so we don't start everything twice.
  if (services.length > 1) {
    const rootIdx = services.findIndex((s) => s.cwd === '');
    if (rootIdx >= 0) {
      const rootPkg = readPkg(root);
      const scripts = rootPkg?.scripts ?? {};
      const body = scripts.dev ?? scripts.start ?? scripts.serve ?? '';
      if (/(turbo|concurrently|npm-run-all|run-p|run-s|lerna|nx run)/i.test(body)) {
        services.splice(rootIdx, 1);
      }
    }
  }

  return services;
}

/** The primary service whose URL the preview opens (first frontend, else first). */
export function primaryService(services: RunService[]): RunService | null {
  return services.find((s) => s.kind === 'frontend') ?? services[0] ?? null;
}

function primaryPreviewUrl(services: RunService[]): string | null {
  return (services.find((s) => s.kind === 'frontend' && s.url) ?? services.find((s) => s.url))?.url ?? null;
}

/** Remove ANSI escape codes + stray control chars and validate the URL shape.
 *  A URL captured from colourised terminal output (e.g. Vite bolds the port)
 *  can arrive as "http://localhost:\x1b[1m5173\x1b[22m/"; a dirty value here
 *  would make the Start button navigate to garbage. Returns null if unusable. */
function sanitizePreviewUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = url.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f]/g, '').trim();
  return /^https?:\/\/[^\s]+$/i.test(clean) ? clean : null;
}

export function getBrowserMetaPath(workspacePath: string): string {
  // Lives OUTSIDE the project (see projectData) so its presence never blocks a
  // clean-slate scaffold like `npm create vite .`.
  return getProjectDataPath(workspacePath, 'browser-meta.json');
}

/** Persist the last-known preview URL into the project's meta so the Start
 *  button reopens the right server next time. Best-effort. */
export function setBrowserMetaPreviewUrl(workspacePath: string, previewUrl: string): void {
  try {
    const clean = sanitizePreviewUrl(previewUrl);
    if (!clean) return;
    const r = ensureBrowserMeta(workspacePath);
    if (!r.ok) return;
    const metaPath = getBrowserMetaPath(workspacePath);
    fs.writeFileSync(metaPath, JSON.stringify({ ...r.meta, previewUrl: clean }, null, 2));
  } catch { /* non-critical */ }
}

/**
 * Project-scoped lock file for browser/computer control. The agent must never
 * drive a browser in a project it hasn't touched before without leaving a
 * trace: the first time any browser tool runs against a workspace, this file
 * is created automatically (so the user can see it, disable it, or delete the
 * project's opt-in by editing/removing the file) and every subsequent call
 * reads it back to confirm control is still enabled for THIS project. A
 * project can be disabled independently of the global Settings toggles by
 * setting "enabled": false in its own browser-meta.json.
 */
export function ensureBrowserMeta(workspacePath: string): { ok: true; meta: BrowserMeta; created: boolean } | { ok: false; error: string } {
  const metaPath = getBrowserMetaPath(workspacePath);
  try {
    if (fs.existsSync(metaPath)) {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<BrowserMeta>;
      // Back-fill the run config for metas written before a given field existed,
      // so old projects also get a working (multi-service) Run button. We only
      // re-infer when something is missing, so a user's hand-edits are preserved.
      const needsInfer = raw.services === undefined || raw.start === undefined || raw.install === undefined;
      const services = (raw.services && raw.services.length) ? raw.services : (needsInfer ? inferServices(workspacePath) : []);
      const primary = primaryService(services);
      const meta: BrowserMeta = {
        workspacePath,
        enabled: raw.enabled !== false,
        createdAt: raw.createdAt ?? new Date().toISOString(),
        // Sanitize any previously-saved dirty URL (ANSI codes) so Start never
        // navigates to garbage; fall back to a detected/default URL if unusable.
        previewUrl: sanitizePreviewUrl(raw.previewUrl) ?? primaryPreviewUrl(services) ?? DEFAULT_PREVIEW_URL,
        install: raw.install ?? primary?.install ?? null,
        start: raw.start ?? primary?.start ?? null,
        services,
      };
      if (!meta.enabled) {
        return { ok: false, error: `Browser/computer control is disabled for this project (see ${metaPath} — set "enabled": true to re-allow).` };
      }
      // Persist any back-filled run config so the file is self-describing.
      if (needsInfer) {
        try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch { /* non-critical */ }
      }
      return { ok: true, meta, created: false };
    }
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const services = inferServices(workspacePath);
    const primary = primaryService(services);
    const meta: BrowserMeta = {
      workspacePath,
      enabled: true,
      createdAt: new Date().toISOString(),
      previewUrl: primaryPreviewUrl(services) ?? DEFAULT_PREVIEW_URL,
      install: primary?.install ?? null,
      start: primary?.start ?? null,
      services,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    logger.info('Created browser-meta.json for project', {
      workspacePath, metaPath, services: services.length, start: meta.start,
    });
    return { ok: true, meta, created: true };
  } catch (err) {
    return { ok: false, error: `Could not read/create browser-meta.json: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Run-config LIFECYCLE (who authors browser-meta.json, and when) ---------
//
// The contract, in order:
//
//   1. NO META  -> the agent may not preview. `readRunConfig` reports
//      `exists:false` and the browser_control gate refuses with the DETECTED
//      suggestion attached, so the agent's next move is to look at the project
//      and call `preview_config` (write) — confirming or correcting the guess.
//      Detection is a starting point handed to the agent, never a silent write:
//      the agent is the author, which is what makes the config trustworthy.
//
//   2. META EXISTS -> it is AUTHORITATIVE and is never overwritten behind the
//      agent's/user's back. We only (a) migrate v1 -> v2 in memory, (b) validate
//      it, and (c) diff it against fresh detection. Anything wrong or stale
//      comes back as `issues` that ride along with the tool result, so the agent
//      can fix it deliberately via `preview_config` instead of losing hand edits.
//
//   3. DISABLED (`"enabled": false`) -> hard refusal, both paths. That's the
//      user's per-project kill switch and no detection overrides it.

export interface MetaIssue {
  /** 'error' blocks a useful run; 'warn' is drift worth reporting, not fatal. */
  level: 'error' | 'warn';
  message: string;
}

export interface RunConfigStatus {
  path: string;
  exists: boolean;
  enabled: boolean;
  /** Present whenever the file exists and parses. Migrated in memory only. */
  meta: BrowserMeta | null;
  /** Validation + drift findings against an EXISTING meta. */
  issues: MetaIssue[];
  /** Fresh detection — the suggestion to author from, or to diff against. */
  suggestion: RunService[];
  /** True when the on-disk file was a v1 (flat install/start) meta. */
  migrated: boolean;
}

/** Validate a service list against the real filesystem, and diff it against what
 *  we can detect today. Pure reporting — never mutates the meta. */
function validateServices(workspacePath: string, services: RunService[], detected: RunService[]): MetaIssue[] {
  const issues: MetaIssue[] = [];

  if (services.length === 0) {
    issues.push({ level: 'error', message: 'No services are configured. Add at least one service with a "start" command.' });
  }

  const seen = new Set<string>();
  for (const s of services) {
    const dir = path.join(workspacePath, s.cwd || '');
    if (!fs.existsSync(dir)) {
      issues.push({ level: 'error', message: `Service "${s.name}" points at "${s.cwd || '.'}" which no longer exists (moved or deleted?).` });
      continue;
    }
    if (seen.has(s.cwd)) {
      issues.push({ level: 'warn', message: `Two services share cwd "${s.cwd || '.'}" — the second will be started twice.` });
    }
    seen.add(s.cwd);
    if (!s.start) {
      issues.push({ level: 'warn', message: `Service "${s.name}" has no "start" command, so Run skips it.` });
    }
  }

  if (services.length > 0 && !services.some((s) => s.start)) {
    issues.push({ level: 'error', message: 'No service has a "start" command, so nothing can be run.' });
  }
  if (services.length > 0 && !services.some((s) => s.kind === 'frontend')) {
    issues.push({ level: 'warn', message: 'No service is marked kind:"frontend", so there is no page to preview. Mark the one that serves the UI.' });
  }

  // Drift: a service exists on disk that the config never mentions. Common after
  // the agent scaffolds a new app into a monorepo it configured earlier.
  for (const d of detected) {
    if (!services.some((s) => s.cwd === d.cwd)) {
      issues.push({ level: 'warn', message: `Detected an unconfigured service at "${d.cwd || '.'}" (${d.kind}, start: ${d.start ?? 'unknown'}). Add it if it should run.` });
    }
  }

  return issues;
}

/** Coerce whatever is on disk into a v2 meta IN MEMORY. A v1 file (flat
 *  install/start, no services[]) becomes a single root service so old projects
 *  keep working without their hand-written commands being thrown away. */
function migrateMeta(workspacePath: string, raw: Partial<BrowserMeta>): { meta: BrowserMeta; migrated: boolean } {
  const isV1 = !Array.isArray(raw.services) || raw.services.length === 0;
  const services: RunService[] = isV1
    ? (raw.start || raw.install
        // Preserve the v1 commands verbatim as the root service — a hand-edited
        // v1 `start` is a deliberate choice and outranks anything we'd detect.
        ? [{
            name: path.basename(workspacePath) || 'root',
            cwd: '',
            install: raw.install ?? null,
            start: raw.start ?? null,
            port: null,
            url: sanitizePreviewUrl(raw.previewUrl),
            kind: 'frontend' as const,
          }]
        : [])
    : raw.services!;

  const primary = primaryService(services);
  return {
    migrated: isV1,
    meta: {
      workspacePath,
      enabled: raw.enabled !== false,
      createdAt: raw.createdAt ?? new Date().toISOString(),
      previewUrl: sanitizePreviewUrl(raw.previewUrl) ?? primaryPreviewUrl(services),
      install: raw.install ?? primary?.install ?? null,
      start: raw.start ?? primary?.start ?? null,
      services,
    },
  };
}

/**
 * Read the project's run config WITHOUT creating it. This is the agent-facing
 * entry point: absence is a reportable state ("go learn the project and author
 * one"), not something we paper over with a guess.
 */
export function readRunConfig(workspacePath: string): RunConfigStatus {
  const metaPath = getBrowserMetaPath(workspacePath);
  let suggestion: RunService[] = [];
  try { suggestion = inferServices(workspacePath); } catch { /* detection is best-effort */ }

  const base: RunConfigStatus = { path: metaPath, exists: false, enabled: true, meta: null, issues: [], suggestion, migrated: false };

  try {
    if (!fs.existsSync(metaPath)) return base;
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<BrowserMeta>;
    const { meta, migrated } = migrateMeta(workspacePath, raw);
    return {
      ...base,
      exists: true,
      enabled: meta.enabled,
      meta,
      migrated,
      issues: meta.enabled ? validateServices(workspacePath, meta.services, suggestion) : [],
    };
  } catch (err) {
    // A corrupt file is a real state the agent must fix, not a reason to crash.
    return { ...base, exists: true, issues: [{ level: 'error', message: `browser-meta.json is unreadable (${err instanceof Error ? err.message : String(err)}). Rewrite it with preview_config.` }] };
  }
}

/** Render a run config (or its absence) as compact text for a tool result. */
export function describeRunConfig(status: RunConfigStatus): string {
  const lines: string[] = [];
  const list = status.meta?.services ?? status.suggestion;
  if (list.length === 0) {
    lines.push('(no services)');
  } else {
    for (const s of list) {
      const bits = [`cwd: ${s.cwd || '.'}`, `kind: ${s.kind}`];
      if (s.install) bits.push(`install: ${s.install}`);
      bits.push(`start: ${s.start ?? '(none)'}`);
      if (s.url) bits.push(`url: ${s.url}`);
      lines.push(`  - ${s.name} — ${bits.join(', ')}`);
    }
  }
  if (status.meta?.previewUrl) lines.push(`  previewUrl: ${status.meta.previewUrl}`);
  for (const i of status.issues) lines.push(`  [${i.level}] ${i.message}`);
  return lines.join('\n');
}

/** Normalize one agent-supplied service, filling in what it left out. */
function coerceService(workspacePath: string, input: Partial<RunService>, index: number): RunService {
  const cwd = String(input.cwd ?? '').replace(/^[./\\]+/, '').replace(/\\/g, '/');
  const kind: 'frontend' | 'backend' = input.kind === 'backend' ? 'backend' : 'frontend';
  const port = typeof input.port === 'number' && input.port > 0 && input.port < 65536 ? input.port : null;
  return {
    name: String(input.name || cwd || path.basename(workspacePath) || `service-${index + 1}`),
    cwd,
    install: input.install ? String(input.install) : null,
    start: input.start ? String(input.start) : null,
    port,
    // A frontend without an explicit URL still needs one to preview; derive it
    // from the port so the agent doesn't have to spell out both.
    url: sanitizePreviewUrl(input.url) ?? (kind === 'frontend' && port ? `http://localhost:${port}` : null),
    kind,
  };
}

/**
 * Author (or re-author) the run config. This is the ONLY way a config comes
 * into existence for the agent — it writes what the agent decided after looking
 * at the project, so the file reflects understanding rather than a guess.
 * Existing `createdAt`/`enabled` are preserved: re-authoring is an edit, and the
 * user's kill switch is not something a write silently clears.
 */
export function writeRunConfig(
  workspacePath: string,
  input: { services: Array<Partial<RunService>>; previewUrl?: string | null },
): { ok: true; status: RunConfigStatus } | { ok: false; error: string } {
  const metaPath = getBrowserMetaPath(workspacePath);
  try {
    if (!Array.isArray(input.services) || input.services.length === 0) {
      return { ok: false, error: 'services must be a non-empty array. Inspect the project first (package.json scripts, subdirectories), then describe each runnable service.' };
    }
    const services = input.services.map((s, i) => coerceService(workspacePath, s, i));

    // Reject a config that points at directories that aren't there — writing it
    // would only produce a Run that fails later, further from the cause.
    const missing = services.filter((s) => !fs.existsSync(path.join(workspacePath, s.cwd || '')));
    if (missing.length > 0) {
      return { ok: false, error: `These service directories do not exist: ${missing.map((s) => s.cwd || '.').join(', ')}. Use paths relative to the workspace root ('' means the root).` };
    }
    if (!services.some((s) => s.start)) {
      return { ok: false, error: 'At least one service needs a "start" command (e.g. "npm run dev").' };
    }

    const prior = fs.existsSync(metaPath)
      ? (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<BrowserMeta>)
      : {};
    const primary = primaryService(services);
    const meta: BrowserMeta = {
      workspacePath,
      enabled: prior.enabled !== false,
      createdAt: prior.createdAt ?? new Date().toISOString(),
      previewUrl: sanitizePreviewUrl(input.previewUrl) ?? primaryPreviewUrl(services) ?? sanitizePreviewUrl(prior.previewUrl),
      install: primary?.install ?? null,
      start: primary?.start ?? null,
      services,
    };
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    logger.info('Run config authored', { workspacePath, services: services.length, previewUrl: meta.previewUrl });
    return { ok: true, status: readRunConfig(workspacePath) };
  } catch (err) {
    return { ok: false, error: `Could not write browser-meta.json: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface BrowserActionParams {
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  amount?: number;
  x?: number;
  y?: number;
  /** Viewport sizing (for the "viewport" action). */
  width?: number;
  height?: number;
  preset?: string;
}

/** Validate an action + params before doing anything. Pure + testable. */
export function validateBrowserAction(
  action: string,
  params: BrowserActionParams
): { ok: true; action: BrowserAction; params: BrowserActionParams } | { ok: false; error: string } {
  const valid: BrowserAction[] = ['open', 'goto', 'reload', 'click', 'type', 'press', 'scroll', 'wait', 'screenshot', 'snapshot', 'back', 'forward', 'close', 'viewport', 'console'];
  if (!valid.includes(action as BrowserAction)) {
    return { ok: false, error: `Unknown browser action "${action}". Valid: ${valid.join(', ')}.` };
  }
  const a = action as BrowserAction;
  const p: BrowserActionParams = {};

  if (a === 'viewport') {
    const preset = typeof params.preset === 'string' ? params.preset.trim().toLowerCase() : '';
    if (preset) {
      if (!VIEWPORT_PRESETS[preset]) {
        return { ok: false, error: `Unknown viewport preset "${preset}". Valid: ${Object.keys(VIEWPORT_PRESETS).join(', ')} — or pass width/height.` };
      }
      p.preset = preset;
      p.width = VIEWPORT_PRESETS[preset].width;
      p.height = VIEWPORT_PRESETS[preset].height;
    } else {
      const w = Number(params.width), h = Number(params.height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200 || w > 4000 || h > 4000) {
        return { ok: false, error: 'viewport requires a valid "preset" (mobile/tablet/desktop/wide) or width+height between 200 and 4000.' };
      }
      p.width = Math.round(w);
      p.height = Math.round(h);
    }
  }

  if (a === 'open' || a === 'goto') {
    const url = String(params.url ?? '').trim();
    if (!url) return { ok: false, error: `${a} requires a "url".` };
    // Reject any explicit non-http(s) scheme (file://, javascript:, data:, …) —
    // the agent is sandboxed to the web.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `Only http(s) URLs are allowed (got "${url}").` };
    }
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (!/^https?:\/\/[^\s]+$/i.test(normalized)) return { ok: false, error: `Invalid url: ${url}` };
    p.url = normalized;
  }

  if (a === 'click') {
    const hasSelector = typeof params.selector === 'string' && params.selector.trim() !== '';
    const hasText = typeof params.text === 'string' && params.text.trim() !== '';
    const hasCoords = typeof params.x === 'number' && typeof params.y === 'number';
    if (!hasSelector && !hasText && !hasCoords) {
      return { ok: false, error: 'click requires a "selector", a "text" to click, or x/y coordinates.' };
    }
    if (hasSelector) p.selector = params.selector!.trim();
    if (hasText) p.text = params.text!.trim();
    if (hasCoords) { p.x = params.x; p.y = params.y; }
  }

  if (a === 'type') {
    if (typeof params.text !== 'string' || params.text.length === 0) {
      return { ok: false, error: 'type requires a non-empty "text".' };
    }
    if (params.text.length > 5000) return { ok: false, error: 'type text too long (max 5000).' };
    p.text = params.text;
    if (typeof params.selector === 'string' && params.selector.trim()) p.selector = params.selector.trim();
  }

  if (a === 'press') {
    if (typeof params.key !== 'string' || params.key.trim() === '') {
      return { ok: false, error: 'press requires a "key" (e.g. "Enter", "Tab", "Control+A").' };
    }
    p.key = params.key.trim();
  }

  if (a === 'scroll') {
    if (typeof params.amount !== 'number' || !Number.isFinite(params.amount)) {
      return { ok: false, error: 'scroll requires a numeric "amount" (positive = down).' };
    }
    p.amount = Math.max(-10000, Math.min(10000, params.amount));
  }

  if (a === 'wait') {
    // Optional: wait for a selector, and/or a fixed delay in ms (default 1000).
    if (typeof params.selector === 'string' && params.selector.trim()) p.selector = params.selector.trim();
    if (typeof params.amount === 'number' && Number.isFinite(params.amount)) {
      p.amount = Math.max(0, Math.min(15000, params.amount));
    }
  }

  return { ok: true, action: a, params: p };
}

// Visible "Bubbly cursor" injected into every page so the user can watch.
const CURSOR_INIT = `
(() => {
  if (window.__bubblyCursor) return;
  const c = document.createElement('div');
  c.id = '__bubbly_cursor';
  c.style.cssText = 'position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(167,139,250,0.45);border:2px solid #a78bfa;box-shadow:0 0 12px rgba(167,139,250,0.8);pointer-events:none;transition:left .25s ease,top .25s ease;left:-50px;top:-50px;';
  const add = () => { if (document.body && !document.getElementById('__bubbly_cursor')) document.body.appendChild(c); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  window.__bubblyCursor = true;
  window.__bubblyMoveCursor = (x, y) => { const el = document.getElementById('__bubbly_cursor'); if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; } };
})();
`;

type PwBrowser = { newContext: (o?: any) => Promise<any>; close: () => Promise<void>; isConnected?: () => boolean };
type PwPage = any;

// Page-context snapshot script (string form so the Node tsconfig doesn't try to
// type-check browser globals). Returns title/url/interactive elements/text.
const SNAPSHOT_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const items = [];
  document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').forEach((el) => {
    if (!visible(el)) return;
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 60);
    if (label || tag === 'input' || tag === 'textarea') items.push(tag + ': "' + label + '" @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  });
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2500);
  // Responsive-relevant metrics so the agent can reason about layout without vision.
  const de = document.documentElement;
  const overflowX = Math.max(0, (de.scrollWidth || 0) - window.innerWidth);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 12).map((h) => h.tagName.toLowerCase() + ': ' + (h.innerText || '').trim().slice(0, 60));
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    page: { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, scrollX: window.scrollX, scrollY: window.scrollY, overflowX },
    counts: { links: document.querySelectorAll('a').length, buttons: document.querySelectorAll('button,[role=button]').length, inputs: document.querySelectorAll('input,textarea,select').length, images: document.querySelectorAll('img').length },
    headings,
    items: items.slice(0, 60),
    text,
  };
})()`;

/** Format a snapshot object into the text block returned to the model. */
function formatSnapshot(snap: any, consoleErrors?: string[]): string {
  const vp = snap.viewport ? `\nViewport: ${snap.viewport.width}x${snap.viewport.height} (dpr ${snap.viewport.dpr})` : '';
  const pg = snap.page ? `\nPage: ${snap.page.scrollWidth}x${snap.page.scrollHeight}${snap.page.overflowX > 0 ? ` — ⚠ horizontal overflow of ${snap.page.overflowX}px (content wider than viewport)` : ''}` : '';
  const counts = snap.counts ? `\nElements: ${snap.counts.links} links, ${snap.counts.buttons} buttons, ${snap.counts.inputs} inputs, ${snap.counts.images} images` : '';
  const headings = snap.headings?.length ? `\nHeadings:\n${snap.headings.join('\n')}` : '';
  const elements = snap.items?.length ? `\nInteractive elements (label @x,y WxH):\n${snap.items.join('\n')}` : '';
  const errs = consoleErrors && consoleErrors.length ? `\nConsole errors (${consoleErrors.length}):\n${consoleErrors.slice(-8).join('\n')}` : '';
  return `Page: ${snap.title}\nURL: ${snap.url}${vp}${pg}${counts}${headings}${elements}${errs}\n\nVisible text:\n${snap.text}`;
}

let playwright: any | null = null;
function loadPlaywright(): any | null {
  // Only cache a SUCCESSFUL load. Caching a failed require() permanently
  // (as before) meant that installing Playwright while the backend was running
  // never took effect — it kept reporting "not installed" until a full restart.
  // Now we retry the require on every call until it succeeds.
  if (playwright) return playwright;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playwright = require('playwright');
  } catch {
    try { playwright = require('playwright-core'); } catch { return null; }
  }
  return playwright;
}

class BrowserSession {
  private browser: PwBrowser | null = null;
  private context: any = null;
  private page: PwPage = null;
  /** Recent console errors / page errors, surfaced in snapshots. */
  private consoleErrors: string[] = [];
  /** Full recent console log (all levels) + failed requests, for the `console` action. */
  private consoleLog: string[] = [];

  get isOpen(): boolean { return !!this.page; }

  private async ensure(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.page) return { ok: true };
    const pw = loadPlaywright();
    if (!pw) {
      return { ok: false, error: 'Playwright is not installed. Run `npm i playwright` then `npx playwright install chromium` in the backend, and try again.' };
    }
    try {
      // HEADLESS: the agent's browser is streamed into the docked Bubbly Preview
      // panel as a screenshot after every action, so we no longer pop up a
      // separate OS window. A fixed viewport keeps frames consistent.
      this.browser = await pw.chromium.launch({ headless: true });
      this.context = await this.browser!.newContext({ viewport: { width: 1280, height: 800 } });
      // Inject the visible cursor into every page/navigation.
      await this.context.addInitScript(CURSOR_INIT);
      this.page = await this.context.newPage();
      // Capture ALL console output + uncaught errors + failed requests so the
      // agent can debug the page without vision. Errors also feed the snapshot
      // summary; the full log is available via the `console` action.
      try {
        this.page.on('console', (msg: any) => {
          const level = msg.type?.() ?? 'log';
          const text = String(msg.text?.() ?? '').slice(0, 300);
          this.pushLog(`[${level}] ${text}`);
          if (level === 'error') this.pushError(`console.error: ${text.slice(0, 200)}`);
        });
        this.page.on('pageerror', (err: any) => {
          const t = String(err?.message ?? err).slice(0, 300);
          this.pushLog(`[pageerror] ${t}`);
          this.pushError(`pageerror: ${t.slice(0, 200)}`);
        });
        this.page.on('requestfailed', (req: any) => {
          try {
            const t = `${req.method?.() ?? ''} ${req.url?.() ?? ''} — ${req.failure?.()?.errorText ?? 'failed'}`.slice(0, 300);
            this.pushLog(`[requestfailed] ${t}`);
          } catch { /* ignore */ }
        });
      } catch { /* event wiring is best-effort */ }
      logger.info('Browser session launched (headless → Bubbly Preview)');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Failed to launch browser: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private pushError(msg: string): void {
    this.consoleErrors.push(msg);
    if (this.consoleErrors.length > 50) this.consoleErrors = this.consoleErrors.slice(-50);
  }

  private pushLog(msg: string): void {
    this.consoleLog.push(msg);
    if (this.consoleLog.length > 200) this.consoleLog = this.consoleLog.slice(-200);
  }

  private async moveCursorTo(x: number, y: number): Promise<void> {
    try { await this.page.evaluate(`window.__bubblyMoveCursor && window.__bubblyMoveCursor(${Number(x)}, ${Number(y)})`); } catch { /* ignore */ }
    try { await this.page.mouse.move(x, y); } catch { /* ignore */ }
    await this.page.waitForTimeout?.(120);
  }

  /**
   * Capture the current page as a PNG frame. Called after every action so the
   * docked Bubbly Preview reflects each thing the agent does — the user always
   * sees the latest state, not a black box.
   */
  private async captureFrame(): Promise<string | undefined> {
    try {
      const file = path.join(os.tmpdir(), `bubbly_browser_${Date.now()}.png`);
      await this.page.screenshot({ path: file });
      return file;
    } catch { return undefined; }
  }

  async run(action: BrowserAction, p: BrowserActionParams): Promise<{ ok: boolean; result: string; screenshotPath?: string }> {
    if (action === 'close') {
      await this.close();
      return { ok: true, result: 'Browser closed.' };
    }
    const ready = await this.ensure();
    if (!ready.ok) return { ok: false, result: ready.error };

    try {
      switch (action) {
        case 'open':
        case 'goto': {
          this.consoleErrors = []; this.consoleLog = []; // fresh page → fresh logs
          await this.page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          return { ok: true, result: `Navigated to ${p.url} — ${await this.page.title()}`, screenshotPath: await this.captureFrame() };
        }
        case 'reload': {
          await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          return { ok: true, result: `Reloaded — ${await this.page.title()}`, screenshotPath: await this.captureFrame() };
        }
        case 'wait': {
          if (p.selector) {
            await this.page.waitForSelector(p.selector, { timeout: p.amount ?? 10000 }).catch(() => {});
          } else {
            await this.page.waitForTimeout?.(p.amount ?? 1000);
          }
          return { ok: true, result: p.selector ? `Waited for "${p.selector}".` : `Waited ${p.amount ?? 1000}ms.`, screenshotPath: await this.captureFrame() };
        }
        case 'back': { await this.page.goBack({ timeout: 15000 }).catch(() => {}); return { ok: true, result: `Back → ${await this.page.title()}`, screenshotPath: await this.captureFrame() }; }
        case 'forward': { await this.page.goForward({ timeout: 15000 }).catch(() => {}); return { ok: true, result: `Forward → ${await this.page.title()}`, screenshotPath: await this.captureFrame() }; }
        case 'click': {
          if (p.x != null && p.y != null) {
            await this.moveCursorTo(p.x, p.y);
            await this.page.mouse.click(p.x, p.y);
            return { ok: true, result: `Clicked at (${p.x}, ${p.y}).`, screenshotPath: await this.captureFrame() };
          }
          const outcome = await this.resolveAndClick(p.selector, p.text);
          return { ok: outcome.ok, result: outcome.result, screenshotPath: await this.captureFrame() };
        }
        case 'type': {
          if (p.selector) {
            await this.page.locator(p.selector).first().fill(p.text!, { timeout: 10000 });
          } else {
            // No selector: prefer the focused field, else the first visible
            // text input, so `type` doesn't silently drop keystrokes.
            const active = this.page.locator(':focus');
            if (await active.count().catch(() => 0)) {
              await active.first().fill(p.text!, { timeout: 5000 }).catch(async () => { await this.page.keyboard.type(p.text!, { delay: 12 }); });
            } else {
              const field = this.page.locator('input:not([type=hidden]), textarea, [contenteditable="true"]').first();
              if (await field.count().catch(() => 0)) await field.fill(p.text!, { timeout: 5000 });
              else await this.page.keyboard.type(p.text!, { delay: 12 });
            }
          }
          return { ok: true, result: `Typed ${p.text!.length} char(s).`, screenshotPath: await this.captureFrame() };
        }
        case 'press': { await this.page.keyboard.press(p.key!); return { ok: true, result: `Pressed ${p.key}.`, screenshotPath: await this.captureFrame() }; }
        case 'scroll': { await this.page.mouse.wheel(0, p.amount!); return { ok: true, result: `Scrolled ${p.amount}px.`, screenshotPath: await this.captureFrame() }; }
        case 'screenshot': {
          const file = await this.captureFrame();
          return { ok: true, result: `Screenshot saved at ${file} (${await this.page.title()} — ${this.page.url()})`, screenshotPath: file };
        }
        case 'snapshot': {
          const snap: any = await this.page.evaluate(SNAPSHOT_JS);
          return { ok: true, result: formatSnapshot(snap, this.consoleErrors) };
        }
        case 'console': {
          const log = this.consoleLog.slice(-80);
          return { ok: true, result: log.length ? `Console log (${log.length} recent entries):\n${log.join('\n')}` : 'Console is empty (no logs, warnings, errors, or failed requests since the last navigation).' };
        }
        case 'viewport': {
          await this.page.setViewportSize({ width: p.width!, height: p.height! });
          const label = p.preset ? `${p.preset} (${p.width}x${p.height})` : `${p.width}x${p.height}`;
          return { ok: true, result: `Viewport set to ${label}.`, screenshotPath: await this.captureFrame() };
        }
        default:
          return { ok: false, result: `Unhandled action ${action}.` };
      }
    } catch (err) {
      return { ok: false, result: `Browser action "${action}" failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Multi-strategy click for the headless path. Targets the REAL clickable
   * element (role/exact-text/testid), not a wrapper, and escalates to a forced
   * / coordinate click if the normal one is intercepted — with an actionable
   * candidate list on failure so the model self-corrects instead of retrying.
   */
  private async resolveAndClick(selector?: string, text?: string): Promise<{ ok: boolean; result: string }> {
    const attempts: Array<{ how: string; locator: any }> = [];
    const P = this.page;
    if (selector) attempts.push({ how: 'selector', locator: P.locator(selector).first() });
    if (text) {
      const t = text.trim();
      // Prefer real interactive roles with an accessible name (exact, then loose).
      for (const role of ['button', 'link', 'tab', 'menuitem', 'option'] as const) {
        attempts.push({ how: `role=${role}`, locator: P.getByRole(role, { name: t, exact: true }).first() });
      }
      attempts.push({ how: 'testid', locator: P.getByTestId(t).first() });
      for (const role of ['button', 'link', 'tab', 'menuitem'] as const) {
        attempts.push({ how: `role~=${role}`, locator: P.getByRole(role, { name: t }).first() });
      }
      // Last resort: exact visible text, then substring — scoped to a clickable
      // ancestor so we don't click a layout wrapper.
      attempts.push({ how: 'text=exact', locator: P.getByText(t, { exact: true }).first() });
      attempts.push({ how: 'text~=', locator: P.getByText(t, { exact: false }).first() });
    }

    for (const { how, locator } of attempts) {
      try {
        if (!(await locator.count())) continue;
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        const box = await locator.boundingBox().catch(() => null);
        if (box) await this.moveCursorTo(box.x + box.width / 2, box.y + box.height / 2);
        try {
          await locator.click({ timeout: 4000 });
        } catch {
          // Intercepted / not actionable → force, then coordinate click.
          try { await locator.click({ timeout: 2000, force: true }); }
          catch {
            if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            else throw new Error('not clickable');
          }
        }
        return { ok: true, result: `Clicked (${how}) ${selector ? `"${selector}"` : `"${text}"`}.` };
      } catch {
        /* try next strategy */
      }
    }

    // Nothing worked — hand the model the closest candidates so it can pick one.
    let candidates = '';
    if (text) {
      try {
        // Authored as a string (not a typed callback) so the backend tsconfig
        // doesn't try to type-check browser globals.
        const js = `(() => {
          const norm = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim();
          const t = ${JSON.stringify(text.trim())}.toLowerCase();
          const els = Array.from(document.querySelectorAll('a[href],button,[role=button],[role=link],[role=tab],input,select,textarea'));
          return els.map((el) => {
            const lbl = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
            const score = lbl === t ? 3 : (lbl.includes(t) || t.includes(lbl)) ? 2 : 0;
            return { tag: el.tagName.toLowerCase(), lbl: lbl.slice(0, 50), score };
          }).filter((c) => c.score > 0 && c.lbl).sort((a, b) => b.score - a.score).slice(0, 5).map((c) => c.tag + ' "' + c.lbl + '"');
        })()`;
        const list: string[] = await this.page.evaluate(js);
        if (list.length) candidates = ` Closest matches — click one of these by text: ${list.join(' · ')}`;
      } catch { /* best-effort */ }
    }
    return { ok: false, result: `Could not click ${selector ? `"${selector}"` : `"${text}"`}.${candidates}` };
  }

  async close(): Promise<void> {
    try { await this.context?.close(); } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.page = null; this.context = null; this.browser = null;
  }
}

const session = new BrowserSession();

export async function runBrowserAction(
  action: BrowserAction,
  params: BrowserActionParams
): Promise<{ ok: boolean; result: string; screenshotPath?: string }> {
  // Stage 1 — prefer driving the LIVE Bubbly Preview webview the user is
  // watching, so the agent's navigation/clicks/typing happen in the same
  // browser on screen. Only routed here when a client has TRUTHFULLY reported a
  // scriptable webview (not merely a connected socket).
  if (isPreviewClientAvailable()) {
    const r = await runPreviewAction(action, params as Record<string, unknown>);
    // A REAL page result (found/not-found/navigated/failed) — return it as-is.
    if (!r.transportFailed) {
      return { ok: r.ok, result: r.result, screenshotPath: r.screenshotPath };
    }
    // Transport failure (panel closed, window switched, webview crashed, timed
    // out, disconnected): DON'T surface a fake page error and DON'T stall —
    // fall through to the headless browser deterministically.
    logger.warn('Preview transport failed — falling back to headless browser', { action, detail: r.result });
  }

  // Stage 2 — headless Playwright fallback.
  //  - If we've NEVER seen a capable preview client (cold headless/CLI env), the
  //    global "Allow browser control" toggle is the gate.
  //  - If the preview WAS available and just failed in transit, the per-project
  //    browser-meta.json (already checked by the caller) is sufficient consent —
  //    the agent should never be dead-ended with "open the window" mid-task.
  if (!isBrowserControlEnabled() && !hasEverSeenCapableClient()) {
    return { ok: false, result: 'Open the Bubbly window so the agent can drive the Bubbly Preview browser — or enable Settings → Safety ("Allow browser control") to use a headless browser instead.' };
  }
  const r = await session.run(action, params);
  return {
    ok: r.ok,
    result: hasEverSeenCapableClient()
      ? `${r.result}\n(Ran in the fallback headless browser — the Bubbly Preview webview was not responding. This is a separate browser, so its page/cookies/scroll may differ from what you last saw.)`
      : r.result,
    screenshotPath: r.screenshotPath,
  };
}

/** Close the browser on shutdown. */
export function closeBrowserSession(): void {
  void session.close();
}
