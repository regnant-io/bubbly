import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { detectInputPrompt } from '../../terminal/inputDetection';
import { buildChildEnv } from '../../utils/childEnv';
import {
  resolveShell,
  shellArgv,
  normalizeForDialect,
  needsVerbatimArguments,
  shellHint,
  type ShellPreference,
  type ResolvedShell,
} from './shellDialect';

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+--no-preserve-root/,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\//,
  /chmod\s+777\s+\//,
  /sudo\s+rm/,
  /:(){:|:&};:/,   // fork bomb
  /curl.*\|\s*sh/, // piped curl installs
  /wget.*\|\s*sh/,
];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for a shell run. Accepted alongside the older bare `timeoutMs`
 * positional so existing callers keep working.
 */
export interface ShellOptions {
  timeoutMs?: number;
  /** Working directory RELATIVE to the workspace root. Must stay inside it. */
  cwd?: string;
  /**
   * Which shell to use. 'auto' (the default) picks per command: PowerShell
   * syntax goes to PowerShell, POSIX syntax to Git Bash where available, and
   * everything else to cmd.exe on Windows / the login shell elsewhere.
   */
  shell?: ShellPreference;
  /** Extra environment variables for this command only. */
  env?: NodeJS.ProcessEnv;
}

function asOptions(o: number | ShellOptions | undefined): ShellOptions {
  if (o == null) return {};
  return typeof o === 'number' ? { timeoutMs: o } : o;
}

/**
 * Resolve the directory a command should run in.
 *
 * Every command used to run at the workspace root, so working in a subproject
 * meant chaining `cd sub; npm install` by hand — and on Windows that chain is
 * exactly what the `&&` parse error and the PowerShell quoting rules kept
 * breaking. An explicit cwd removes the shell from the equation entirely.
 *
 * A cwd that escapes the workspace, or does not exist, is rejected rather than
 * silently falling back to the root: running an install in the wrong directory
 * writes a node_modules nobody asked for and reports success.
 */
export function resolveCommandCwd(
  workspacePath: string,
  relative: string | undefined,
): { ok: true; cwd: string } | { ok: false; error: string } {
  const root = path.resolve(workspacePath);
  if (!relative || relative === '.' || relative === './') return { ok: true, cwd: root };

  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `cwd "${relative}" is outside the workspace. Use a path relative to the workspace root.` };
  }
  try {
    if (!fs.statSync(target).isDirectory()) {
      return { ok: false, error: `cwd "${relative}" exists but is not a directory.` };
    }
  } catch {
    return { ok: false, error: `cwd "${relative}" does not exist. Create it first, or check the path — running here would put the results in the wrong place.` };
  }
  return { ok: true, cwd: target };
}

export interface StreamingCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStart?: (startTime: number) => void;
  onEnd?: (exitCode: number, duration: number) => void;
}

export function isDestructiveCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (BLOCKED_PATTERNS.some((p) => p.test(command))) return true;
  if (lower.includes('rm -rf') || lower.includes('rm -r')) return true;
  if (lower.includes('git push') || lower.includes('git force')) return true;
  if (lower.includes('drop table') || lower.includes('drop database')) return true;
  if (lower.includes('truncate ')) return true;
  return false;
}

export function isAbsolutelyBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

/**
 * Patterns for commands that DON'T exit on their own — dev servers, watchers,
 * REPLs, long-lived daemons. Running these through the one-shot `run_command`
 * path makes the agent (and the terminal UI) hang until the timeout fires and
 * the process is killed. We detect them up front so the caller can route them
 * to the background/terminal subsystem instead.
 *
 * Conservative by design: false negatives just mean the old (timeout) behaviour;
 * false positives would background a command that should have been one-shot, so
 * we only match well-known long-running invocations.
 */
