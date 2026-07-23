/**
 * Watchers — how the agent waits for slow things WITHOUT burning tokens.
 *
 * The problem this solves: an agent that starts a 6-minute build and wants to
 * know when it finishes has, until now, only one move — call get_process_output,
 * see "still running", call it again, and again. Every one of those polls is a
 * full model round-trip: the entire conversation re-sent, re-processed, billed.
 * Waiting for a build could cost more than writing the code did.
 *
 * A watcher moves the waiting into the backend, where waiting is free. The agent
 * says "tell me when the build finishes" ONCE. The watcher settles the moment
 * the condition is met — via a process event where possible, or adaptive polling
 * where it must — and the agent is told once, with the outcome.
 *
 * Two ways to use one:
 *
 *   BLOCKING (the default, and almost always what you want): the tool call does
 *   not return until the condition is met or the deadline passes. One call, one
 *   result, zero polls. The agent is parked, not spinning.
 *
 *   DETACHED: the watcher is registered and the agent moves on to other work.
 *   When it settles, the result is queued. The agent collects it later — and
 *   crucially the result SURVIVES the run that created it, so a watcher whose
 *   build finished after the agent stopped still has its answer waiting.
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import { backgroundProcesses, type ProcessEvent } from './backgroundProcess';

/** What a watcher is waiting for. */
export type WatchCondition =
  | { kind: 'process_exit'; processId: string }
  | { kind: 'output_match'; processId: string; pattern: string }
  | { kind: 'url_live'; url: string }
  | { kind: 'port_open'; port: number; host?: string }
  | { kind: 'file_exists'; path: string };

export type WatchOutcome = 'met' | 'timeout' | 'failed' | 'cancelled';

export interface WatchResult {
  id: string;
  outcome: WatchOutcome;
  /** Human-readable summary, written for the agent to act on directly. */
  detail: string;
  waitedMs: number;
  /** Tail of relevant process output, when the condition involved a process. */
  output?: string;
  exitCode?: number | null;
}

interface Watcher {
  id: string;
  label: string;
  condition: WatchCondition;
  createdAt: number;
  deadlineAt: number;
  settled: boolean;
  result: WatchResult | null;
  /** Everything that must be torn down when this watcher settles. */
  cleanup: Array<() => void>;
  /** Resolvers parked on this watcher (blocking waiters). */
  waiters: Array<(r: WatchResult) => void>;
  /** True once the result has been handed to the agent, so it isn't re-reported. */
  delivered: boolean;
}

const MAX_TIMEOUT_MS = 30 * 60_000; // 30 min — a long build, not an eternity
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Poll intervals back off so a 20-minute wait doesn't spin the CPU, while a
 *  2-second wait still feels instant. */
const POLL_START_MS = 250;
const POLL_MAX_MS = 5_000;
const POLL_GROWTH = 1.5;

function tail(s: string, n = 1200): string {
  return s.length <= n ? s : `…\n${s.slice(s.length - n)}`;
}

class WatcherManager {
  private watchers = new Map<string, Watcher>();
  /** Notified whenever a watcher settles — used to surface it in the UI. */
  private onSettle: ((w: WatchResult & { label: string }) => void) | null = null;

  setSettleListener(fn: ((w: WatchResult & { label: string }) => void) | null): void {
    this.onSettle = fn;
  }

