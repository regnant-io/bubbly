/**
 * Preview target resolution — deciding WHERE the preview is allowed to point.
 *
 * This module exists because of a specific, embarrassing failure: pressing Start
 * showed BUBBLY ITSELF inside the preview. The cause was that a preview URL was
 * never verified — it was a convention guess (`http://localhost:3000`, "Vite is
 * always 5173") written into the project's run config and then navigated to. If
 * something else on the machine happened to own that port — Docker, another
 * project, or Bubbly's own dev server — that is simply what the user saw, with
 * no error anywhere, because from the browser's point of view the page loaded
 * fine.
 *
 * v3 replaces guessing with three checks, in order of trust:
 *
 *   1. OWNERSHIP  — the port is actually bound by the process WE started (or one
 *                   of its children). Resolved from the OS, not from convention.
 *   2. LIVENESS   — something answers an HTTP request there right now.
 *   3. IDENTITY   — whatever answered is not Bubbly. This is a hard refusal, not
 *                   a warning: previewing Bubbly inside Bubbly is never correct
 *                   and is the exact bug this file was written to kill.
 *
 * A URL that fails any of these is not navigated to. The user gets "starting…"
 * or a precise reason, never a plausible-looking wrong page.
 */

import { execFile } from 'child_process';
import http from 'http';
import https from 'https';
import { logger } from '../../utils/logger';

/** Header Bubbly's own HTTP server stamps on every response (see index.ts). */
export const SELF_HEADER = 'x-bubbly-backend';

/** How the preview URL came to be known. Only some of these may be navigated. */
export type UrlSource =
  /** The dev server printed it on startup. Highest trust. */
  | 'detected'
  /** The port is bound by our own process tree, confirmed against the OS. */
  | 'owned'
  /** A human or the agent wrote it into the run config deliberately. */
  | 'configured'
  /** Framework convention (Vite → 5173). A STARTING POINT, never navigable. */
  | 'guess';

/** Sources we are willing to put in front of the user. `guess` is not one. */
export const NAVIGABLE_SOURCES: ReadonlySet<UrlSource> = new Set<UrlSource>(['detected', 'owned', 'configured']);

export function isNavigableSource(source: UrlSource | undefined | null): boolean {
  return !!source && NAVIGABLE_SOURCES.has(source);
}

// --- Self-origin registry ---------------------------------------------------
// Every address Bubbly itself answers on. Navigating the preview to any of these
// embeds the app in its own window.

const selfPorts = new Set<number>();

/** Record the port this backend bound. Called once the server is listening. */
export function registerSelfPort(port: number): void {
  if (Number.isInteger(port) && port > 0) {
    selfPorts.add(port);
    logger.info('Registered Bubbly self-origin port (preview will refuse it)', { port });
  }
}

/** Ports Bubbly answers on: the live one, plus anything configured for dev. */
export function getSelfPorts(): number[] {
  const fromEnv = [process.env.PORT, process.env.BUBBLY_DESKTOP_PORT, process.env.FRONTEND_PORT]
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set([...selfPorts, ...fromEnv]));
}

function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * True when this URL is Bubbly's own UI. Checked on port alone (cheap, sync);
 * the HTTP probe below also catches it by header for cases we can't enumerate,
 * such as a Vite dev server on a random port proxying to us.
 */
export function isSelfOrigin(url: string): boolean {
  if (!isLoopback(url)) return false;
  const p = portOf(url);
  return p != null && getSelfPorts().includes(p);
}

// --- OS-level port ownership ------------------------------------------------

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err && !stdout ? '' : String(stdout ?? ''));
      });
    } catch {
      resolve('');
    }
  });
}

/** Every descendant pid of `root`, inclusive. Best-effort; [] on failure. */
async function processTree(root: number): Promise<number[]> {
  if (process.platform === 'win32') {
    // One CIM call, then walk the parent→child edges ourselves. Cheaper and
    // far more reliable than recursive `wmic` (which is deprecated/removed).
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
    ], 6000);
    const edges = new Map<number, number[]>();
    for (const line of out.split(/\r?\n/).slice(1)) {
      const m = line.match(/^"?(\d+)"?,"?(\d+)"?/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!edges.has(ppid)) edges.set(ppid, []);
      edges.get(ppid)!.push(pid);
    }
    const seen = new Set<number>([root]);
    const queue = [root];
    while (queue.length) {
      for (const child of edges.get(queue.shift()!) ?? []) {
        if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
    return Array.from(seen);
  }

  const out = await run('ps', ['-eo', 'pid=,ppid=']);
  const edges = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [, pid, ppid] = m;
    if (!edges.has(Number(ppid))) edges.set(Number(ppid), []);
    edges.get(Number(ppid))!.push(Number(pid));
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of edges.get(queue.shift()!) ?? []) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return Array.from(seen);
}

/**
 * TCP ports in LISTEN state owned by `pid` or any of its descendants.
 *
 * This is what makes "owned" trustworthy. A dev server that never prints a URL
 * (or prints one we can't parse) still tells the truth through the OS: whatever
 * it bound is what the preview should open. Convention-based ports can be off
 * by one whenever the default is already taken — Vite silently steps 5173 →
 * 5174 and the old code would happily show you whoever kept 5173.
 */
