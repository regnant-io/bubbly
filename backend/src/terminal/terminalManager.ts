/**
 * Interactive Terminal Manager — real shells the user drives from the UI.
 *
 * This is the VS Code model: a real pseudo-terminal (PTY) per session, rendered
 * by xterm.js on the client. A PTY gives a genuine TTY to the shell, so colors,
 * cursor movement, progress bars, and interactive prompts (e.g. `npm create`,
 * REPLs, vim) all work — unlike a plain piped child process.
 *
 * We prefer `node-pty` (the same library VS Code uses). If the native module
 * fails to load (e.g. an environment without build tools / prebuilds), we fall
 * back to a piped child process so the terminal still functions in a degraded,
 * line-oriented mode rather than breaking entirely.
 */

import { spawn as cpSpawn, ChildProcessWithoutNullStreams } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { logger } from '../utils/logger';
import { detectInputPrompt, InputPromptDetection } from './inputDetection';
import { buildChildEnv } from '../utils/childEnv';
import { getSetting } from '../db/index';
import { findGitBash, findPwsh } from '../agent/tools/shellDialect';

// node-pty is a native module; load it defensively so a load failure degrades
// gracefully to the pipe fallback instead of crashing the backend.
type PtyProcess = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
};
type PtyModule = {
  spawn: (file: string, args: string[] | string, opts: Record<string, unknown>) => PtyProcess;
};

let pty: PtyModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require('node-pty') as PtyModule;
  logger.info('node-pty loaded — using real PTY terminals');
} catch (err) {
  logger.warn('node-pty unavailable — falling back to piped terminals', {
    error: err instanceof Error ? err.message : String(err),
  });
}

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  /** Real PTY when available; otherwise a piped child process. */
  pty: PtyProcess | null;
  proc: ChildProcessWithoutNullStreams | null;
  /** Ring buffer of recent output so reconnecting clients can backfill. */
  scrollback: string;
  cols: number;
  rows: number;
  createdAt: number;
  alive: boolean;
  /** Timestamp of the most recent output chunk — used for idle detection. */
  lastActivityAt: number;
  /** Set when the shell appears to be blocked waiting for keyboard input. */
  awaitingInput: InputPromptDetection | null;
  /** True while an agent-issued command is running in this session. */
  agentBusy: boolean;
}

export type TerminalOutputListener = (id: string, chunk: string) => void;
export type TerminalExitListener = (id: string, code: number | null) => void;
export type TerminalInputRequiredListener = (id: string, detection: InputPromptDetection) => void;

const MAX_SCROLLBACK = 200_000; // chars

