/**
 * The environment every child process gets.
 *
 * WHY THIS FILE EXISTS
 *
 * Bubbly spawns other people's toolchains: npm, pnpm, cargo, go, gradle, pip,
 * dotnet, docker. Those toolchains read dozens of environment variables that
 * nobody thinks about until one is missing — JAVA_HOME, CARGO_HOME, GOPATH,
 * PYTHONPATH, HTTP_PROXY, PATHEXT, ProgramFiles(x86), NVM_DIR, PNPM_HOME.
 *
 * The previous approach was an ALLOWLIST of fourteen variables. It was written
 * to stop one specific leak (NODE_ENV=production, inherited from Bubbly's own
 * packaged build, which makes `npm install` skip devDependencies and report
 * "up to date" forever), and it did stop that leak — by also deleting every
 * other variable the user's toolchain needed. Java builds could not find a JDK,
 * corporate proxies stopped applying, pnpm lost its store, and on Windows the
 * loss of PATHEXT and ProgramData broke command resolution for anything not
 * ending in .exe.
 *
 * A DENYLIST is the correct shape. Inherit the user's real environment — that
 * is what a terminal on their machine would do — and remove exactly the
 * variables that describe BUBBLY'S OWN PROCESS rather than the user's project.
 * Those are enumerable, small in number, and the only ones that cause harm.
 */

/**
 * Variables that describe Bubbly's own process and must never reach a child.
 *
 * Each of these is set BY the way Bubbly itself was launched (packaged build,
 * `npm start`, Electron) and means something false about the user's project.
 */
const POISONED_EXACT = new Set([
  // The big one. Set to 'production' in every packaged build. npm/yarn/pnpm read
  // it as "omit devDependencies", so installs silently skip the dev toolchain
  // and then report "up to date" on every retry.
  'NODE_ENV',
  // Same instruction, said explicitly. Inherited from our own .npmrc/CI config.
  'NPM_CONFIG_PRODUCTION',
  'NPM_CONFIG_OMIT',
  'NPM_CONFIG_ONLY',
  'NPM_CONFIG_DEV',
  'YARN_PRODUCTION',
  // Node flags meant for OUR process (e.g. --max-old-space-size, loaders,
  // source-map support). Applied to a child they can break unrelated tools, and
  // an inherited --experimental flag makes another Node version refuse to boot.
  'NODE_OPTIONS',
  'NODE_PATH',
  // Electron internals. ELECTRON_RUN_AS_NODE in particular makes any `electron`
  // the child spawns behave as a bare Node process with no window.
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_IS_DEV',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  // Better-sqlite3 / node-pty native-module hints for OUR build.
  'PREBUILDS_ONLY',
  'npm_config_build_from_source',
]);

/**
 * Prefixes for whole families of variables injected by whatever launched us.
 *
 * `npm_*` is the important one: running Bubbly via `npm start` exports the
 * ENTIRE contents of Bubbly's own package.json as npm_package_* plus
 * npm_lifecycle_event, npm_config_* and INIT_CWD. A child npm run inside the
 * user's project then inherits Bubbly's package metadata and, worse, Bubbly's
 * npm config — which is where the production flag keeps coming back from.
 */
const POISONED_PREFIXES = ['npm_package_', 'npm_lifecycle_', 'npm_config_', 'BUBBLY_', 'VSCODE_', 'JEST_'];

/**
 * npm_config_* entries we DO want to keep, because they describe the user's
 * machine rather than Bubbly's build (a private registry, a corporate cache).
 */
const KEEP_NPM_CONFIG = new Set([
  'npm_config_registry',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'npm_config_strict_ssl',
  'npm_config_cafile',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
]);

function isPoisoned(key: string): boolean {
  const upper = key.toUpperCase();
  if (POISONED_EXACT.has(upper) || POISONED_EXACT.has(key)) return true;
  const lower = key.toLowerCase();
  if (lower.startsWith('npm_config_')) return !KEEP_NPM_CONFIG.has(lower);
  return POISONED_PREFIXES.some((p) => key.startsWith(p) || upper.startsWith(p.toUpperCase()));
}

/**
 * Keep child processes NON-INTERACTIVE.
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

export interface ChildEnvOptions {
  /**
   * An interactive PTY the USER is typing into. Prompts are answerable there,
   * so the non-interactive overrides are omitted and colour is left on.
   */
  interactive?: boolean;
  /** Extra variables to set, applied last (they win). */
  extra?: NodeJS.ProcessEnv;
  /**
   * Base environment to start from. Defaults to the real process environment;
   * a remote (SSH) executor passes the REMOTE machine's environment instead.
   */
  base?: NodeJS.ProcessEnv;
}

/**
 * Build the environment for a child process.
 *
 * Inherits everything the user's shell would have, minus the variables that
 * describe Bubbly's own process. `NODE_ENV` is deliberately UNSET rather than
 * forced to 'development': unset is what a fresh terminal looks like, and it
 * lets each tool apply its own default (npm installs devDependencies, webpack
 * picks its mode from the config, Rails uses `development`). Forcing a value
 * would break the one case where a user genuinely wants a production build.
 */
export function buildChildEnv(options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isPoisoned(key)) continue;
    env[key] = value;
  }

  // Windows tools break in obscure ways without these; restore them explicitly
  // in case a stripped or minimal parent environment was handed to us.
  if (process.platform === 'win32') {
    if (!env.PATHEXT) env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC';
    if (!env.ComSpec && !env.COMSPEC) {
      env.ComSpec = `${env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'}\\System32\\cmd.exe`;
    }
  }

  if (!options.interactive) {
    Object.assign(env, nonInteractiveEnv());
  } else {
    // A real terminal: let tools draw properly.
    env.TERM = env.TERM ?? 'xterm-256color';
    // COLORTERM is what modern tools check before using 24-bit colour; without
    // it a truecolour-capable terminal gets the 256-colour fallback palette.
    env.COLORTERM = env.COLORTERM ?? 'truecolor';
    env.FORCE_COLOR = '1';
    delete env.NO_COLOR;
    delete env.CI;
  }

  if (options.extra) Object.assign(env, options.extra);

  // Defence in depth: an `extra` block, or a base environment we did not
  // anticipate, must not be able to reintroduce the one variable that started
  // all of this.
  if (env.NODE_ENV === 'production' && !options.extra?.NODE_ENV) delete env.NODE_ENV;

  return env;
}

/**
 * Diagnostic: which poisoning variables were present and removed. Used by the
 * doctor command and by tests, so a regression is visible rather than silent.
 */
export function strippedKeys(base: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(base).filter((k) => isPoisoned(k));
}