export async function listeningPortsForProcess(pid: number): Promise<number[]> {
  if (!pid) return [];
  const tree = new Set(await processTree(pid));
  const ports = new Set<number>();

  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && tree.has(Number(m[2]))) ports.add(Number(m[1]));
    }
  } else {
    const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    let current = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1));
      else if (line.startsWith('n') && tree.has(current)) {
        const m = line.match(/:(\d+)$/);
        if (m) ports.add(Number(m[1]));
      }
    }
  }

  const found = Array.from(ports).filter((p) => !getSelfPorts().includes(p));
  logger.debug('Resolved listening ports for process tree', { pid, treeSize: tree.size, ports: found });
  return found;
}

// --- Liveness + identity probe ----------------------------------------------

export interface ProbeResult {
  /** Something answered an HTTP request. */
  alive: boolean;
  status?: number;
  /** The responder is Bubbly itself — this URL must never be previewed. */
  isSelf: boolean;
  error?: string;
}

/**
 * Ask the URL whether it is (a) up and (b) not us. Deliberately cheap: a single
 * GET with a short timeout, body discarded. Any HTTP status counts as alive —
 * a dev server returning 404 for `/` is still a running dev server.
 */
export function probeUrl(url: string, timeoutMs = 2500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let guard: NodeJS.Timeout | null = null;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      resolve(r);
    };

    // Port-level self-check first — no need to touch the network for a URL we
    // already know is ours.
    if (isSelfOrigin(url)) return done({ alive: true, isSelf: true });

    let req: http.ClientRequest;
    try {
      const lib = url.startsWith('https:') ? https : http;
      req = lib.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'Bubbly-Preview-Probe' } }, (res) => {
        const isSelf = String(res.headers[SELF_HEADER] ?? '') !== '';
        res.resume(); // drain; we only wanted the headers
        done({ alive: true, status: res.statusCode, isSelf });
      });
    } catch (err) {
      return done({ alive: false, isSelf: false, error: err instanceof Error ? err.message : String(err) });
    }

    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } done({ alive: false, isSelf: false, error: 'timed out' }); });
    req.on('error', (err) => done({ alive: false, isSelf: false, error: err.message }));
    // Belt-and-braces: `timeout` only fires on socket inactivity, so a server
    // that accepts and then dribbles could still hang us. unref'd so this timer
    // never by itself keeps the process (or a test run) alive.
    guard = setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      done({ alive: false, isSelf: false, error: 'timed out' });
    }, timeoutMs + 250);
    guard.unref?.();
  });
}

export interface ResolvedTarget {
  url: string | null;
  source: UrlSource | null;
  /** Why there is no url, when there isn't one. Shown to the user verbatim. */
  reason?: string;
}

/**
 * Work out the one URL the preview should open for a just-started server.
 *
 * Order of preference: what the server printed, then what the OS says it bound,
 * then an explicitly configured URL. A convention guess is never returned — if
 * we get to the end without evidence, we say so instead of picking a port and
 * hoping. "Not ready yet" is a much better answer than someone else's app.
 */
export async function resolvePreviewTarget(opts: {
  detectedUrl?: string | null;
  pid?: number | null;
  configuredUrl?: string | null;
}): Promise<ResolvedTarget> {
  const { detectedUrl, pid, configuredUrl } = opts;

  // 1. The server told us. Trust it, but still refuse if it somehow points at us.
  if (detectedUrl) {
    const probe = await probeUrl(detectedUrl);
    if (probe.isSelf) {
      return { url: null, source: null, reason: `The dev server reported ${detectedUrl}, but that address is Bubbly itself — refusing to preview Bubbly inside Bubbly. Change the project's dev-server port.` };
    }
    if (probe.alive) return { url: detectedUrl, source: 'detected' };
    // Printed but not answering yet — it is still booting. Fall through to the
    // OS check rather than declaring a URL that will show a connection error.
  }

  // 2. Ask the OS which port our own process actually bound.
  if (pid) {
    for (const port of await listeningPortsForProcess(pid)) {
      const candidate = `http://localhost:${port}`;
      const probe = await probeUrl(candidate);
      if (probe.alive && !probe.isSelf) return { url: candidate, source: 'owned' };
    }
  }

  // 3. An explicitly authored URL — only if something is actually there.
  if (configuredUrl) {
    const probe = await probeUrl(configuredUrl);
    if (probe.isSelf) {
      return { url: null, source: null, reason: `The configured preview URL ${configuredUrl} is Bubbly's own address. Fix previewUrl in the run config — it must point at the project's dev server.` };
    }
    if (probe.alive) return { url: configuredUrl, source: 'configured' };
  }

  return {
    url: null,
    source: null,
    reason: detectedUrl
      ? `${detectedUrl} was reported but is not responding yet.`
      : 'The dev server has not reported an address yet, and no port is bound by it. Give it a moment, or check its output for errors.',
  };
}