class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private outputListeners = new Set<TerminalOutputListener>();
  private exitListeners = new Set<TerminalExitListener>();
  private inputRequiredListeners = new Set<TerminalInputRequiredListener>();

  onOutput(fn: TerminalOutputListener): () => void {
    this.outputListeners.add(fn);
    return () => this.outputListeners.delete(fn);
  }

  onExit(fn: TerminalExitListener): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  onInputRequired(fn: TerminalInputRequiredListener): () => void {
    this.inputRequiredListeners.add(fn);
    return () => this.inputRequiredListeners.delete(fn);
  }

  private emitOutput(id: string, chunk: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.scrollback += chunk;
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(session.scrollback.length - MAX_SCROLLBACK);
      }
      session.lastActivityAt = Date.now();
      // Detect whether the shell is now blocked on stdin. Only fire the event
      // on a rising edge (not-waiting → waiting) so we don't spam clients.
      const detection = detectInputPrompt(session.scrollback);
      const wasWaiting = !!session.awaitingInput;
      session.awaitingInput = detection;
      if (detection && !wasWaiting) {
        for (const fn of this.inputRequiredListeners) {
          try { fn(id, detection); } catch { /* listener errors shouldn't break the stream */ }
        }
      }
    }
    for (const fn of this.outputListeners) {
      try { fn(id, chunk); } catch { /* listener errors shouldn't break the stream */ }
    }
  }

  private emitExit(id: string, code: number | null): void {
    for (const fn of this.exitListeners) {
      try { fn(id, code); } catch { /* ignore */ }
    }
  }

  /**
   * The shell + default args to launch for this OS.
   *
   * Honours the `terminalShell` setting so a user who lives in bash, zsh, pwsh
   * or cmd gets that shell rather than an opinion. 'auto' keeps the platform
   * default: PowerShell on Windows (what the Start menu gives you), the login
   * shell everywhere else.
   */
  private pickShell(): { shell: string; args: string[] } {
    let preference = 'auto';
    try { preference = getSetting('terminalShell') || 'auto'; } catch { /* pre-migration DB */ }

    if (process.platform === 'win32') {
      if (preference === 'cmd') return { shell: process.env.ComSpec || 'cmd.exe', args: [] };
      if (preference === 'bash') {
        const bash = findGitBash();
        if (bash) return { shell: bash, args: ['--login', '-i'] };
      }
      if (preference === 'pwsh') {
        const pwsh = findPwsh();
        if (pwsh) return { shell: pwsh, args: ['-NoLogo'] };
      }
      // Default: PowerShell 7 when installed (better in every way), else 5.1.
      const pwsh = preference === 'powershell' ? null : findPwsh();
      if (pwsh) return { shell: pwsh, args: ['-NoLogo'] };
      return { shell: 'powershell.exe', args: ['-NoLogo'] };
    }

    if (preference !== 'auto' && preference !== 'cmd' && preference !== 'powershell') {
      // On Unix the preference is a shell NAME; trust PATH resolution.
      return { shell: preference, args: ['-l'] };
    }
    const shell = process.env.SHELL || '/bin/bash';
    return { shell, args: ['-l'] };
  }

  create(params: { workspacePath: string; title?: string; cols?: number; rows?: number }): TerminalSession {
    const id = `term_${uuidv4().slice(0, 8)}`;
    const cwd = path.resolve(params.workspacePath);
    const { shell, args } = this.pickShell();
    const cols = params.cols ?? 80;
    const rows = params.rows ?? 24;

    // A REAL terminal environment: everything the user's own shell would see,
    // minus the variables that describe Bubbly's own process.
    //
    // This is where NODE_ENV=production used to leak in and stay: the packaged
    // desktop build sets it, the terminal inherited it wholesale, and from then
    // on every `npm install` the user typed skipped devDependencies and cheerily
    // reported "up to date" — the exact nightmare that made new projects
    // impossible to set up from inside the IDE.
    const env = buildChildEnv({ interactive: true }) as Record<string, string>;

    const session: TerminalSession = {
      id,
      title: params.title || 'Terminal',
      cwd,
      shell,
      pty: null,
      proc: null,
      scrollback: '',
      cols,
      rows,
      createdAt: Date.now(),
      alive: true,
      lastActivityAt: Date.now(),
      awaitingInput: null,
      agentBusy: false,
    };
    this.sessions.set(id, session);

    // Allow disabling PTY entirely via env (some locked-down environments can't
    // use ConPTY/winpty at all). Falls straight to the pipe shell.
    const ptyDisabled = process.env.BUBBLY_DISABLE_PTY === '1' || process.env.BUBBLY_DISABLE_PTY === 'true';

    if (pty && !ptyDisabled) {
      /*
       * CONPTY NEEDS A CONSOLE. WE OFTEN DO NOT HAVE ONE.
       *
       * ConPTY's helper calls AttachConsole on Windows, which fails outright
       * when the host process has no console attached — and the backend
       * frequently has none: under the Electron shell, under `bubbly serve
       * --detach` (stdio: 'ignore'), under a Windows service, and under Jest.
       * The failure is not graceful: the helper throws at require time and the
       * spawned shell dies with STATUS_DLL_INIT_FAILED before printing a
       * character, so the terminal opens and immediately closes.
       *
       * The old check tested only for Electron, which is one of four cases. A
       * TTY on stdout is the honest test for "there is a console here": when
       * there is one, ConPTY is the better backend and we use it; when there is
       * not, winpty is console-independent and works. The fast-exit recovery
       * below is still the backstop for everything neither test catches.
       */
      const underElectron = process.env.BUBBLY_ELECTRON === '1';
      const hasConsole = process.stdout.isTTY === true;
      const useConpty = process.platform === 'win32' ? (!underElectron && hasConsole) : undefined;
      logger.info('Creating PTY terminal', { id, cwd, shell, cols, rows, useConpty });
      try {
        const p = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env,
          useConpty,
        });
        session.pty = p;

        const spawnedAt = Date.now();
        p.onData((data: string) => {
          try { this.emitOutput(id, data); } catch { /* never throw from native cb */ }
        });
        p.onExit(({ exitCode }) => {
          // ConPTY/winpty init failure: the shell dies almost immediately with
          // STATUS_DLL_INIT_FAILED (0xC0000142 == -1073741510) or a fast nonzero
          // exit. Recover by recreating this session on the pipe backend.
          const failedFast = (Date.now() - spawnedAt) < 1500;
          const initFailure = exitCode === -1073741510 || exitCode === 0xc0000142;
          if (session.alive && failedFast && (initFailure || exitCode !== 0)) {
            logger.warn('PTY exited immediately — falling back to piped shell', { id, exitCode });
            session.pty = null;
            try { this.startPipeShell(session, env); } catch (e) {
              logger.error('Pipe fallback failed', { id, error: e instanceof Error ? e.message : String(e) });
              session.alive = false;
              this.emitExit(id, exitCode);
            }
            return;
          }
          session.alive = false;
          logger.info('PTY terminal exited', { id, exitCode });
          this.emitOutput(id, `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
          this.emitExit(id, exitCode);
        });
        return session;
      } catch (err) {
        logger.warn('PTY spawn threw — using pipe fallback', { id, error: err instanceof Error ? err.message : String(err) });
        session.pty = null;
        // fall through to pipe fallback
      }
    }

    // --- Pipe fallback (degraded, line-oriented) ---
    try {
      this.startPipeShell(session, env);
    } catch (err) {
      session.alive = false;
      this.emitOutput(id, `\r\n[failed to start terminal: ${err instanceof Error ? err.message : String(err)}]\r\n`);
    }
    return session;
  }

  /** Start (or restart) a piped shell for an existing session. */
  private startPipeShell(session: TerminalSession, env: Record<string, string>): void {
    const id = session.id;
    const { shell: fShell, args: fArgs } = this.pickFallbackShell();
    const proc = cpSpawn(fShell, fArgs, {
      cwd: session.cwd,
      env: { ...env },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    session.proc = proc;
    session.shell = fShell;
    session.alive = true;

    proc.stdout.on('data', (d: Buffer) => { try { this.emitOutput(id, d.toString('utf8')); } catch { /* ignore */ } });
    proc.stderr.on('data', (d: Buffer) => { try { this.emitOutput(id, d.toString('utf8')); } catch { /* ignore */ } });
    proc.on('exit', (code) => {
      session.alive = false;
      logger.info('Terminal (pipe) exited', { id, code });
      this.emitOutput(id, `\r\n[process exited with code ${code ?? 0}]\r\n`);
      this.emitExit(id, code);
    });
    proc.on('error', (err) => {
      session.alive = false;
      this.emitOutput(id, `\r\n[terminal error: ${err.message}]\r\n`);
    });

    this.emitOutput(id, `Bubbly terminal — ${fShell}\r\n${session.cwd}\r\n\r\n`);
  }

  /** Shell config for the pipe fallback (needs the interactive stdin trick). */
  private pickFallbackShell(): { shell: string; args: string[] } {
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] };
    }
    const shell = process.env.SHELL || '/bin/bash';
    return { shell, args: ['-i'] };
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    try {
      if (session.pty) {
        session.pty.write(data);
      } else if (session.proc) {
        session.proc.stdin.write(data);
      } else {
        return false;
      }
      // Any input the user/agent types clears the waiting flag; the next prompt
      // (if any) will re-trigger detection from fresh output.
      if (data.includes('\r') || data.includes('\n')) session.awaitingInput = null;
      return true;
    } catch (err) {
      logger.warn('Terminal write failed', { id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * A session counts as IDLE (safe for the agent to reuse) when it is alive,
   * not currently running an agent command, not blocked on input, and has had
   * no output for `quietMs`. This is the primitive that lets the agent reuse an
   * existing terminal instead of spawning a new one for every command.
   */
  isIdle(id: string, quietMs = 750): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    if (s.agentBusy || s.awaitingInput) return false;
    return Date.now() - s.lastActivityAt >= quietMs;
  }

  /**
   * Return an existing idle terminal for this workspace, or create a new one.
   * Used by the agent so it doesn't flood the UI with terminals: it reuses any
   * terminal that is alive and not doing anything.
   */
  acquireIdle(params: { workspacePath: string; title?: string }): TerminalSession {
    const cwd = path.resolve(params.workspacePath);
    for (const s of this.sessions.values()) {
      if (s.cwd === cwd && this.isIdle(s.id)) return s;
    }
    return this.create({ workspacePath: params.workspacePath, title: params.title });
  }

  /** Mark a session busy/idle around an agent-issued command. */
  setAgentBusy(id: string, busy: boolean): void {
    const s = this.sessions.get(id);
    if (s) { s.agentBusy = busy; s.lastActivityAt = Date.now(); }
  }

  /** Resize the PTY (xterm fit addon drives this). No-op for the pipe fallback. */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    session.cols = cols;
    session.rows = rows;
    if (session.pty) {
      try {
        session.pty.resize(Math.max(1, cols), Math.max(1, rows));
        return true;
      } catch (err) {
        logger.debug('PTY resize failed', { id, error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    }
    return false;
  }

  /** Convenience: run a full command line (appends newline). */
  runCommand(id: string, command: string): boolean {
    return this.write(id, command.endsWith('\n') ? command : command + '\r');
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    logger.info('Killing terminal', { id });
    try {
      if (session.pty) session.pty.kill();
      else if (session.proc) session.proc.kill();
    } catch { /* ignore */ }
    session.alive = false;
    this.sessions.delete(id);
    return true;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): Array<{ id: string; title: string; cwd: string; alive: boolean; createdAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      alive: s.alive,
      createdAt: s.createdAt,
    }));
  }

  getScrollback(id: string): string {
    return this.sessions.get(id)?.scrollback ?? '';
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }
}

export const terminalManager = new TerminalManager();
