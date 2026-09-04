/**
 * Where a thread's work actually happens.
 *
 * Bubbly used to have exactly one answer — a directory on this machine — and
 * that answer was hard-coded into every tool: `fs.readFileSync`, `spawnSync`,
 * `path.resolve(workspacePath, …)`. Adding SSH by threading an `isRemote` flag
 * through forty call sites would have produced forty places to forget it, and
 * the forgotten ones fail in the worst possible way: an "edit" that silently
 * writes to the wrong machine.
 *
 * So there is one interface — `WorkspaceProvider` — and every tool goes through
 * it. A local workspace gets an implementation backed by `fs` and `spawn`; an
 * SSH workspace gets one backed by a live connection. The tools cannot tell the
 * difference, which is the only way "the same tools work on any source" is
 * actually true rather than aspirational.
 *
 * THREE SOURCE KINDS, AND WHY GIT IS NOT REMOTE
 *
 *   local — a directory on this machine.
 *   ssh   — a directory on another machine. Reads, writes, searches, commands,
 *           background processes and terminals all execute THERE.
 *   git   — a repository, CLONED to a managed local directory and worked on
 *           locally.
 *
 * Git is deliberately not a remote execution target. There is nothing to
 * execute on: a git remote is storage, not a computer. Cloning locally is what
 * every other tool does because it is what actually works — you get a real
 * working tree, real tool speed, and a normal push/PR flow on top. Pretending a
 * repository is a machine would buy nothing and cost everything.
 */

export type WorkspaceSourceKind = 'local' | 'ssh' | 'git';

/** A directory on this machine. */
export interface LocalSource {
  kind: 'local';
  path: string;
}

/** A directory on another machine, reached over SSH. */
export interface SshSource {
  kind: 'ssh';
  /** The saved connection this workspace uses. */
  connectionId: string;
  /** Absolute path ON THE REMOTE HOST. */
  remotePath: string;
}

/** A repository, cloned into a managed local directory. */
export interface GitSource {
  kind: 'git';
  /** Clone URL as the user gave it (https or ssh form). */
  url: string;
  /** Branch to check out. Empty means the remote's default branch. */
  branch?: string;
  /** Where it was cloned. Assigned by the registry, under ~/.bubbly/repos. */
  localPath: string;
  /** Which forge this is, when we recognised one. Drives PR/issue support. */
  forge?: 'github' | 'gitlab' | 'other';
  /** Host, for self-hosted instances (ghe.acme.com, gitlab.internal). */
  host?: string;
  /** owner/name, when the URL yielded one. */
  owner?: string;
  repo?: string;
}

export type WorkspaceSource = LocalSource | SshSource | GitSource;

/** One entry in a directory listing. */
export interface DirEntry {
  name: string;
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedMs: number;
}

export interface FileStat {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modifiedMs: number;
}

export interface ExecOptions {
  /** Directory relative to the workspace root. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Which shell actually ran it, for the agent-facing hint. */
  shell?: string;
}

export interface StreamingExecCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * The whole surface a tool needs.
 *
 * Kept deliberately small. Every method here has to be implementable over a
 * network connection with acceptable latency, which is a useful forcing
 * function: it rules out chatty APIs (`readdir` per directory during a deep
 * walk) in favour of ones that do the work on the far side (`search`, `walk`).
 */
export interface WorkspaceProvider {
  readonly kind: WorkspaceSourceKind;
  /** Human-readable location, for logs and the UI: a path, or user@host:/path. */
  readonly label: string;
  /** The root, in whatever namespace this provider uses. */
  readonly root: string;
  /** Separator the FAR SIDE uses. A Linux host reached from Windows uses '/'. */
  readonly pathSep: '/' | '\\';

  /** Ready to serve requests? A remote provider connects lazily. */
  ensureReady(): Promise<void>;

  readFile(relPath: string): Promise<string>;
  readFileBuffer(relPath: string): Promise<Buffer>;
  writeFile(relPath: string, content: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  mkdirp(relPath: string): Promise<void>;
  stat(relPath: string): Promise<FileStat>;
  list(relPath: string): Promise<DirEntry[]>;

  /**
   * Walk the tree, filtered on the FAR SIDE where possible. Returns paths
   * relative to the root.
   */
  walk(opts: { relPath?: string; maxEntries?: number; includeHidden?: boolean }): Promise<DirEntry[]>;

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  execStreaming(command: string, cb: StreamingExecCallbacks, opts?: ExecOptions): Promise<ExecResult>;

  /** Release connections. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** A saved SSH connection, as stored in the database. Never holds a secret. */
export interface SshConnection {
  id: string;
  /** What the user calls it. */
  name: string;
  host: string;
  port: number;
  username: string;
  /**
   * How to authenticate. 'agent' uses ssh-agent, 'key' a private key file,
   * 'password' a stored password. Secrets live in the vault under
   * `ssh:<id>:passphrase` / `ssh:<id>:password`.
   */
  auth: 'agent' | 'key' | 'password';
  /** Absolute path to a private key, when auth === 'key'. */
  privateKeyPath?: string;
  /** Default directory to open on this host. */
  defaultPath?: string;
  /** Set when the connection was imported from ~/.ssh/config. */
  fromSshConfig?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

/** A saved forge (GitHub/GitLab) account. Never holds a secret. */
export interface ForgeAccount {
  id: string;
  forge: 'github' | 'gitlab';
  /** api.github.com, or an enterprise host. */
  host: string;
  /** Login name, once verified. */
  username?: string;
  /** Where the token comes from — a stored one, or something already on the box. */
  tokenSource: 'vault' | 'gh-cli' | 'glab-cli' | 'environment' | 'git-credential';
  createdAt: string;
  lastUsedAt?: string;
}
