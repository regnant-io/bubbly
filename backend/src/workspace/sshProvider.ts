/**
 * A workspace on another machine.
 *
 * Everything a tool does — read, write, search, run a command, start a dev
 * server, open a terminal — happens ON THE REMOTE HOST. Nothing is mirrored
 * locally, because a mirror is a second source of truth and the two drift the
 * moment anything else touches the remote directory.
 *
 * WHY A PERSISTENT CONNECTION AND NOT `ssh` PER CALL
 *
 * Shelling out to the `ssh` binary once per operation is the obvious
 * implementation and it does not survive contact with an agent. An agent run
 * makes hundreds of small calls; a fresh TCP connection, key exchange and
 * authentication for each costs 150–500ms, so a twenty-file read becomes ten
 * seconds of pure handshake. OpenSSH's ControlMaster multiplexing fixes that on
 * Unix and is NOT SUPPORTED on Windows, which is where most of these users are.
 *
 * So: one authenticated connection per host, held open, multiplexing every exec
 * and SFTP operation over its channels — which is what SSH was designed for.
 *
 * WHAT IT REUSES
 *
 * The user's ssh-agent first (including the Windows named-pipe agent and
 * Pageant), then a key file, then a stored password. An agent-backed connection
 * needs no secret from us at all, which is the outcome to aim for.
 */

import fs from 'fs';
import path from 'path';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { logger } from '../utils/logger';
import { getSecret } from '../secrets/vault';
import type {
  DirEntry, ExecOptions, ExecResult, FileStat, SshConnection,
  StreamingExecCallbacks, WorkspaceProvider,
} from './types';

/** Idle connections are dropped after this, so a laptop lid does not hold one open forever. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/** Join remote path segments. Always POSIX — the far side is not Windows. */
function remoteJoin(root: string, rel: string): string {
  const clean = (rel || '.').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean === '.') return root;
  return `${root.replace(/\/+$/, '')}/${clean.replace(/^\/+/, '')}`;
}

/**
 * Reject a path that escapes the workspace root.
 *
 * The local provider gets this from `resolveSafePath`, which is filesystem-aware
 * and cannot be used here. The rule is the same and it is not optional: without
 * it, `../../etc/ssh/sshd_config` is a legal argument to `write_file` on someone
 * else's server.
 */
export function resolveRemotePath(root: string, rel: string): string {
  const cleaned = (rel || '.').replace(/\\/g, '/');
  // An ABSOLUTE path is taken at face value and then checked, rather than being
  // silently reinterpreted as relative to the root. Quietly turning
  // `/etc/shadow` into `<root>/etc/shadow` "contains" it, but it also means the
  // agent asked for one file and got a different one with no indication that
  // anything was rewritten — which is a worse failure than a clear refusal.
  const full = cleaned.startsWith('/') ? cleaned : remoteJoin(root, cleaned);
  // Normalize `.` and `..` textually — there is no local filesystem to ask.
  const parts: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const normalized = `/${parts.join('/')}`;
  const normalizedRoot = `/${root.split('/').filter((s) => s && s !== '.').join('/')}`;
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) {
    throw new Error(
      `Path "${rel}" resolves outside the workspace (${normalizedRoot}). ` +
      `Remote paths must stay inside the directory this thread opened.`,
    );
  }
  return normalized;
}