const LONG_RUNNING_PATTERNS: RegExp[] = [
  // Package-manager dev/start/serve scripts (npm/yarn/pnpm/bun)
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  /\bnpm\s+run\s+\S*(?:dev|serve|watch|start)\S*/i,
  // Bundlers / test runners in watch mode. These are safe as loose matches:
  // they all require an explicit watch flag.
  /\bwebpack(?:-dev-server)?\b.*(?:serve|--watch|-w\b)/i,
  /\b(?:rollup|esbuild|tsc|tsup|parcel)\b.*(?:--watch|-w\b)/i,
  /\bjest\b.*--watch/i,
  // Python web servers
  /\bpython[0-9.]*\s+-m\s+http\.server\b/i,
  /\b(?:flask\s+run|uvicorn|gunicorn|hypercorn|daphne)\b/i,
  /\bmanage\.py\s+runserver\b/i,
  // Other ecosystems
  /\brails\s+s(?:erver)?\b/i,
  /\bphp\s+-S\b/i,
  /\bdotnet\s+watch\b/i,
  /\bcargo\s+watch\b/i,
  /\bair\b(?:\s|$)/i, // go live-reload
];

/**
 * Commands that ALWAYS exit, and must never be mistaken for a dev server.
 *
 * This list exists because of a real, severe misclassification: the old
 * framework-name pattern (`/\b(?:vite|next|nuxt|…)\b/`) matched the framework
 * name ANYWHERE in the command line. So `npm install vite`, `npm create
 * vite@latest my-app` and `npx create-next-app` were all "detected" as dev
 * servers, pushed into the background, and the agent was explicitly told
 * "carry on — do NOT wait on it". It then wrote code against a project that had
 * never been scaffolded and dependencies that were never installed. This is the
 * single biggest reason creating a Node/React/Vite/Vue workspace never worked.
 *
 * Checked BEFORE the long-running patterns, so it always wins.
 */
const ONE_SHOT_PATTERNS: RegExp[] = [
  // Package management — install/add/remove/update and friends all terminate.
  /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add|remove|rm|uninstall|un|update|up|upgrade|audit|link|unlink|dedupe|prune|pack|publish|why|ls|list|outdated|config|cache)\b/i,
  // Scaffolders. `npm create <x>`, `npm init <x>`, `yarn create <x>`, and the
  // `create-*` binaries invoked through npx/bunx/dlx.
  /\b(?:npm|yarn|pnpm|bun)\s+(?:create|init)\b/i,
  /\bcreate-[\w-]+(?:@[\w.-]+)?\b/i,
  // Any `… init` scaffolding step (tailwindcss init, shadcn init, nuxi init…).
  /\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|pnpm\s+exec|yarn\s+exec|npm\s+exec)\s+[^;|&]*\binit\b/i,
  // Explicitly informational — never a server.
  /(?:^|\s)--(?:help|version)\b/i,
];

/** Runner prefixes that execute a local/remote binary (npx vite, pnpm dlx …). */
const RUNNER = String.raw`(?:npx|bunx|npm\s+exec|pnpm\s+exec|pnpm\s+dlx|yarn\s+exec|yarn\s+dlx)\s+(?:-{1,2}\S+\s+)*`;

/** Framework/server binaries that default to a long-lived process. */
const DEV_BINARY = String.raw`(?:vite|next|nuxt|nuxi|remix|astro|gatsby|ng|nodemon|webpack-dev-server|http-server|live-server|browser-sync|serve|vitest)`;

/**
 * The binary is only long-running when it is the COMMAND BEING INVOKED — at the
 * start of the line or right after a shell separator, optionally behind a
 * runner. `npm install vite` no longer matches; `npx vite` and `vite` do.
 */
const DEV_BINARY_INVOCATION = new RegExp(
  String.raw`(?:^|[;&|]\s*)(?:${RUNNER})?(${DEV_BINARY})\b\s*([^\s;|&]*)`,
  'i'
);

/**
 * Subcommands that turn a dev binary into a one-shot run. `next build`,
 * `ng test`, `astro check`, `vitest run` / `vitest --run` all exit.
 */
const ONE_SHOT_SUBCOMMAND =
  /^(?:build|generate|export|lint|info|telemetry|add|create|init|new|typecheck|check|test|run|--run|sync|prepare|upgrade|codemod|version|help|--version|--help)$/i;

/**
 * True when the command is expected to run indefinitely (dev server, watcher,
 * daemon). Such commands should be started in the background, not awaited.
 *
 * Conservative in BOTH directions now: a false positive (backgrounding a
 * scaffold) silently corrupts the workspace, so installs and scaffolders are
 * excluded outright before anything else is considered.
 */
