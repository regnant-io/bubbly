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

/**
 * What a watcher is waiting for.
 *
 * The polled conditions (url_live / port_open / file_exists) carry an OPTIONAL
 * `processId`: the background command that is supposed to make that condition
 * true. Supplying it is what turns a timer into an actual observation of the
 * command — see armPolled for why that matters so much.
 */
export type WatchCondition =
  | { kind: 'process_exit'; processId: string }
  | { kind: 'output_match'; processId: string; pattern: string }
  | { kind: 'url_live'; url: string; processId?: string }
  | { kind: 'port_open'; port: number; host?: string; processId?: string }
  | { kind: 'file_exists'; path: string; processId?: string };

/** The process a condition is (or can be) bound to, if any. */
function ownerProcessId(c: WatchCondition): string | undefined {
  return c.processId;
}

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
  /** The background command bound to a polled condition, once resolved. Kept so
   *  a timeout can report what that command was doing rather than only the clock. */
  owner: { id: string; command: string; inferred: boolean } | null;
  /** The thread that registered this watcher. Detached watchers use it to wake
   *  that thread back up when they settle — see the settle listener. */
  sessionId: string | null;
  /** True when the agent ended its turn instead of blocking on this. Only a
   *  detached watcher wakes a session: a blocking one already has someone
   *  parked on it who will get the result directly. */
  detached: boolean;
}

