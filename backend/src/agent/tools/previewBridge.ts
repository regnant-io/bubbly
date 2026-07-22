/**
 * Preview Bridge — lets the backend agent drive the LIVE Bubbly Preview webview
 * that the user is watching (in the Electron renderer), instead of a separate
 * headless browser. This is what makes browser_control's clicks/typing appear
 * in the same browser the user sees.
 *
 * Flow: browser_control → runPreviewAction() emits a `preview_control` event to
 * a CAPABLE client, then awaits a `preview_result` message the client sends back
 * after running the action against the webview. A screenshot comes back as a
 * base64 data URL, decoded to a temp PNG so the vision path works exactly like
 * the Playwright path.
 *
 * RELIABILITY CONTRACT (this is the token-burn-prevention layer):
 *  - `isPreviewClientAvailable()` is TRUTHFUL: it is only true when a connected
 *    client has ACTUALLY reported (via `preview_ready`) that it has a live,
 *    scriptable webview and its heartbeat is fresh. A merely-connected WS client
 *    is not enough. This lets runBrowserAction decide reliably whether to use
 *    the preview or fall straight to the headless browser.
 *  - Multiple clients are tracked; a stale socket closing can NEVER disable a
 *    healthy live client (the old single-global-emitter bug).
 *  - When a client disconnects, its in-flight actions resolve IMMEDIATELY with
 *    `transportFailed` — no 30s-per-orphan stall.
 *  - Timeouts are PER ACTION (a `press` fails fast; a `goto` gets longer), and
 *    a timeout / disconnect / not-capable reply is flagged `transportFailed` so
 *    the caller can fall back to Playwright instead of surfacing a fake failure.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';

export interface PreviewActionResult {
  ok: boolean;
  result: string;
  /** Absolute path to a decoded screenshot PNG, if the action returned one. */
  screenshotPath?: string;
  /** Current URL of the webview, if reported. */
  url?: string;
  /**
   * True when the action could NOT be delivered/executed by the preview client
   * (no capable client, disconnect mid-flight, timeout, or the renderer reported
   * it has no scriptable webview). The caller should fall back to the headless
   * browser rather than treat this as a real page error.
   */
  transportFailed?: boolean;
}

type Emitter = (event: { type: 'preview_control'; id: string; action: string; params: Record<string, unknown> }) => void;

interface PreviewClient {
  id: string;
  emit: Emitter;
  /** The renderer has a live, scriptable webview right now. */
  capable: boolean;
  /** Desktop Electron (real webview) vs. plain-browser build (iframe, view-only). */
  desktop: boolean;
  hasWebview: boolean;
  url: string | null;
  /** Last heartbeat / readiness report. */
  lastSeen: number;
}

const clients = new Map<string, PreviewClient>();

/** Any client that has ever advertised readiness, even if stale now — used to
 *  distinguish "no desktop app at all" (cold headless env) from "the window was
 *  here a moment ago". */
let sawCapableClientEver = false;

/** How long a readiness heartbeat is trusted before the client is considered gone. */
const HEARTBEAT_TTL_MS = 15000;

export function registerPreviewClient(id: string, emit: Emitter): void {
  clients.set(id, {
    id,
    emit,
    // Unknown until the renderer sends preview_ready. Assume NOT capable so we
    // never route to a client that can't actually drive a webview.
    capable: false,
    desktop: false,
    hasWebview: false,
    url: null,
    lastSeen: Date.now(),
  });
  logger.debug('Preview client registered', { id, clients: clients.size });
}

export function unregisterPreviewClient(id: string): void {
  clients.delete(id);
  // Immediately resolve any in-flight actions that were sent to this client so
  // the agent isn't stalled for the full timeout on a disconnect/tab-close.
  const orphans = pendingByClient.get(id);
  if (orphans) {
    for (const actionId of orphans) {
      const p = pending.get(actionId);
      if (p) {
        pending.delete(actionId);
        clearTimeout(p.timer);
        p.resolve({ ok: false, transportFailed: true, result: 'The Bubbly window driving the preview disconnected mid-action.' });
      }
    }
    pendingByClient.delete(id);
  }
  logger.debug('Preview client unregistered', { id, clients: clients.size });
}

/** The renderer reports its live capability (on mount, readiness transitions,
 *  reconnect, and as a periodic heartbeat). */
export function setPreviewCapability(
  id: string,
  patch: { capable: boolean; desktop: boolean; hasWebview: boolean; url: string | null },
): void {
  const c = clients.get(id);
  if (!c) return;
  c.capable = patch.capable;
  c.desktop = patch.desktop;
  c.hasWebview = patch.hasWebview;
  c.url = patch.url;
  c.lastSeen = Date.now();
  if (patch.capable) sawCapableClientEver = true;
}

/** Pick the best client to drive: a fresh, capable client (can drive a webview
 *  right now — navigation works even before a page is loaded). Desktop preferred. */