export function isLongRunningCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  // Installs and scaffolders always exit — never background them.
  if (ONE_SHOT_PATTERNS.some((p) => p.test(cmd))) return false;

  // A dev binary invoked as the command itself, unless its subcommand makes it
  // one-shot (`next build`, `vitest run`).
  const m = cmd.match(DEV_BINARY_INVOCATION);
  if (m && !ONE_SHOT_SUBCOMMAND.test(m[2] ?? '')) return true;

  return LONG_RUNNING_PATTERNS.some((p) => p.test(cmd));
}

/**
 * Commands that legitimately take minutes, not seconds. The old flat 30s
 * default meant `npm install` for a React app (typically 40-120s on Windows)
 * timed out EVERY time, was killed, and came back as "cancelled" — with the
 * node_modules tree left half-written. The agent then retried the same command
 * and hit the same wall. A scaffold or install gets a realistic budget instead.
 */
const SLOW_COMMAND_PATTERNS: Array<{ re: RegExp; ms: number }> = [
  // Scaffolding a new app: downloads a template + a full dependency install.
  { re: /\b(?:npm|yarn|pnpm|bun)\s+(?:create|init)\b/i, ms: 600_000 },
  { re: /\bcreate-[\w-]+(?:@[\w.-]+)?\b/i, ms: 600_000 },
  // Dependency installs.
  { re: /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add)\b/i, ms: 600_000 },
  { re: /\bpip[0-9.]*\s+install\b/i, ms: 600_000 },
  { re: /\b(?:cargo|go|dotnet|mvn|gradle)\s+(?:build|install|restore|get|mod\s+download)\b/i, ms: 600_000 },
  // Builds and test suites.
  { re: /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?build\b/i, ms: 300_000 },
  { re: /\b(?:next|nuxt|astro|ng|vite|tsc|webpack|turbo)\b[^;|&]*\bbuild\b/i, ms: 300_000 },
  { re: /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b/i, ms: 300_000 },
  { re: /\b(?:jest|vitest|pytest|mocha|playwright)\b/i, ms: 300_000 },
  // Network fetches.
  { re: /\bgit\s+(?:clone|fetch|pull|push)\b/i, ms: 300_000 },
  { re: /\bdocker\s+(?:build|pull|compose\s+build)\b/i, ms: 600_000 },
];

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * The timeout to use when the caller didn't specify one. Slow-by-nature
 * commands get a much larger budget; everything else gets a generous default.
 */