/** What a settled watcher reports to the world outside the agent loop. */
export type SettleNotice = WatchResult & {
  label: string;
  sessionId: string | null;
  detached: boolean;
};

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
  /** Notified whenever a watcher settles — used to surface it in the UI and to
   *  wake the thread that registered it. */
  private onSettle: ((w: SettleNotice) => void) | null = null;

  setSettleListener(fn: ((w: SettleNotice) => void) | null): void {
    this.onSettle = fn;
  }

  /** Create a watcher. It begins observing IMMEDIATELY, whether or not anyone
   *  is awaiting it, so a detached watcher can settle while the agent works. */
  create(condition: WatchCondition, opts: { label?: string; timeoutMs?: number; sessionId?: string; detached?: boolean } = {}):
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
      owner: null,
      sessionId: opts.sessionId ?? null,
      detached: opts.detached === true,
    };
    this.watchers.set(id, w);

    // Hard deadline. Always armed, for every condition kind — this is the
    // guarantee that a watcher can never hang the agent forever.
    const deadline = setTimeout(() => {
      this.settle(w, {
        id, outcome: 'timeout', waitedMs: Date.now() - w.createdAt,
        detail: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${w.label}.${this.ownerStateNote(w)}`,
        ...this.snapshotFor(w),
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
            ...this.snapshotFor(w),
          });
        }
      });
      w.cleanup.push(unsub);
      return;
    }

    this.armPolled(w);
  }

  /**
   * url_live / port_open / file_exists — conditions with no event to subscribe
   * to, so the positive signal has to be polled. The NEGATIVE signal does not.
   *
   * This used to be a pure timer, and that was the bug: "wait for
   * localhost:5173 to respond" knew nothing about the `npm run dev` that was
   * supposed to answer there. When that command died on startup — a port
   * already taken, a missing dependency, a syntax error in the config — the
   * watcher kept politely polling a port nobody would ever bind, for the full
   * timeout, and then reported "timed out waiting for the URL". Every word of
   * that was true and none of it was the answer: the command had exited with
   * code 1 four seconds in, and the reason was sitting in its output the whole
   * time.
   *
   * So we bind the watcher to the process that owes us the condition and watch
   * BOTH edges: poll for success, subscribe for the command's death. If the
   * command exits first, that is the answer, delivered in seconds with the exit
   * code and the error it printed — including when it never got far enough to
   * initialise at all.
   */
  private armPolled(w: Watcher): void {
    const c = w.condition;
    const owner = this.resolveOwner(w);
    w.owner = owner;

    // The command is already dead. Nothing is ever going to satisfy this.
    if (owner) {
      const info = backgroundProcesses.getInfo(owner.id);
      if (info && info.status !== 'running') {
        this.settle(w, this.deadOwnerResult(w, owner, info.exitCode ?? null));
        return;
      }
      const unsub = backgroundProcesses.subscribe(owner.id, (ev: ProcessEvent) => {
        if (w.settled || ev.type !== 'exit') return;
        // Poll once more before calling it: a server can print its banner, get
        // scraped, and be stopped in quick succession, and a condition that was
        // genuinely met should not be reported as a failure on a race.
        void this.probeOnce(c).then((hit) => {
          if (w.settled) return;
          if (hit.met) this.settle(w, this.metResult(w, hit.note));
          else this.settle(w, this.deadOwnerResult(w, owner, ev.exitCode ?? null));
        });
      });
      w.cleanup.push(unsub);
    }

    let interval = POLL_START_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      if (stopped || w.settled) return;
      const hit = await this.probeOnce(c);
      if (hit.met) { this.settle(w, this.metResult(w, hit.note)); return; }
      if (stopped || w.settled) return;
      interval = Math.min(Math.round(interval * POLL_GROWTH), POLL_MAX_MS);
      timer = setTimeout(poll, interval);
    };
    w.cleanup.push(() => { stopped = true; if (timer) clearTimeout(timer); });
    void poll();
  }

  /** One probe of a polled condition. A probe that throws just means "not yet". */
  private async probeOnce(c: WatchCondition): Promise<{ met: boolean; note: string }> {
    try {
      if (c.kind === 'url_live') {
        const r = await probeUrl(c.url);
        return { met: r.ok, note: r.detail };
      }
      if (c.kind === 'port_open') {
        const open = await probePort(c.host ?? '127.0.0.1', c.port);
        return { met: open, note: `Port ${c.port} is accepting connections.` };
      }
      if (c.kind === 'file_exists') {
        return { met: fs.existsSync(c.path), note: `${c.path} now exists.` };
      }
    } catch { /* not yet */ }
    return { met: false, note: '' };
  }

  /**
   * Which background command owes us this condition.
   *
   * An explicit processId always wins. Failing that, we auto-bind when exactly
   * ONE background process is running — in that situation there is no ambiguity
   * about who was meant to open the port, and refusing to guess would just
   * preserve the old silent-timeout behaviour for the overwhelmingly common
   * case (start a dev server, then wait for it). With two or more running we
   * bind to none: a wrong binding would blame the wrong command, which is worse
   * than a timeout. The binding is always named in the result so the agent can
   * see what was assumed.
   */
  private resolveOwner(w: Watcher): { id: string; command: string; inferred: boolean } | null {
    const explicit = ownerProcessId(w.condition);
    if (explicit) {
      const info = backgroundProcesses.getInfo(explicit);
      if (!info) return null;
      const listed = backgroundProcesses.list().find((p) => p.id === explicit);
      return { id: explicit, command: listed?.command ?? explicit, inferred: false };
    }
    const running = backgroundProcesses.list().filter((p) => p.status === 'running');
    if (running.length !== 1) return null;
    return { id: running[0].id, command: running[0].command, inferred: true };
  }

  /** The command that was supposed to satisfy this condition is gone. */
  private deadOwnerResult(
    w: Watcher,
    owner: { id: string; command: string; inferred: boolean },
    exitCode: number | null,
  ): WatchResult {
    const r = backgroundProcesses.getOutput(owner.id, { full: true });
    const waitedMs = Date.now() - w.createdAt;
    const how = owner.inferred ? ' (the only background process running when the watch started)' : '';
    return {
      id: w.id,
      outcome: 'failed',
      waitedMs,
      detail:
        `Stopped waiting for ${w.label} after ${Math.round(waitedMs / 1000)}s: the command that was supposed to satisfy it — ` +
        `\`${owner.command}\` (${owner.id})${how} — exited with code ${exitCode ?? 0} without ever getting there. ` +
        `The condition will never be met by this process. Its output is below; fix the failure and start it again.`,
      output: tail(r.output ?? ''),
      exitCode,
    };
  }

  private metResult(w: Watcher, detail: string): WatchResult {
    return {
      id: w.id, outcome: 'met', detail, waitedMs: Date.now() - w.createdAt,
      ...this.snapshotFor(w),
    };
  }

  /**
   * Attach recent process output so the agent gets the ANSWER, not just a
   * "done" — this is what saves the follow-up get_process_output round-trip.
   * For a polled condition that is bound to a command, the command's output is
   * exactly as relevant: a URL that never came up is explained by whatever that
   * process last printed.
   */
  private snapshotFor(w: Watcher): { output?: string; exitCode?: number | null } {
    const c = w.condition;
    const id = (c.kind === 'process_exit' || c.kind === 'output_match') ? c.processId : w.owner?.id;
    if (!id) return {};
    const r = backgroundProcesses.getOutput(id, { full: true });
    if (!r.ok) return {};
    return { output: tail(r.output ?? ''), exitCode: r.exitCode ?? null };
  }

  /** What the bound command was doing when the clock ran out. A watcher that
   *  times out while its command is still alive means something quite different
   *  from one whose command is nowhere to be found. */
  private ownerStateNote(w: Watcher): string {
    if (!w.owner) {
      return ' It may still be running — check on it, or watch again with a longer timeout.';
    }
    const info = backgroundProcesses.getInfo(w.owner.id);
    const how = w.owner.inferred ? ' (bound automatically — it was the only background process running)' : '';
    if (info && info.status === 'running') {
      return ` \`${w.owner.command}\` (${w.owner.id})${how} is still running but hasn't got there yet — its output is below. Give it longer, or check that output for what it's stuck on.`;
    }
    return ` \`${w.owner.command}\` (${w.owner.id})${how} is no longer running (exit code ${info?.exitCode ?? 'unknown'}); its output is below.`;
  }

  private settle(w: Watcher, result: WatchResult): void {
    if (w.settled) return;
    w.settled = true;
    w.result = result;
    for (const fn of w.cleanup) { try { fn(); } catch { /* teardown is best-effort */ } }
    w.cleanup = [];
    logger.info('Watcher settled', { id: w.id, outcome: result.outcome, waitedMs: result.waitedMs, detached: w.detached });
    for (const resolve of w.waiters) resolve(result);
    w.waiters = [];
    // The listener is what turns "the build finished" into the agent actually
    // waking up and doing something about it. Never allowed to break settling.
    try {
      this.onSettle?.({ ...result, label: w.label, sessionId: w.sessionId, detached: w.detached });
    } catch (err) {
      logger.warn('Watcher settle listener threw', { id: w.id, error: err instanceof Error ? err.message : String(err) });
    }
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

  /**
   * Cancel every live watcher belonging to a thread. Called when the user
   * presses Stop.
   *
   * Stop has to mean stop. A detached watcher exists to wake its thread back
   * up, so leaving them armed would have the agent spring back to life minutes
   * after the user deliberately halted it — the single most alarming thing an
   * agent can do. Ending the turn on its own is what earns a wake-up; being
   * switched off is not.
   */
  cancelForSession(sessionId: string): number {
    let n = 0;
    for (const w of this.watchers.values()) {
      if (w.settled || w.sessionId !== sessionId) continue;
      // Cancelled by the user, so do NOT notify the wake path.
      w.detached = false;
      this.cancel(w.id);
      n++;
    }
    if (n > 0) logger.info('Cancelled watchers for a stopped session', { sessionId, count: n });
    return n;
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
