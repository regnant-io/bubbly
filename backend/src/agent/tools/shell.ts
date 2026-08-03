import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import { detectInputPrompt } from '../../terminal/inputDetection';

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
 * Environment that keeps child processes NON-INTERACTIVE.
 *
 * Scaffolders and installers ask questions ("Ok to proceed? (y)", "Select a
 * framework:"). With stdin closed they abort instead of hanging — but the far
 * better outcome is that they never ask. `CI` makes almost every JS tool pick
 * its defaults, `npm_config_yes` auto-confirms npx/npm-create downloads, and
 * `GIT_TERMINAL_PROMPT=0` makes git fail fast instead of waiting on credentials.
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    CI: '1',
    npm_config_yes: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
    ADBLOCK: '1',
    DISABLE_OPENCOLLECTIVE: '1',
    GIT_TERMINAL_PROMPT: '0',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONUNBUFFERED: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

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
 * Prepare a command for `powershell.exe -Command <arg>`.
 *
 * NO QUOTE ESCAPING HAPPENS HERE, deliberately. The command is passed as its own
 * argv element, NOT interpolated into a quoted PowerShell string, so there is no
 * surrounding quote to escape out of. The previous implementation doubled single
 * quotes (`'` -> `''`) for a wrapping that never existed, which silently
 * corrupted every command containing one: `node -e 'console.log(42)'` became
 * `node -e ''console.log(42)''`, which PowerShell parses as two empty strings
 * concatenated — printing NOTHING and exiting 0. The agent saw a clean success
 * and an empty result, with no way to tell the command had been mangled.
 *
 * What IS added is exit-code propagation: -Command exits with PowerShell's own
 * 0/1 status rather than the command's, so `npm test` failing with 2 and a
 * process killed with 137 both arrived as 1. A native exe sets $LASTEXITCODE; a
 * failed cmdlet leaves it null but clears $?.
 */
function escapePowerShell(command: string): string {
  return `${command}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`;
}

/**
 * Escape special characters for bash/sh
 */
function escapeBash(command: string): string {
  // For bash, we're passing the command as a string to -c, so it's already quoted
  // No additional escaping needed in most cases
  return command;
}

/**
 * Proactively normalize a command for Windows PowerShell so common Unix-isms
 * the model emits still work. This is a safety net on top of the system prompt.
 * Conservative: only rewrites things that are unambiguous and safe.
 *
 * Windows PowerShell 5.1 has no `&&` / `||` chain operators — they are a parse
 * error, so the command dies before its first byte runs. `a && b` becomes
 * `a; b`; `||` gets the same best-effort sequential treatment.
 *
 * THE REWRITE IS QUOTE-AWARE rather than skipped-if-quoted. The previous version
 * bailed out the moment the command contained ANY quote, which meant the single
 * most common real install — `cd "my project" && npm install` — sailed through
 * untouched and died on a PowerShell syntax error, with npm never invoked. Since
 * any path with a space needs quoting, "has a quote somewhere" and "must not be
 * rewritten" are completely different questions. We now walk the string tracking
 * quote state and only rewrite operators found OUTSIDE quotes, which is both
 * safer than the old blanket rewrite and vastly more useful than skipping.
 */
export function normalizeForWindows(command: string): string {
  if (process.platform !== 'win32') return command;

  let out = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      out += ch;
      // PowerShell escapes a quote by doubling it inside the same quote type.
      if (ch === quote) {
        if (command[i + 1] === quote) { out += command[i + 1]; i++; }
        else quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }

    // A chain operator outside quotes. `&&` and `||` both become `;` — we cannot
    // express "only on failure" without a full rewrite, and running the next
    // command is the behaviour the model expected in the overwhelming majority
    // of cases (`cd x && npm i`).
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      out = out.replace(/\s+$/, '') + '; ';
      i++;                                   // consume the second operator char
      while (/\s/.test(command[i + 1] ?? '')) i++;  // and the space after it
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Suggest Windows-compatible alternatives for common Unix commands
 */
function suggestWindowsAlternative(command: string): string | null {
  const cmd = command.trim().toLowerCase();
  
  const alternatives: Record<string, string> = {
    'ls': 'dir or Get-ChildItem',
    'cat': 'type or Get-Content',
    'grep': 'findstr or Select-String',
    'rm': 'del or Remove-Item',
    'cp': 'copy or Copy-Item',
    'mv': 'move or Move-Item',
    'touch': 'New-Item -ItemType File',
    'mkdir': 'New-Item -ItemType Directory',
    'pwd': 'cd or Get-Location',
    'which': 'where or Get-Command',
    'echo': 'Write-Output',
    'clear': 'cls or Clear-Host',
  };
  
  for (const [unixCmd, windowsCmd] of Object.entries(alternatives)) {
    if (cmd.startsWith(unixCmd + ' ') || cmd === unixCmd) {
      return windowsCmd;
    }
  }
  
  return null;
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
  const shell = isWindows ? 'powershell.exe' : 'sh';

  shellLogger.debug('Shell command requested', {
    command,
    workspacePath,
    timeoutMs: effectiveTimeout,
    platform,
    shell
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
    // Platform-specific shell selection and command escaping
    let shellArgs: string[];
    let escapedCommand: string;
    
    if (isWindows) {
      // Use PowerShell on Windows
      escapedCommand = escapePowerShell(normalizeForWindows(command));
      shellArgs = ['-NoProfile', '-NonInteractive', '-Command', escapedCommand];
    } else {
      // Use sh on Unix-like systems
      escapedCommand = escapeBash(command);
      shellArgs = ['-c', escapedCommand];
    }

    shellLogger.debug('Executing shell command', { 
      shell,
      shellArgs,
      isWindows,
      cwd 
    });

    const startTime = Date.now();
    const result = spawnSync(shell, shellArgs, {
      cwd,
      timeout: effectiveTimeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        // Restrict PATH to prevent some attacks
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ...nonInteractiveEnv(),
      },
      // stdin is CLOSED, not an idle pipe. A scaffolder that asks a question
      // gets EOF and aborts with a message; with an open pipe nobody ever writes
      // to, it blocks until the timeout kills it and the agent just sees
      // "cancelled" with no idea a prompt was waiting.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
      
      // Suggest Windows alternatives if command failed on Windows
      if (isWindows && exitCode === 1) {
        const alternative = suggestWindowsAlternative(command);
        if (alternative) {
          const suggestion = `\n\nWindows alternative: Try using '${alternative}' instead.`;
          return { 
            stdout, 
            stderr: stderr + suggestion, 
            exitCode 
          };
        }
      }
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
    // Use powershell.exe on Windows (will be found in PATH)
    const shell = isWindows ? 'powershell.exe' : 'sh';

    shellLogger.debug('Shell command requested (streaming)', {
      command,
      workspacePath,
      timeoutMs: effectiveTimeout,
      platform,
      shell
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
      // Platform-specific shell selection and command escaping
      let shellArgs: string[];
      let escapedCommand: string;
      
      if (isWindows) {
        // Use PowerShell on Windows
        escapedCommand = escapePowerShell(normalizeForWindows(command));
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', escapedCommand];
      } else {
        // Use sh on Unix-like systems
        escapedCommand = escapeBash(command);
        shellArgs = ['-c', escapedCommand];
      }

      shellLogger.debug('Executing shell command (streaming)', { 
        shell,
        shellArgs,
        isWindows,
        cwd 
      });

      const startTime = Date.now();
      if (callbacks.onStart) {
        callbacks.onStart(startTime);
      }

      const child = spawn(shell, shellArgs, {
        cwd,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          ...nonInteractiveEnv(),
        },
        // See runShell: stdin is closed so an interactive prompt aborts the
        // child instead of blocking it until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
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
          
          // Suggest Windows alternatives if command failed on Windows
          if (isWindows && exitCode === 1) {
            const alternative = suggestWindowsAlternative(command);
            if (alternative) {
              stderr += `\n\nWindows alternative: Try using '${alternative}' instead.`;
            }
          }
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