export function defaultTimeoutFor(command: string): number {
  const cmd = command.trim();
  for (const { re, ms } of SLOW_COMMAND_PATTERNS) {
    if (re.test(cmd)) return ms;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * Re-exported from utils/childEnv so existing callers keep working. The
 * definition lives there because the interactive terminal needs the same
 * knowledge with the opposite answer.
 */
export { nonInteractiveEnv, buildChildEnv } from '../../utils/childEnv';

/**
 * Kill a child and everything it spawned.
 *
 * On Windows `child.kill()` only kills powershell.exe — npm, node and the
 * package manager's own workers survive as orphans, keep holding file locks in
 * node_modules, and keep the port bound. `taskkill /t /f` takes the whole tree.
 */
export function killProcessTree(pid: number | undefined, fallback?: () => void): void {
  if (!pid) { fallback?.(); return; }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    } else {
      // Negative pid targets the process group when spawned detached; plain pid
      // otherwise. kill() on the child covers the common case.
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    fallback?.();
  }
}

/**
 * Back-compat shim.
 *
 * This used to rewrite `&&` into `;` unconditionally on Windows. That was
 * correct while the shell was PowerShell 5.1 and catastrophically wrong once it
 * became cmd.exe, where `&&` is native and `;` is not a separator at all — it
 * turned every chained command into a single command with a nonsense argument.
 * The rewrite is now a function of the DIALECT (see shellDialect.ts) and this
 * wrapper simply asks for the dialect that would actually run the command.
 */
export function normalizeForWindows(command: string, preference: ShellPreference = 'auto'): string {
  if (process.platform !== 'win32') return command;
  return normalizeForDialect(command, resolveShell(command, preference)).command;
}

/**
 * Everything needed to spawn one command: which shell, which argv, which
 * environment, and what was rewritten on the way.
 *
 * Shared by the one-shot runner, the streaming runner and the background
 * process manager so the three can never disagree about how a command runs —
 * which they did, at length, and which is why a command could work in the chat
 * and fail in the background with no visible difference.
 */
export interface SpawnPlan {
  shell: ResolvedShell;
  file: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: string[];
  /** MUST be passed to spawn as `windowsVerbatimArguments`. See shellArgv. */
  verbatim: boolean;
}

export function planSpawn(
  command: string,
  opts: { preference?: ShellPreference; interactive?: boolean; extraEnv?: NodeJS.ProcessEnv } = {},
): SpawnPlan {
  const shell = resolveShell(command, opts.preference ?? 'auto');
  const { command: normalized, notes } = normalizeForDialect(command, shell);
  return {
    shell,
    file: shell.file,
    argv: shellArgv(shell, normalized),
    env: buildChildEnv({ interactive: opts.interactive, extra: opts.extraEnv }),
    notes,
    verbatim: needsVerbatimArguments(shell),
  };
}

/**
 * Turn a timeout into advice the agent can act on. A bare "timed out" invites
 * the same command being retried verbatim — and timing out again. If the tail
 * of the output shows a question, say so: the command wasn't slow, it was stuck.
 */
export function explainTimeout(command: string, output: string, timeoutMs: number): string {
  const prompt = detectInputPrompt(output);
  if (prompt) {
    return `Command timed out after ${timeoutMs}ms because it was WAITING FOR INPUT, not because it was slow.\nThe prompt was: ${prompt.prompt}\nRe-run it non-interactively (pass the flag that answers this, e.g. --yes / --template <name> / --defaults), or start it with run_background and answer with send_process_input.`;
  }
  const secs = Math.round(timeoutMs / 1000);
  return `Command timed out after ${timeoutMs}ms (${secs}s) and its process tree was killed. Do not just retry it verbatim — it will time out again.\nEither raise timeout_ms, or (better for anything genuinely slow) start it with run_background and wait with watch(condition:"process_exit").\nIf this was an install or a scaffold, the working directory may now be half-written: check it before continuing.`;
}

// --- Install integrity ------------------------------------------------------

/** A dependency install, as opposed to a scaffold, a build or a test run. */
const INSTALL_RE = /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add)\b/i;

/**
 * The package names an install was asked to add, if any. `npm install` with no
 * arguments installs the manifest and returns [].
 */
export function installedPackageNames(command: string): string[] {
  const m = /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add)\b(.*)$/i.exec(command);
  if (!m) return [];
  return m[1]
    .split(/[;|&]/)[0]                       // stop at the next chained command
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
    // Strip the version/tag suffix but keep the @scope/ prefix.
    .map((t) => (t.startsWith('@') ? '@' + t.slice(1).split('@')[0] : t.split('@')[0]))
    .filter((t) => /^[@a-z0-9]/i.test(t));
}

/**
 * Did the install actually land? Reported to the agent as part of the result.
 *
 * An exit code of 0 is NOT proof. A package manager killed part-way through
 * `reify` — by a timeout, by the prompt-stall detector, by the user pressing
 * Stop — can leave a node_modules that exists, is incomplete, and has no
 * completion marker, while some wrappers still report success. The agent then
 * writes code against modules that are not there. Checking the filesystem costs
 * a few stat calls and converts a silent corruption into a sentence the agent
 * can act on.
 */
