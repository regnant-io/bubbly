/**
 * Background process manager for the agent.
 *
 * `run_command` is one-shot and time-bounded — it cannot start a dev server,
 * a test watcher, or a build and then let the agent keep working and read the
 * output later. This manager fills that gap: the agent can START a long-lived
 * process, READ its accumulated output at any time, LIST running processes, and
 * STOP them. This is what turns the agent from "writes code" into "writes, runs,
 * and verifies code".
 *
 * Output is captured into a bounded ring buffer per process so reads are cheap
 * and memory stays bounded even for chatty servers.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import { isAbsolutelyBlocked, isDestructiveCommand, normalizeForWindows } from './shell';
import { detectInputPrompt, InputPromptDetection } from '../../terminal/inputDetection';

const MAX_BUFFER_CHARS = 200_000;

interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  proc: ChildProcessWithoutNullStreams;
  output: string;
  startedAt: number;
  exitCode: number | null;
  status: 'running' | 'exited' | 'killed';
  /** Char offset already returned by get_process_output, for incremental reads. */
  readOffset: number;
  /** Set when the process appears to be blocked waiting for stdin. */
  awaitingInput: InputPromptDetection | null;
  /** The first dev-server URL seen in this process's output, once detected. */
  detectedUrl: string | null;
  /** Fired exactly once, the moment a dev-server URL first appears in output. */
  onUrlDetected?: (url: string) => void;
  /** Generic subscribers (watchers). Notified on new output and on exit, so a
   *  watcher learns the instant something happens instead of polling for it. */
  listeners: Set<(ev: ProcessEvent) => void>;
  /** True once the exit event has been emitted. Node can fire both 'exit' and
   *  'error' for one process; subscribers must see the end exactly once. */
  settled: boolean;
}

/** What a process subscriber is told. Deliberately small: the watcher reads
 *  whatever detail it needs back off the manager. */
export type ProcessEvent =
  | { type: 'output'; chunk: string; output: string }
  | { type: 'exit'; exitCode: number | null };

// Matches the URL a dev server prints on startup, e.g. "Local: http://localhost:5173/"
// or "http://127.0.0.1:3000". Deliberately excludes trailing punctuation/parens.
const DEV_SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"<>)\]]*/i;

// Strips ANSI colour/formatting escape sequences. Dev servers like Vite print
// their URL with the port wrapped in bold codes (http://localhost:\x1b[1m5173\x1b[22m/),
// which would otherwise be captured INTO the detected URL and produce a garbled
// "http://localhost:[1m5173[22m/" that the browser can't open.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

class BackgroundProcessManager {
  private procs = new Map<string, BackgroundProcess>();

  /** Subscribe to a process's output/exit. Returns an unsubscribe function.
   *  A listener that throws must never break the process pipeline, so each is
   *  called defensively. */
  subscribe(id: string, fn: (ev: ProcessEvent) => void): () => void {
    const p = this.procs.get(id);
    if (!p) return () => { /* nothing to unsubscribe */ };
    p.listeners.add(fn);
    return () => { p.listeners.delete(fn); };
  }