/** Escape a string for safe inclusion in a POSIX single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SshProvider implements WorkspaceProvider {
  readonly kind = 'ssh' as const;
  readonly pathSep = '/' as const;

  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private connecting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly connection: SshConnection,
    readonly root: string,
  ) {}

  get label(): string {
    return `${this.connection.username}@${this.connection.host}:${this.root}`;
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Build the ssh2 connect config, preferring credentials the user already has.
   *
   * Agent first, always. An agent-backed connection means Bubbly never sees,
   * stores or transmits a secret — the agent signs the challenge and we never
   * hold the key. That is a materially better security posture than any amount
   * of careful handling of a passphrase we asked for.
   */
  private buildConfig(): ConnectConfig {
    const cfg: ConnectConfig = {
      host: this.connection.host,
      port: this.connection.port || 22,
      username: this.connection.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 20_000,
      keepaliveCountMax: 3,
    };

    if (this.connection.auth === 'agent') {
      // On Windows the OpenSSH agent is a named pipe, not a socket path, and
      // SSH_AUTH_SOCK is usually unset even when the agent is running.
      cfg.agent = process.env.SSH_AUTH_SOCK
        ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (!cfg.agent) {
        throw new Error(
          'This connection is set to use ssh-agent, but no agent was found. ' +
          'Start one (ssh-agent, or the OpenSSH Authentication Agent service on Windows) and add your key with `ssh-add`, ' +
          'or change the connection to use a key file.',
        );
      }
      return cfg;
    }

    if (this.connection.auth === 'key') {
      const keyPath = this.connection.privateKeyPath;
      if (!keyPath || !fs.existsSync(keyPath)) {
        throw new Error(`Private key not found at ${keyPath ?? '(none set)'}. Check the connection's key path.`);
      }
      cfg.privateKey = fs.readFileSync(keyPath);
      const passphrase = getSecret(`ssh:${this.connection.id}:passphrase`);
      if (passphrase) cfg.passphrase = passphrase;
      return cfg;
    }

    const password = getSecret(`ssh:${this.connection.id}:password`);
    if (!password) {
      throw new Error(
        'No stored password for this connection. Re-enter it in Settings → Connections, ' +
        'or switch the connection to ssh-agent or a key file.',
      );
    }
    cfg.password = password;
    return cfg;
  }

  /**
   * Drop the socket after a period of inactivity — WITHOUT retiring the provider.
   *
   * THE BUG THIS FIXES
   *
   * The idle timer used to call dispose(), which sets `disposed = true`, and
   * ensureReady() opens with `if (this.disposed) throw`. So an SSH workspace
   * left alone for ten minutes killed itself permanently: every later tool call
   * failed with "This SSH workspace has been closed", and because the registry
   * caches providers by source there was nothing to replace it with. Ten
   * minutes of thinking, or a lunch break, and the thread's filesystem was gone
   * for good.
   *
   * Idle and closed are different things. Closing the socket is housekeeping —
   * a laptop lid should not hold a connection open all night — and it must be
   * completely invisible: the next call reconnects. dispose() remains what it
   * says, an explicit and permanent teardown.
   */
  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.disposed || !this.client) return;
      logger.info('Dropping an idle SSH connection; it will reconnect on the next call', {
        host: this.connection.host,
      });
      this.closeSocket();
    }, IDLE_TIMEOUT_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /** Tear down the transport, leaving this provider reusable. */
  private closeSocket(): void {
    this.sftp = null;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) {
      try { client.end(); } catch { /* already gone */ }
    }
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('This SSH workspace has been closed.');
    if (this.client && this.sftp) { this.touchIdleTimer(); return; }
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const client = new Client();

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        try { client.end(); } catch { /* already gone */ }
        reject(this.explain(err));
      };

      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) { fail(err); return; }
          if (settled) return;
          settled = true;
          this.client = client;
          this.sftp = sftp;
          this.connecting = null;
          this.touchIdleTimer();
          logger.info('SSH connection established', {
            host: this.connection.host, user: this.connection.username, auth: this.connection.auth,
          });
          resolve();
        });
      });

      client.on('error', fail);

      client.on('close', () => {
        // A dropped connection must not leave a dead handle behind that every
        // later call fails against — clearing it means the next call reconnects.
        this.client = null;
        this.sftp = null;
        if (!settled) fail(new Error('The SSH connection closed before it was ready.'));
      });

      try {
        client.connect(this.buildConfig());
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return this.connecting;
  }

  /**
   * Turn an ssh2 error into something a person can act on.
   *
   * The raw errors are famously unhelpful ("All configured authentication
   * methods failed" is the same message for a wrong username, a missing key and
   * a locked account), and an agent that reads one has no idea what to try next.
   */
  private explain(err: Error): Error {
    const msg = err.message || String(err);
    const where = `${this.connection.username}@${this.connection.host}:${this.connection.port || 22}`;

    if (/All configured authentication methods failed/i.test(msg)) {
      const hint = this.connection.auth === 'agent'
        ? 'The agent is running but the host rejected every key it offered. Check that the right key is added (`ssh-add -l`) and that its public half is in the remote ~/.ssh/authorized_keys.'
        : this.connection.auth === 'key'
        ? 'The key was loaded but the host rejected it. Check that this is the right key for this host, that its public half is in the remote ~/.ssh/authorized_keys, and that any passphrase is stored correctly.'
        : 'The password was rejected. Check it, and check that the server allows password authentication at all (many do not).';
      return new Error(`SSH authentication failed for ${where}. ${hint}`);
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      return new Error(`Cannot resolve the host "${this.connection.host}". Check the hostname, or use its IP address.`);
    }
    if (/ECONNREFUSED/i.test(msg)) {
      return new Error(`${where} refused the connection. Check that sshd is running and listening on port ${this.connection.port || 22}.`);
    }
    if (/ETIMEDOUT|Timed out while waiting/i.test(msg)) {
      return new Error(`${where} did not respond within ${CONNECT_TIMEOUT_MS / 1000}s. Check the host is reachable and that a firewall is not dropping the connection.`);
    }
    if (/no matching (host key|key exchange|cipher)/i.test(msg)) {
      return new Error(`${where} and Bubbly could not agree on an algorithm (${msg}). The server is probably very old; connecting with the system \`ssh\` client will show which algorithms it wants.`);
    }
    if (/Cannot parse privateKey|Encrypted private key detected/i.test(msg)) {
      return new Error(`The private key could not be read: ${msg}. If it has a passphrase, store it against this connection in Settings.`);
    }
    return new Error(`SSH error for ${where}: ${msg}`);
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) throw new Error('The SSH connection is not open.');
    this.touchIdleTimer();
    return this.sftp;
  }

  // --- Files ---------------------------------------------------------------

  private abs(rel: string): string {
    return resolveRemotePath(this.root, rel);
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    await this.ensureReady();
    const sftp = this.requireSftp();
    const full = this.abs(relPath);
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(full, (err, data) => {
        if (err) reject(new Error(`Cannot read ${full}: ${err.message}`));
        else resolve(data as Buffer);
      });
    });
  }

  async readFile(relPath: string): Promise<string> {
    return (await this.readFileBuffer(relPath)).toString('utf8');
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.ensureReady();
    const full = this.abs(relPath);
    // The parent may not exist; mkdir -p over exec is one round trip and works
    // regardless of how deep the gap is, where SFTP would need one per level.
    const dir = full.slice(0, full.lastIndexOf('/')) || '/';
    await this.exec(`mkdir -p ${shellQuote(dir)}`);
    const sftp = this.requireSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(full, content, { encoding: 'utf8' }, (err) => {
        if (err) reject(new Error(`Cannot write ${full}: ${err.message}`));
        else resolve();
      });
    });
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.ensureReady();
    const full = this.abs(relPath);
    const r = await this.exec(`rm -rf ${shellQuote(full)}`);
    if (r.exitCode !== 0) throw new Error(`Cannot delete ${full}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.ensureReady();
    const from = this.abs(fromRel);
    const to = this.abs(toRel);
    const dir = to.slice(0, to.lastIndexOf('/')) || '/';
    const r = await this.exec(`mkdir -p ${shellQuote(dir)} && mv ${shellQuote(from)} ${shellQuote(to)}`);
    if (r.exitCode !== 0) throw new Error(`Cannot move ${from} to ${to}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async mkdirp(relPath: string): Promise<void> {
    await this.ensureReady();
    const r = await this.exec(`mkdir -p ${shellQuote(this.abs(relPath))}`);
    if (r.exitCode !== 0) throw new Error(`Cannot create ${relPath}: ${r.stderr.trim()}`);
  }

  async stat(relPath: string): Promise<FileStat> {
    await this.ensureReady();
    const sftp = this.requireSftp();
    const full = this.abs(relPath);
    return new Promise<FileStat>((resolve) => {
      sftp.stat(full, (err, s) => {
        if (err || !s) { resolve({ exists: false, isDirectory: false, size: 0, modifiedMs: 0 }); return; }
        resolve({
          exists: true,
          isDirectory: s.isDirectory(),
          size: s.size ?? 0,
          modifiedMs: (s.mtime ?? 0) * 1000,
        });
      });
    });
  }

  async list(relPath: string): Promise<DirEntry[]> {
    await this.ensureReady();
    const sftp = this.requireSftp();
    const full = this.abs(relPath || '.');
    const base = (relPath || '').replace(/\\/g, '/').replace(/^\.?\/?/, '').replace(/\/$/, '');
    return new Promise<DirEntry[]>((resolve, reject) => {
      sftp.readdir(full, (err, entries) => {
        if (err) { reject(new Error(`Cannot list ${full}: ${err.message}`)); return; }
        resolve(entries.map((e) => ({
          name: e.filename,
          path: base ? `${base}/${e.filename}` : e.filename,
          isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
          size: e.attrs.size ?? 0,
          modifiedMs: (e.attrs.mtime ?? 0) * 1000,
        })));
      });
    });
  }

  /**
   * Walk the remote tree with ONE command.
   *
   * A recursive readdir over SFTP is a round trip per directory; on a project
   * with four hundred directories and 40ms of latency that is sixteen seconds
   * for a file tree. `find` does the whole walk on the far side and streams one
   * answer back, which is the entire reason a remote provider should be allowed
   * to implement `walk` itself rather than inheriting a generic one.
   */
  async walk(opts: { relPath?: string; maxEntries?: number; includeHidden?: boolean } = {}): Promise<DirEntry[]> {
    await this.ensureReady();
    const base = this.abs(opts.relPath || '.');
    const max = opts.maxEntries ?? 5000;

    const prunes = ['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', 'target']
      .map((d) => `-name ${shellQuote(d)}`)
      .join(' -o ');
    const hidden = opts.includeHidden ? '' : ` -o -name '.*' `;

    // -printf is GNU find; BSD/macOS find lacks it, so fall back to a plain
    // listing there and accept losing size/mtime rather than losing the walk.
    const gnu = `find ${shellQuote(base)} \\( ${prunes}${hidden} \\) -prune -o -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n ${max}`;
    const posix = `find ${shellQuote(base)} \\( ${prunes}${hidden} \\) -prune -o -print 2>/dev/null | head -n ${max}`;

    let result = await this.exec(gnu, { timeoutMs: 60_000 });
    let hasStats = result.exitCode === 0 && result.stdout.includes('\t');
    if (!hasStats) {
      result = await this.exec(posix, { timeoutMs: 60_000 });
      hasStats = false;
    }

    const out: DirEntry[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      let type = '';
      let size = 0;
      let mtime = 0;
      let full = line.trim();
      if (hasStats) {
        const [t, s, m, ...rest] = line.split('\t');
        type = t;
        size = Number(s) || 0;
        mtime = Math.round((Number(m) || 0) * 1000);
        full = rest.join('\t').trim();
      }
      if (!full || full === base) continue;
      const rel = full.startsWith(base) ? full.slice(base.length).replace(/^\//, '') : full;
      out.push({
        name: full.slice(full.lastIndexOf('/') + 1),
        path: rel,
        isDirectory: hasStats ? type === 'd' : !rel.includes('.'),
        size,
        modifiedMs: mtime,
      });
    }
    return out;
  }

  // --- Commands ------------------------------------------------------------

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.execStreaming(command, {}, opts);
  }

  async execStreaming(
    command: string,
    cb: StreamingExecCallbacks,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    await this.ensureReady();
    const client = this.client;
    if (!client) throw new Error('The SSH connection is not open.');
    this.touchIdleTimer();

    const cwd = opts.cwd ? this.abs(opts.cwd) : this.root;
    // `cd || exit` rather than `cd &&`: a missing directory must fail loudly
    // rather than silently running the command in the login directory, which is
    // how an install lands in $HOME instead of the project.
    const envPrefix = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shellQuote(String(v))};`)
      .join(' ');
    const wrapped = `cd ${shellQuote(cwd)} || exit 127; ${envPrefix} ${command}`;

    return new Promise<ExecResult>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      let stdout = '';
      let stderr = '';
      let finished = false;
      let timer: NodeJS.Timeout | null = null;

      client.exec(wrapped, { pty: false }, (err, stream) => {
        if (err) { reject(new Error(`Cannot run a command on ${this.connection.host}: ${err.message}`)); return; }

        const finish = (exitCode: number, note?: string) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          resolve({
            stdout,
            stderr: note ? `${stderr}\n${note}`.trim() : stderr,
            exitCode,
            shell: `ssh:${this.connection.host}`,
          });
        };

        timer = setTimeout(() => {
          try { stream.close(); } catch { /* already closing */ }
          finish(124,
            `Command timed out after ${timeoutMs}ms on ${this.connection.host} and its channel was closed. ` +
            `Raise timeout_ms, or start it with run_background and wait on it instead.`);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        const onAbort = () => {
          try { stream.close(); } catch { /* already closing */ }
          finish(130, 'Cancelled.');
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        stream.on('data', (d: Buffer) => {
          const text = d.toString('utf8');
          stdout += text;
          cb.onStdout?.(text);
        });
        stream.stderr.on('data', (d: Buffer) => {
          const text = d.toString('utf8');
          stderr += text;
          cb.onStderr?.(text);
        });
        stream.on('close', (code: number | null) => {
          opts.signal?.removeEventListener('abort', onAbort);
          if (code === 127 && /^$/.test(stdout) && !stderr) {
            finish(127, `The working directory ${cwd} does not exist on ${this.connection.host}.`);
            return;
          }
          finish(code ?? 0);
        });
        stream.on('error', (e: Error) => finish(1, e.message));
      });
    });
  }

  /**
   * A live interactive shell channel, for the remote terminal.
   *
   * Exposed separately from `exec` because a terminal is a different shape: it
   * needs a PTY, it is bidirectional, and it lives for as long as the user
   * keeps it open.
   */
  async openShell(opts: { cols: number; rows: number; cwd?: string }): Promise<{
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    close: () => void;
    onData: (cb: (chunk: string) => void) => void;
    onExit: (cb: (code: number | null) => void) => void;
  }> {
    await this.ensureReady();
    const client = this.client;
    if (!client) throw new Error('The SSH connection is not open.');

    return new Promise((resolve, reject) => {
      client.shell(
        { term: 'xterm-256color', cols: opts.cols, rows: opts.rows },
        (err, stream) => {
          if (err) { reject(new Error(`Cannot open a remote shell: ${err.message}`)); return; }
          const dataListeners: Array<(c: string) => void> = [];
          const exitListeners: Array<(c: number | null) => void> = [];

          stream.on('data', (d: Buffer) => {
            const text = d.toString('utf8');
            for (const fn of dataListeners) { try { fn(text); } catch { /* a listener must not kill the stream */ } }
          });
          stream.on('close', (code: number | null) => {
            for (const fn of exitListeners) { try { fn(code ?? 0); } catch { /* ignore */ } }
          });

          // Land the user in the workspace, not in their home directory.
          const start = opts.cwd ? this.abs(opts.cwd) : this.root;
          stream.write(`cd ${shellQuote(start)}\n`);

          resolve({
            write: (data) => { try { stream.write(data); } catch { /* channel closed */ } },
            resize: (cols, rows) => { try { stream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ } },
            close: () => { try { stream.close(); } catch { /* ignore */ } },
            onData: (cb) => dataListeners.push(cb),
            onExit: (cb) => exitListeners.push(cb),
          });
        },
      );
    });
  }

  /**
   * Retire this provider for good.
   *
   * Only ever called when the WORKSPACE is going away — the app is shutting
   * down, or the saved connection was deleted. An idle connection uses
   * closeSocket() instead, because "nobody has used this for ten minutes" is
   * not a reason to make the workspace permanently unusable.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.closeSocket();
  }
}

/** Probe a connection without keeping it: the "Test connection" button. */
export async function testSshConnection(connection: SshConnection): Promise<{
  ok: boolean;
  message: string;
  details?: { os?: string; shell?: string; home?: string; cwdExists?: boolean };
}> {
  const provider = new SshProvider(connection, connection.defaultPath || '/');
  try {
    await provider.ensureReady();
    // One round trip that answers everything the connection dialog wants to
    // show: which OS, which shell, where home is, and whether the path the user
    // typed actually exists — the last being the most common setup mistake.
    const probe = await provider.exec(
      'uname -sr 2>/dev/null || echo unknown; echo "$SHELL"; echo "$HOME"',
      { cwd: undefined, timeoutMs: 15_000 },
    );
    const [osLine, shell, home] = probe.stdout.split('\n').map((s) => s.trim());

    let cwdExists: boolean | undefined;
    if (connection.defaultPath) {
      const check = await provider.exec(`test -d ${shellQuote(connection.defaultPath)}`, { timeoutMs: 10_000 });
      cwdExists = check.exitCode === 0;
    }

    return {
      ok: true,
      message: `Connected to ${connection.username}@${connection.host}.`,
      details: { os: osLine || undefined, shell: shell || undefined, home: home || undefined, cwdExists },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await provider.dispose();
  }
}