export function verifyInstall(
  command: string,
  cwd: string,
  exitCode: number,
): string | null {
  if (!INSTALL_RE.test(command)) return null;

  const modules = path.join(cwd, 'node_modules');
  if (!fs.existsSync(modules)) {
    return exitCode === 0
      ? `INSTALL DID NOT LAND: the command reported success but ${modules} does not exist. Nothing was installed. Check that a package.json exists in this directory (${cwd}) — an install run in the wrong folder reports success and writes nothing.`
      : `node_modules does not exist in ${cwd}; the install did not complete.`;
  }

  // npm writes node_modules/.package-lock.json as the LAST step of a successful
  // reify, so its absence after an npm install means the tree is partial.
  const marker = path.join(modules, '.package-lock.json');
  const npmish = /\bnpm\s/i.test(command);
  if (npmish && !fs.existsSync(marker)) {
    return `INSTALL INCOMPLETE: node_modules exists in ${cwd} but npm's completion marker (node_modules/.package-lock.json) is missing, which means the install was interrupted part-way through. The dependency tree is NOT trustworthy. Delete node_modules and run the install again before writing code against it.`;
  }

  const missing = installedPackageNames(command).filter(
    (name) => !fs.existsSync(path.join(modules, ...name.split('/'))),
  );
  if (missing.length > 0) {
    return `INSTALL INCOMPLETE: these packages are still not present under ${cwd}/node_modules after the install: ${missing.join(', ')}. Do not import them yet — re-run the install and read its output.`;
  }

  return null;
}

export function runShell(
  command: string,
  workspacePath: string,
  options?: number | ShellOptions
): ShellResult {
  const opts = asOptions(options);
  const effectiveTimeout = opts.timeoutMs ?? defaultTimeoutFor(command);
  const shellLogger = logger.child({ component: 'shell', command });

  // Ensure cwd is inside workspace (and is the subdirectory the caller asked for).
  const resolvedCwd = resolveCommandCwd(workspacePath, opts.cwd);
  if (!resolvedCwd.ok) {
    return { stdout: '', stderr: resolvedCwd.error, exitCode: 1 };
  }
  const cwd = resolvedCwd.cwd;

  // Detect platform
  const isWindows = process.platform === 'win32';
  const platform = process.platform;
  // The shell is chosen PER COMMAND (see shellDialect.ts): PowerShell syntax
  // goes to PowerShell, POSIX syntax goes to Git Bash when installed, and
  // everything else goes to cmd.exe, where the JS toolchain behaves best.
  const plan = planSpawn(command, { preference: opts.shell, extraEnv: opts.env });

  shellLogger.debug('Shell command requested', {
    command,
    workspacePath,
    timeoutMs: effectiveTimeout,
    platform,
    shell: plan.shell.name,
    dialect: plan.shell.dialect,
  });

  // Block absolute patterns
  if (isAbsolutelyBlocked(command)) {
    shellLogger.warn('Command blocked by safety policy', { command });
    return {
      stdout: '',
      stderr: `Command blocked by safety policy: ${command}`,
      exitCode: 1,
    };
  }

  // Check if command is destructive
  if (isDestructiveCommand(command)) {
    shellLogger.warn('Potentially destructive command detected', { command });
  }

  try {
    shellLogger.debug('Executing shell command', {
      shell: plan.file,
      argv: plan.argv,
      dialect: plan.shell.dialect,
      cwd,
    });

    const startTime = Date.now();
    const result = spawnSync(plan.file, plan.argv, {
      cwd,
      timeout: effectiveTimeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      // The user's real environment minus the variables that describe BUBBLY'S
      // OWN process (NODE_ENV=production above all). See utils/childEnv.
      env: plan.env,
      // stdin is CLOSED, not an idle pipe. A scaffolder that asks a question
      // gets EOF and aborts with a message; with an open pipe nobody ever writes
      // to, it blocks until the timeout kills it and the agent just sees
      // "cancelled" with no idea a prompt was waiting.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      encoding: 'utf-8',
    });

    const duration = Date.now() - startTime;
    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';
    const exitCode = result.status ?? 1;

    if (result.error) {
      if (result.error.message.includes('ETIMEDOUT') || result.error.message.includes('timeout')) {
        shellLogger.error('Shell command timed out', {
          command,
          timeoutMs: effectiveTimeout,
          duration
        });
        // Tell the agent what to do instead. A bare "timed out" invites the
        // same command being retried verbatim — and timing out again.
        return {
          stdout,
          stderr: `${stderr}\n${explainTimeout(command, stdout + stderr, effectiveTimeout)}`.trim(),
          exitCode: 124,
        };
      }
      shellLogger.error('Shell command error', { 
        command, 
        error: result.error.message,
        duration 
      });
      return { stdout: '', stderr: result.error.message, exitCode: 1 };
    }

    // Log completion with exit code and stderr if present
    if (exitCode !== 0) {
      shellLogger.warn('Shell command failed', { 
        command, 
        exitCode, 
        duration,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stderr: stderr.substring(0, 500) // Log first 500 chars of stderr
      });
      
      // A failure is exactly when the agent needs to know WHICH shell ran this
      // and what was rewritten — the difference between "my command is wrong"
      // and "I wrote it in the wrong dialect".
      return { stdout, stderr: `${stderr}

${shellHint(plan.shell, plan.notes)}`.trimEnd(), exitCode };
    } else {
      shellLogger.info('Shell command completed', { 
        command, 
        exitCode, 
        duration,
        stdoutLength: stdout.length,
        stderrLength: stderr.length 
      });
    }

    return { stdout, stderr, exitCode };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    shellLogger.error('Shell command exception', { 
      command, 
      error: msg,
      stack: err instanceof Error ? err.stack : undefined 
    });
    return { stdout: '', stderr: msg, exitCode: 1 };
  }
}

