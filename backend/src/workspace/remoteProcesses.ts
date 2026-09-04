/**
 * Long-running commands on a remote host.
 *
 * The local `backgroundProcesses` manager holds a `ChildProcess`; there is no
 * such thing across SSH, so this holds an SSH exec CHANNEL instead. The channel
 * stays open for as long as the remote command runs, which is exactly the
 * lifetime a dev server or a watcher needs, and it carries stdout, stderr,
 * stdin and the eventual exit code — everything the local manager gets from a
 * child process.
 *
 * The API is deliberately the same shape as the local manager's, because the
 * watcher system, the runtime-state block and the Background panel all consume
 * it and none of them should have to care which side of a network the process
 * is on.
 *
 * WHAT IS DIFFERENT, AND WHY IT HAS TO BE
 *
 *  - There is no pid to kill. Stopping a remote process closes its channel and,
 *    for a process that ignores that, sends a `pkill -f` for the command line.
 *    That is less precise than a pid and it is the best SSH offers; the tool
 *    result says so rather than implying a clean kill.
 *  - A dropped connection is not a dead process. The remote command keeps
 *    running after the network goes away, so a channel closing without an exit
 *    code is reported as "lost contact", not as "exited" — the difference
 *    matters when the next step is "start it again".
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { detectInputPrompt, type InputPromptDetection } from '../terminal/inputDetection';
import type { SshProvider } from './sshProvider';

export type RemoteProcessEvent =
  | { type: 'output'; output: string }
  | { type: 'exit'; exitCode: number | null; lostContact: boolean };

interface RemoteProcess {
  id: string;
  command: string;
  cwd: string;
  host: string;
  output: string;
  readOffset: number;
  startedAt: number;
  exitCode: number | null;
  status: 'running' | 'exited' | 'lost';
  settled: boolean;
  awaitingInput: InputPromptDetection | null;
  detectedUrl: string | null;
  listeners: Set<(e: RemoteProcessEvent) => void>;
  write: (data: string) => void;
  close: () => void;
}

const MAX_OUTPUT_CHARS = 400_000;

/** URLs a dev server prints, so the preview can open itself. */
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s"'<>]*)/i;

class RemoteProcessManager {
  private procs = new Map<string, RemoteProcess>();