function pickClient(): PreviewClient | null {
  const now = Date.now();
  let best: PreviewClient | null = null;
  for (const c of clients.values()) {
    if (!c.capable) continue;
    if (now - c.lastSeen > HEARTBEAT_TTL_MS) continue;
    if (
      !best ||
      (c.desktop && !best.desktop) ||
      (c.desktop === best.desktop && c.lastSeen > best.lastSeen)
    ) {
      best = c;
    }
  }
  return best;
}

/** True only when a client can ACTUALLY drive a live webview right now. */
export function isPreviewClientAvailable(): boolean {
  return !!pickClient();
}

/** Whether the desktop app with a webview has EVER been seen this process life.
 *  Used to decide whether the headless fallback is worth attempting silently. */
export function hasEverSeenCapableClient(): boolean {
  return sawCapableClientEver;
}

interface PendingEntry {
  resolve: (payload: { ok: boolean; result: string; image?: string; url?: string; transportFailed?: boolean }) => void;
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, PendingEntry>();
const pendingByClient = new Map<string, Set<string>>();

/** Called by the WS server when a `preview_result` message arrives. Returns
 *  false if the id is unknown (late/duplicate/after-timeout). */
export function resolvePreviewAction(
  id: string,
  payload: { ok: boolean; result: string; image?: string; url?: string; reason?: string },
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  pendingByClient.get(entry.clientId)?.delete(id);
  // A client that just answered is provably alive — refresh its heartbeat so an
  // actively-driven-but-idle-heartbeat client is never considered stale.
  const answering = clients.get(entry.clientId);
  if (answering) answering.lastSeen = Date.now();
  // A renderer that couldn't execute (no webview / no url / not capable) is a
  // transport failure, not a real page error — the caller should fall back.
  const transportFailed = payload.reason === 'not_capable' || payload.reason === 'no_webview' || payload.reason === 'no_url';
  entry.resolve({ ok: payload.ok, result: payload.result, image: payload.image, url: payload.url, transportFailed });
  return true;
}

function saveDataUrlPng(dataUrl: string): string | undefined {
  try {
    const m = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(dataUrl);
    const base64 = m ? m[2] : dataUrl;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0 || buf.length > 8_000_000) return undefined;
    const file = path.join(os.tmpdir(), `bubbly_preview_${Date.now()}.png`);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Per-action timeout budgets. A dead `press`/`scroll` fails in a few seconds
 * instead of stalling the whole agent loop for 30s; a `goto` or `screenshot`
 * gets the room it legitimately needs. `wait` is computed from its own amount.
 */
const ACTION_TIMEOUT_MS: Record<string, number> = {
  open: 20000, goto: 20000, reload: 20000,
  back: 12000, forward: 12000,
  click: 9000, type: 9000, press: 6000, scroll: 6000,
  viewport: 6000, snapshot: 12000, screenshot: 14000,
  console: 6000, close: 4000,
};

function timeoutFor(action: string, params: Record<string, unknown>): number {
  if (action === 'wait') {
    const amt = Number(params.amount ?? 1000);
    return Math.min(15000, Number.isFinite(amt) ? amt : 1000) + 6000;
  }
  return ACTION_TIMEOUT_MS[action] ?? 15000;
}

/**
 * Run an action against the live preview webview and await the result.
 * Never hangs: bounded per-action timeout, and a mid-flight disconnect resolves
 * immediately with `transportFailed` so the agent falls back rather than stalls.
 */
export async function runPreviewAction(
  action: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<PreviewActionResult> {
  const client = pickClient();
  if (!client) {
    return { ok: false, transportFailed: true, result: 'No Bubbly Preview client is available to drive the browser.' };
  }
  const id = uuidv4();
  const budget = timeoutMs ?? timeoutFor(action, params);

  const payload = await new Promise<{ ok: boolean; result: string; image?: string; url?: string; transportFailed?: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        pendingByClient.get(client.id)?.delete(id);
        resolve({ ok: false, transportFailed: true, result: `Preview action "${action}" timed out after ${budget}ms (the webview did not respond).` });
      }
    }, budget);

    pending.set(id, { resolve, clientId: client.id, timer });
    if (!pendingByClient.has(client.id)) pendingByClient.set(client.id, new Set());
    pendingByClient.get(client.id)!.add(id);

    try {
      client.emit({ type: 'preview_control', id, action, params });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      pendingByClient.get(client.id)?.delete(id);
      resolve({ ok: false, transportFailed: true, result: `Failed to send preview action: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  const screenshotPath = payload.image ? saveDataUrlPng(payload.image) : undefined;
  if (payload.image && !screenshotPath) logger.warn('Preview screenshot could not be decoded');
  return { ok: payload.ok, result: payload.result, screenshotPath, url: payload.url, transportFailed: payload.transportFailed };
}