/**
 * Run a shell command with real-time streaming of stdout/stderr
 */
export function runShellStreaming(
  command: string,
  workspacePath: string,
  callbacks: StreamingCallbacks,
  options?: number | ShellOptions
): Promise<ShellResult> {
  const opts = asOptions(options);
  const effectiveTimeout = opts.timeoutMs ?? defaultTimeoutFor(command);
  return new Promise((resolve, reject) => {
    const shellLogger = logger.child({ component: 'shell-streaming', command });

    // Ensure cwd is inside workspace (and is the subdirectory the caller asked for).
    const resolvedCwd = resolveCommandCwd(workspacePath, opts.cwd);
    if (!resolvedCwd.ok) {
      resolve({ stdout: '', stderr: resolvedCwd.error, exitCode: 1 });
      return;
    }
    const cwd = resolvedCwd.cwd;

    // Detect platform
    const isWindows = process.platform === 'win32';
    const platform = process.platform;
    const plan = planSpawn(command, { preference: opts.shell, extraEnv: opts.env });

    shellLogger.debug('Shell command requested (streaming)', {
      command,
      workspacePath,
      timeoutMs: effectiveTimeout,
      platform,
      shell: plan.shell.name,
      dialect: plan.shell.dialect,
    });

    // Block absolute patterns
    if (isAbsolutelyBlocked(command)) {
      shellLogger.warn('Command blocked by safety policy', { command });
      const result = {
        stdout: '',
        stderr: `Command blocked by safety policy: ${command}`,
        exitCode: 1,
      };
      resolve(result);
      return;
    }

    // Check if command is destructive
    if (isDestructiveCommand(command)) {
      shellLogger.warn('Potentially destructive command detected', { command });
    }

    try {
      shellLogger.debug('Executing shell command (streaming)', {
        shell: plan.file,
        argv: plan.argv,
        dialect: plan.shell.dialect,
        cwd,
      });

      const startTime = Date.now();
      if (callbacks.onStart) {
        callbacks.onStart(startTime);
      }

      const child = spawn(plan.file, plan.argv, {
        cwd,
        // The user's real environment minus Bubbly's own process variables
        // (NODE_ENV=production above all). See utils/childEnv.
        env: plan.env,
        // See runShell: stdin is closed so an interactive prompt aborts the
        // child instead of blocking it until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      /** Set when we killed the child because it sat on an unanswerable prompt. */
      let promptStall: string | null = null;

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, () => child.kill('SIGTERM'));
        shellLogger.error('Shell command timed out', {
          command,
          timeoutMs: effectiveTimeout,
          duration: Date.now() - startTime
        });
      }, effectiveTimeout);

      // --- Interactive-prompt stall detection --------------------------------
      // Closing stdin makes most tools abort, but some (and anything wrapping a
      // TTY check) still sit forever on the question. Rather than burn the full
      // timeout on a process we KNOW will never proceed, we look for a prompt in
      // the trailing output and kill it, telling the agent exactly what it asked.
      //
      // THE TEST IS SILENCE, NOT ARRIVAL. The previous version evaluated the
      // buffer on every single output chunk, and that is what made healthy
      // installs die: stream chunks split at arbitrary byte offsets, so a chunk
      // ending mid-line (right after the colon of `npm warn deprecated foo@1.0:`)
      // produced a buffer that looked exactly like an unanswered question. It
      // then armed an 8-second grace timer — and npm is routinely quiet for
      // longer than that while it resolves and downloads — so the process tree
      // was killed mid-install, leaving a half-written node_modules and a
      // "waiting for an answer that can never arrive" message about a prompt
      // that never existed. New projects have no deprecated dependencies, which
      // is precisely why this only ever bit projects that already existed.
      //
      // A process that is genuinely blocked on stdin produces NOTHING until it
      // is answered. So the check now runs only after a real quiet period with a
      // complete buffer, and the timer is reset by every chunk rather than being
      // started by one. Combined with the tool-noise guard in inputDetection,
      // ordinary install chatter can no longer be mistaken for a question.
      const PROMPT_QUIET_MS = 20_000;
      let quietHandle: NodeJS.Timeout | null = null;
      const armQuietCheck = () => {
        if (timedOut || promptStall) return;
        if (quietHandle) clearTimeout(quietHandle);
        quietHandle = setTimeout(() => {
          if (timedOut || promptStall) return;
          const detection = detectInputPrompt(stdout + stderr);
          // No prompt in view: the command is just slow. Say nothing and let the
          // overall timeout be the only clock. Deliberately NOT re-armed — with
          // no new output the verdict cannot change, so re-checking is pure noise.
          if (!detection) return;
          promptStall = detection.prompt;
          shellLogger.warn('Command is blocked on an interactive prompt — killing it', {
            command, prompt: detection.prompt, kind: detection.kind, quietMs: PROMPT_QUIET_MS,
          });
          killProcessTree(child.pid, () => child.kill('SIGTERM'));
        }, PROMPT_QUIET_MS);
      };
      // Armed from the start so a command that prints its question immediately
      // and then goes silent forever is still caught.
      armQuietCheck();

      // Stream stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stdout += text;
        if (callbacks.onStdout) {
          callbacks.onStdout(text);
        }
        armQuietCheck();
      });

      // Stream stderr
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stderr += text;
        if (callbacks.onStderr) {
          callbacks.onStderr(text);
        }
        armQuietCheck();
      });

      // Handle completion
      child.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        if (quietHandle) clearTimeout(quietHandle);
        const duration = Date.now() - startTime;
        const exitCode = timedOut || promptStall ? 124 : (code ?? 1);

        if (promptStall) {
          stderr += `\n\nCommand stopped: it was waiting for an answer that can never arrive — the agent shell has no keyboard.\nThe prompt was: ${promptStall}\nRe-run it non-interactively: pass the flag that supplies this answer (e.g. --yes / --template <name> / --defaults), or start it with run_background and reply with send_process_input.`;
        } else if (timedOut) {
          stderr += `\n${explainTimeout(command, stdout + stderr, effectiveTimeout)}`;
        }

        // Log completion
        if (exitCode !== 0) {
          shellLogger.warn('Shell command failed (streaming)', { 
            command, 
            exitCode, 
            duration,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
            stderr: stderr.substring(0, 500)
          });
          
          stderr += `

${shellHint(plan.shell, plan.notes)}`;
        } else {
          shellLogger.info('Shell command completed (streaming)', { 
            command, 
            exitCode, 
            duration,
            stdoutLength: stdout.length,
            stderrLength: stderr.length 
          });
        }

        if (callbacks.onEnd) {
          callbacks.onEnd(exitCode, duration);
        }

        resolve({ stdout, stderr, exitCode });
      });

      // Handle errors
      child.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        if (quietHandle) clearTimeout(quietHandle);
        const duration = Date.now() - startTime;
        shellLogger.error('Shell command error (streaming)', { 
          command, 
          error: err.message,
          duration 
        });
        
        if (callbacks.onEnd) {
          callbacks.onEnd(1, duration);
        }
        
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      shellLogger.error('Shell command exception (streaming)', { 
        command, 
        error: msg,
        stack: err instanceof Error ? err.stack : undefined 
      });
      resolve({ stdout: '', stderr: msg, exitCode: 1 });
    }
  });
}