  /**
   * Start a command that is expected to keep running.
   *
   * Reuses an identical command in the same directory on the same host, for the
   * same reason the local manager does: an agent that starts `npm run dev`
   * twice binds two ports and then previews whichever won.
   */
  async start(
    provider: SshProvider,
    command: string,
    cwd: string,
    onUrlDetected?: (url: string) => void,
  ): Promise<{ id: string; reused: boolean; error?: string }> {
    for (const p of this.procs.values()) {
      if (p.status === 'running' && p.command === command && p.cwd === cwd) {
        if (p.detectedUrl) onUrlDetected?.(p.detectedUrl);
        return { id: p.id, reused: true };
      }
    }

    const id = `rproc_${uuidv4().slice(0, 8)}`;
    try {
      const shell = await provider.openShell({ cols: 120, rows: 40, cwd });
      const proc: RemoteProcess = {
        id,
        command,
        cwd,
        host: provider.label,
        output: '',
        readOffset: 0,
        startedAt: Date.now(),
        exitCode: null,
        status: 'running',
        settled: false,
        awaitingInput: null,
        detectedUrl: null,
        listeners: new Set(),
        write: shell.write,
        close: shell.close,
      };
      this.procs.set(id, proc);

      shell.onData((chunk) => this.append(proc, chunk, onUrlDetected));
      shell.onExit((code) => this.finalize(proc, code, code === null));

      // Run it, then exit the shell so the channel closes when the command does
      // — otherwise the interactive shell outlives its command and the process
      // looks like it is still running forever.
      shell.write(`${command}\nexit $?\n`);

      logger.info('Remote background process started', { id, host: provider.label, command, cwd });
      return { id, reused: false };
    } catch (err) {
      return { id: '', reused: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private append(p: RemoteProcess, chunk: string, onUrlDetected?: (url: string) => void): void {
    p.output += chunk;
    if (p.output.length > MAX_OUTPUT_CHARS) {
      const dropped = p.output.length - MAX_OUTPUT_CHARS;
      p.output = p.output.slice(dropped);
      p.readOffset = Math.max(0, p.readOffset - dropped);
    }

    if (!p.detectedUrl) {
      const m = URL_RE.exec(chunk);
      if (m) {
        p.detectedUrl = m[1];
        try { onUrlDetected?.(m[1]); } catch { /* the preview is never allowed to break a process */ }
      }
    }

    p.awaitingInput = detectInputPrompt(p.output);
    for (const fn of p.listeners) {
      try { fn({ type: 'output', output: chunk }); } catch { /* a listener must not kill the stream */ }
    }
  }

  private finalize(p: RemoteProcess, exitCode: number | null, lostContact: boolean): void {
    if (p.settled) return;
    p.settled = true;
    p.exitCode = exitCode;
    p.status = lostContact ? 'lost' : 'exited';
    p.output += lostContact
      ? '\n[lost contact with the remote host — the command may still be running there]\n'
      : `\n[exited with code ${exitCode ?? 0}]\n`;
    for (const fn of p.listeners) {
      try { fn({ type: 'exit', exitCode, lostContact }); } catch { /* ignore */ }
    }
    logger.info('Remote background process finished', { id: p.id, exitCode, lostContact });
  }

  subscribe(id: string, fn: (e: RemoteProcessEvent) => void): () => void {
    const p = this.procs.get(id);
    if (!p) return () => undefined;
    p.listeners.add(fn);
    return () => p.listeners.delete(fn);
  }

  getInfo(id: string): { status: string; exitCode: number | null } | null {
    const p = this.procs.get(id);
    return p ? { status: p.status, exitCode: p.exitCode } : null;
  }

  getOutput(id: string, opts: { full?: boolean } = {}): {
    ok: boolean; output?: string; status?: string; exitCode?: number | null;
    awaitingInput?: InputPromptDetection | null; error?: string;
  } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `No remote process with id ${id}.` };
    const output = opts.full ? p.output : p.output.slice(p.readOffset);
    if (!opts.full) p.readOffset = p.output.length;
    return { ok: true, output, status: p.status, exitCode: p.exitCode, awaitingInput: p.awaitingInput };
  }

  sendInput(id: string, data: string): { ok: boolean; error?: string } {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `No remote process with id ${id}.` };
    if (p.status !== 'running') return { ok: false, error: `Remote process ${id} is not running.` };
    p.write(data.endsWith('\n') ? data : `${data}\n`);
    p.awaitingInput = null;
    return { ok: true };
  }

  list(): Array<{
    id: string; command: string; cwd: string; host: string; status: string;
    exitCode: number | null; uptimeMs: number; detectedUrl: string | null;
    awaitingInput: InputPromptDetection | null;
  }> {
    return [...this.procs.values()].map((p) => ({
      id: p.id, command: p.command, cwd: p.cwd, host: p.host, status: p.status,
      exitCode: p.exitCode, uptimeMs: Date.now() - p.startedAt,
      detectedUrl: p.detectedUrl, awaitingInput: p.awaitingInput,
    }));
  }

  /**
   * Stop a remote process.
   *
   * Closing the channel is the polite version and is enough for anything that
   * dies with its terminal. A dev server started with `nohup`, or one that
   * detached itself, will not — so a `pkill -f` on the exact command line
   * follows. Reported honestly: this is a best-effort kill, not a pid signal.
   */
  async stop(id: string, provider?: SshProvider): Promise<{ ok: boolean; note: string }> {
    const p = this.procs.get(id);
    if (!p) return { ok: false, note: `No remote process with id ${id}.` };

    try { p.close(); } catch { /* already closed */ }

    let note = 'Closed the command\'s channel.';
    if (provider) {
      // pkill matches the command line; a command that has forked children with
      // different command lines can leave those behind, which the note says.
      const escaped = p.command.replace(/'/g, `'\\''`);
      const r = await provider.exec(`pkill -f '${escaped}' 2>/dev/null; true`, { timeoutMs: 10_000 });
      if (r.exitCode === 0) note += ' Sent pkill for the command line on the host.';
    }
    this.finalize(p, null, false);
    return {
      ok: true,
      note: `${note} Remote processes have no pid here, so this is best-effort — verify with list_processes if it mattered.`,
    };
  }

  async stopAll(): Promise<void> {
    for (const p of this.procs.values()) {
      try { p.close(); } catch { /* ignore */ }
    }
    this.procs.clear();
  }
}

export const remoteProcesses = new RemoteProcessManager();