  /** Create a watcher. It begins observing IMMEDIATELY, whether or not anyone
   *  is awaiting it, so a detached watcher can settle while the agent works. */
  create(condition: WatchCondition, opts: { label?: string; timeoutMs?: number } = {}):
    { ok: true; id: string } | { ok: false; error: string } {
    const check = this.validate(condition);
    if (!check.ok) return check;

    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const id = `watch_${uuidv4().slice(0, 8)}`;
    const w: Watcher = {
      id,
      label: opts.label || describeCondition(condition),
      condition,
      createdAt: Date.now(),
      deadlineAt: Date.now() + timeoutMs,
      settled: false,
      result: null,
      cleanup: [],
      waiters: [],
      delivered: false,
    };
    this.watchers.set(id, w);

    // Hard deadline. Always armed, for every condition kind — this is the
    // guarantee that a watcher can never hang the agent forever.
    const deadline = setTimeout(() => {
      this.settle(w, {
        id, outcome: 'timeout', waitedMs: Date.now() - w.createdAt,
        detail: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${w.label}. It may still be running — check on it, or watch again with a longer timeout.`,
        ...this.processSnapshot(condition),
      });
    }, timeoutMs);
    w.cleanup.push(() => clearTimeout(deadline));

    this.arm(w);
    logger.info('Watcher created', { id, label: w.label, kind: condition.kind, timeoutMs });
    return { ok: true, id };
  }

  /** Reject conditions we can prove are unsatisfiable, so the agent finds out
   *  now rather than after a 5-minute timeout. */
  private validate(c: WatchCondition): { ok: true; id: string } | { ok: false; error: string } {
    if (c.kind === 'process_exit' || c.kind === 'output_match') {
      if (!backgroundProcesses.getInfo(c.processId)) {
        return { ok: false, error: `No background process with id ${c.processId}. Start one with run_background first, or list_processes to see live ids.` };
      }
    }
    if (c.kind === 'output_match') {
      try { new RegExp(c.pattern, 'i'); }
      catch { return { ok: false, error: `Invalid regex pattern: ${c.pattern}` }; }
    }
    if (c.kind === 'url_live') {
      if (!/^https?:\/\//i.test(c.url)) return { ok: false, error: `url must start with http:// or https:// (got "${c.url}")` };
    }
    if (c.kind === 'port_open') {
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return { ok: false, error: `port must be 1–65535 (got ${c.port})` };
    }
    return { ok: true, id: '' };
  }

  /** Start observing. Process conditions subscribe (instant); the rest poll. */
  private arm(w: Watcher): void {
    const c = w.condition;

    if (c.kind === 'process_exit' || c.kind === 'output_match') {
      // Capture the pattern as a plain string: TS can't re-narrow `c` from the
      // nullness of `re` inside the callbacks below.
      const patternSrc = c.kind === 'output_match' ? c.pattern : null;
      const re = patternSrc != null ? new RegExp(patternSrc, 'i') : null;

      // Check what has ALREADY happened before subscribing — the build may have
      // finished, or the pattern already printed, while the agent was thinking.
      // Without this the watcher would wait for an event that already fired.
      const existing = backgroundProcesses.getOutput(c.processId, { full: true });
      if (re && existing.ok && existing.output && re.test(existing.output)) {
        this.settle(w, this.metResult(w, `Pattern /${patternSrc}/ already present in ${c.processId} output.`));
        return;
      }
      if (c.kind === 'process_exit' && existing.ok && existing.status !== 'running') {
        this.settle(w, this.metResult(w, `Process ${c.processId} had already exited (code ${existing.exitCode ?? 0}).`));
        return;
      }

      const unsub = backgroundProcesses.subscribe(c.processId, (ev: ProcessEvent) => {
        if (w.settled) return;
        if (c.kind === 'process_exit' && ev.type === 'exit') {
          this.settle(w, this.metResult(w, `Process ${c.processId} exited with code ${ev.exitCode ?? 0}.`));
          return;
        }
        if (re && ev.type === 'output' && re.test(ev.output)) {
          this.settle(w, this.metResult(w, `Pattern /${patternSrc}/ matched in ${c.processId} output.`));
          return;
        }
        // A process that dies without ever printing the pattern would otherwise
        // hang until the deadline; report the real reason instead.
        if (re && ev.type === 'exit') {
          this.settle(w, {
            id: w.id, outcome: 'failed', waitedMs: Date.now() - w.createdAt,
            detail: `Process ${c.processId} exited (code ${ev.exitCode ?? 0}) WITHOUT ever printing /${patternSrc}/. It likely failed to start.`,
            ...this.processSnapshot(c),
          });
        }
      });
      w.cleanup.push(unsub);
      return;
    }

    // Polled conditions: url_live / port_open / file_exists.
    let interval = POLL_START_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      if (stopped || w.settled) return;
      let hit = false;
      let note = '';
      try {
        if (c.kind === 'url_live') {
          const r = await probeUrl(c.url);
          hit = r.ok;
          note = r.detail;
        } else if (c.kind === 'port_open') {
          hit = await probePort(c.host ?? '127.0.0.1', c.port);
          note = `Port ${c.port} is accepting connections.`;
        } else if (c.kind === 'file_exists') {
          hit = fs.existsSync(c.path);
          note = `${c.path} now exists.`;
        }
      } catch { /* a probe failure just means "not yet" */ }

      if (hit) { this.settle(w, this.metResult(w, note)); return; }
      if (stopped || w.settled) return;
      interval = Math.min(Math.round(interval * POLL_GROWTH), POLL_MAX_MS);
      timer = setTimeout(poll, interval);
    };
    w.cleanup.push(() => { stopped = true; if (timer) clearTimeout(timer); });
    void poll();
  }

  private metResult(w: Watcher, detail: string): WatchResult {
    return {
      id: w.id, outcome: 'met', detail, waitedMs: Date.now() - w.createdAt,
      ...this.processSnapshot(w.condition),
    };
  }

  /** Attach recent process output so the agent gets the ANSWER, not just a
   *  "done" — this is what saves the follow-up get_process_output round-trip. */
  private processSnapshot(c: WatchCondition): { output?: string; exitCode?: number | null } {
    if (c.kind !== 'process_exit' && c.kind !== 'output_match') return {};
    const r = backgroundProcesses.getOutput(c.processId, { full: true });
    if (!r.ok) return {};
    return { output: tail(r.output ?? ''), exitCode: r.exitCode ?? null };
  }

  private settle(w: Watcher, result: WatchResult): void {
    if (w.settled) return;
    w.settled = true;
    w.result = result;
    for (const fn of w.cleanup) { try { fn(); } catch { /* teardown is best-effort */ } }
    w.cleanup = [];
    logger.info('Watcher settled', { id: w.id, outcome: result.outcome, waitedMs: result.waitedMs });
    for (const resolve of w.waiters) resolve(result);
    w.waiters = [];
    try { this.onSettle?.({ ...result, label: w.label }); } catch { /* UI notify is best-effort */ }
  }

  /** Park until this watcher settles. Returns immediately if it already has. */
  wait(id: string): Promise<WatchResult> | null {
    const w = this.watchers.get(id);
    if (!w) return null;
    if (w.settled && w.result) { w.delivered = true; return Promise.resolve(w.result); }
    return new Promise<WatchResult>((resolve) => {
      w.waiters.push((r) => { w.delivered = true; resolve(r); });
    });
  }

  get(id: string): Watcher | undefined { return this.watchers.get(id); }

  /** Watchers that have settled but whose result the agent hasn't seen yet.
   *  This is what lets a watcher report a build that finished after the run
   *  that started it had already stopped. */
  collectUndelivered(): Array<WatchResult & { label: string }> {
    const out: Array<WatchResult & { label: string }> = [];
    for (const w of this.watchers.values()) {
      if (w.settled && w.result && !w.delivered) {
        w.delivered = true;
        out.push({ ...w.result, label: w.label });
      }
    }
    return out;
  }

  list(): Array<{ id: string; label: string; kind: string; settled: boolean; outcome?: WatchOutcome; ageMs: number }> {
    return [...this.watchers.values()].map((w) => ({
      id: w.id, label: w.label, kind: w.condition.kind,
      settled: w.settled, outcome: w.result?.outcome, ageMs: Date.now() - w.createdAt,
    }));
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const w = this.watchers.get(id);
    if (!w) return { ok: false, error: `No watcher with id ${id}.` };
    if (w.settled) return { ok: true };
    this.settle(w, { id, outcome: 'cancelled', detail: 'Watcher cancelled.', waitedMs: Date.now() - w.createdAt });
    return { ok: true };
  }

  /** Drop settled watchers that have been delivered, so a long session doesn't
   *  accumulate them. Live watchers are never touched. */
  prune(): void {
    for (const [id, w] of this.watchers) {
      if (w.settled && w.delivered) this.watchers.delete(id);
    }
  }

  /** Test/shutdown hook: settle and clear everything. */
  cancelAll(): void {
    for (const w of this.watchers.values()) {
      if (!w.settled) this.cancel(w.id);
      else for (const fn of w.cleanup) { try { fn(); } catch { /* ignore */ } }
    }
    this.watchers.clear();
  }
}

export function describeCondition(c: WatchCondition): string {
  switch (c.kind) {
    case 'process_exit': return `process ${c.processId} to exit`;
    case 'output_match': return `/${c.pattern}/ in ${c.processId} output`;
    case 'url_live': return `${c.url} to respond`;
    case 'port_open': return `port ${c.port} to open`;
    case 'file_exists': return `${path.basename(c.path)} to exist`;
  }
}

/** Is the URL serving yet? Any HTTP response counts as "up" — a dev server
 *  returning 404 on / is still a server that has finished booting, which is the
 *  thing being waited for. */
async function probeUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { ok: true, detail: `${url} responded with HTTP ${res.status}.` };
  } catch {
    return { ok: false, detail: '' };
  } finally {
    clearTimeout(t);
  }
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(v); };
    sock.setTimeout(2_000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

export const watchers = new WatcherManager();