  private emit(p: BackgroundProcess, ev: ProcessEvent): void {
    for (const fn of p.listeners) {
      try { fn(ev); } catch (err) {
        logger.warn('Process listener threw', { id: p.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private append(p: BackgroundProcess, chunk: string): void {
    p.output += chunk;
    if (p.output.length > MAX_BUFFER_CHARS) {
      p.output = p.output.slice(p.output.length - MAX_BUFFER_CHARS);
      // Keep readOffset within bounds after trimming.
      p.readOffset = Math.min(p.readOffset, p.output.length);
    }
    // Re-evaluate whether the process is now blocked waiting for stdin. We only
    // check while it is still running — an exited process can't be waiting.
    if (p.status === 'running') {
      const detection = detectInputPrompt(p.output);
      const wasWaiting = !!p.awaitingInput;
      p.awaitingInput = detection;
      if (detection && !wasWaiting) {
        logger.info('Background process appears to be waiting for input', {
          id: p.id, kind: detection.kind, prompt: detection.prompt,
        });
      }
    }
    // First-sighting dev-server URL detection, so the Bubbly Preview panel can
    // open itself the moment a server prints its address — the user never has
    // to notice a URL scrolled by in a background process's log and open the
    // preview manually.
    if (!p.detectedUrl) {
      // Strip ANSI codes FIRST so escape sequences embedded mid-URL (Vite bolds
      // the port) don't get captured into the match.
      const m = stripAnsi(chunk).match(DEV_SERVER_URL_RE) ?? stripAnsi(p.output).match(DEV_SERVER_URL_RE);
      if (m) {
        p.detectedUrl = m[0].replace(/[.,;]+$/, '');
        logger.info('Detected dev-server URL in background process output', { id: p.id, url: p.detectedUrl });
        p.onUrlDetected?.(p.detectedUrl);
      }
    }
    this.emit(p, { type: 'output', chunk, output: p.output });
  }

  /** Start a long-running command. Returns its id, or reuses an equivalent live one. */
  start(
    command: string,
    workspacePath: string,
    onUrlDetected?: (url: string) => void
  ): { id: string; reused: boolean; error?: string } {
    if (isAbsolutelyBlocked(command)) {
      return { id: '', reused: false, error: `Command blocked by safety policy: ${command}` };
    }
    const cwd = path.resolve(workspacePath);

    // Reuse an already-running identical command in the same cwd.
    for (const p of this.procs.values()) {
      if (p.status === 'running' && p.command === command && p.cwd === cwd) {
        // A fresh caller might still want to know the URL (e.g. the preview
        // panel got closed since it was detected) — fire immediately if we
        // already have it.
        if (p.detectedUrl) onUrlDetected?.(p.detectedUrl);
        else p.onUrlDetected = onUrlDetected;
        return { id: p.id, reused: true };
      }
    }

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : 'sh';
    const finalCommand = isWindows ? normalizeForWindows(command) : command;
    // PowerShell's -Command exits with its OWN success/failure code (0 or 1),
    // not the command's. Without propagation, `npm test` failing with 2 and a
    // crash exiting 137 both arrive as "1" — the agent loses the ability to tell
    // a failed assertion from an OOM kill. Propagate the real code: a native exe
    // sets $LASTEXITCODE; a failed cmdlet leaves it null but clears $?.
    const shellArgs = isWindows
      ? ['-NoProfile', '-NonInteractive', '-Command',
         `${finalCommand}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`]
      : ['-c', finalCommand];

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(shell, shellArgs, {
        cwd,
        // Quiet the package-manager chatter and stop git/npx from blocking on a
        // prompt. Deliberately NOT setting CI=1 here (unlike the one-shot shell):
        // some dev servers change behaviour under CI — react-scripts turns
        // warnings into errors and refuses to start — and a background process
        // CAN be answered later via send_process_input, so it doesn't need the
        // same hard non-interactive stance.
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          npm_config_yes: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_progress: 'false',
          GIT_TERMINAL_PROMPT: '0',
        },
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      return { id: '', reused: false, error: err instanceof Error ? err.message : String(err) };
    }

    const id = `proc_${uuidv4().slice(0, 8)}`;
    const p: BackgroundProcess = {
      id, command, cwd, proc,
      output: '', startedAt: Date.now(), exitCode: null, status: 'running', readOffset: 0,
      awaitingInput: null, detectedUrl: null, onUrlDetected, listeners: new Set(), settled: false,
    };
    this.procs.set(id, p);

    if (isDestructiveCommand(command)) {
      logger.warn('Background process is potentially destructive', { id, command });
    }

    proc.stdout.on('data', (d: Buffer) => this.append(p, d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => this.append(p, d.toString('utf8')));

    // 'exit' and 'error' can BOTH fire for the same process, and a spawn failure
    // (ENOENT, EACCES) fires only 'error' — never 'exit'. Emitting from one path
    // only meant a command that died before it could even start left every
    // watcher on it hanging until its deadline, then reporting a timeout instead
    // of the actual failure. Both paths now finalise, exactly once.
    const finalize = (code: number | null, note: string) => {
      if (p.settled) return;
      p.settled = true;
      p.exitCode = code;
      if (p.status === 'running') p.status = 'exited';
      p.awaitingInput = null;
      this.append(p, `\n${note}\n`);
      logger.info('Background process finished', { id, code, note });
      // Emitted AFTER the append above so a watcher waiting on exit sees the
      // final output (including any error the command printed on its way out).
      this.emit(p, { type: 'exit', exitCode: code });
    };

    proc.on('exit', (code) => finalize(code, `[process exited with code ${code ?? 0}]`));
    proc.on('error', (err) => finalize(null, `[process failed to start: ${err.message}]`));

    logger.info('Background process started', { id, command, cwd });
    return { id, reused: false };
  }

  /**
   * Read output. By default returns only NEW output since the last read
   * (incremental); pass full=true for the entire buffer. Optionally limit to
   * the last N lines.
   */
  getOutput(id: string, opts: { full?: boolean; lines?: number } = {}): { ok: boolean; output?: string; status?: string; exitCode?: number | null; awaitingInput?: InputPromptDetection | null; error?: string } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `No background process with id ${id}.` };

    let out: string;
    if (opts.full) {
      out = p.output;
    } else {
      out = p.output.slice(p.readOffset);
      p.readOffset = p.output.length;
    }
    if (opts.lines && opts.lines > 0) {
      const arr = out.split('\n');
      out = arr.slice(-opts.lines).join('\n');
    }
    return { ok: true, output: out, status: p.status, exitCode: p.exitCode, awaitingInput: p.awaitingInput };
  }

  /** OS pid of a running process, for port-ownership lookups (previewTarget). */
  getPid(id: string): number | null {
    const p = this.procs.get(id);
    return p && p.status === 'running' ? (p.proc.pid ?? null) : null;
  }

  /** Snapshot a process's status + detected dev-server URL, or null if unknown. */
  getInfo(id: string): { status: string; detectedUrl: string | null; exitCode: number | null } | null {
    const p = this.procs.get(id);
    if (!p) return null;
    return { status: p.status, detectedUrl: p.detectedUrl, exitCode: p.exitCode };
  }

  /** Find a still-running process in the given cwd (used to reconnect the
   *  preview Start/Stop buttons to a server without threading the id around). */
  findRunningByCwd(workspacePath: string): { id: string; command: string; detectedUrl: string | null } | null {
    const cwd = path.resolve(workspacePath);
    for (const p of this.procs.values()) {
      if (p.status === 'running' && p.cwd === cwd) {
        return { id: p.id, command: p.command, detectedUrl: p.detectedUrl };
      }
    }
    return null;
  }

  /**
   * Answer a process that is waiting for stdin (e.g. a confirmation prompt).
   * Appends a newline if the caller didn't. Returns ok=false if the process is
   * gone or its stdin is not writable.
   */
  sendInput(id: string, data: string): { ok: boolean; error?: string } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `No background process with id ${id}.` };
    if (p.status !== 'running') return { ok: false, error: `Process ${id} is not running.` };
    try {
      const payload = data.endsWith('\n') || data.endsWith('\r') ? data : data + '\n';
      p.proc.stdin.write(payload);
      // Once we answer, clear the waiting flag; the next output will re-detect
      // if another prompt appears.
      p.awaitingInput = null;
      logger.info('Sent input to background process', { id, bytes: payload.length });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  list(): Array<{ id: string; command: string; cwd: string; status: string; exitCode: number | null; uptimeMs: number; awaitingInput: boolean; detectedUrl: string | null; startedAt: number }> {
    return Array.from(this.procs.values()).map((p) => ({
      id: p.id,
      command: p.command,
      cwd: p.cwd,
      status: p.status,
      exitCode: p.exitCode,
      uptimeMs: Date.now() - p.startedAt,
      awaitingInput: !!p.awaitingInput,
      detectedUrl: p.detectedUrl,
      startedAt: p.startedAt,
    }));
  }

  stop(id: string): { ok: boolean; error?: string } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `No background process with id ${id}.` };
    try {
      // Kill the whole process tree on Windows; SIGTERM elsewhere.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.proc.pid), '/t', '/f']);
      } else {
        p.proc.kill('SIGTERM');
      }
    } catch { /* ignore */ }
    p.status = 'killed';
    logger.info('Background process stopped', { id });
    return { ok: true };
  }

  killAll(): void {
    for (const id of Array.from(this.procs.keys())) this.stop(id);
  }
}

export const backgroundProcesses = new BackgroundProcessManager();
