/**
 * Credentials the user already has.
 *
 * The instinct when adding remote support is to build a login screen and ask
 * for a token. That is the worst option available to us, for three reasons:
 * the user already authenticated to GitHub weeks ago and resents doing it
 * again; a pasted token is a long-lived secret we now have to protect; and a
 * Bubbly-only credential silently diverges from the one their `git push` uses,
 * so the two disagree at the worst possible moment.
 *
 * Everything here is a way of NOT asking. In order of preference:
 *
 *   SSH   — ssh-agent (a passphrase already entered once), then the keys in
 *           `~/.ssh`, honouring `~/.ssh/config` for host aliases, users, ports
 *           and IdentityFile. If any of that is set up, Bubbly needs nothing.
 *   GIT   — the configured credential helper. This is the same mechanism
 *           `git push` uses, including Windows' Git Credential Manager and
 *           macOS' osxkeychain, so Bubbly gets exactly the credential git
 *           would.
 *   GITHUB— `gh auth token` when the CLI is logged in; then GH_TOKEN /
 *           GITHUB_TOKEN from the environment, which is how CI supplies it.
 *   GITLAB— `glab auth status --show-token`, then GITLAB_TOKEN.
 *
 * Only when all of those come up empty do we fall back to the vault, and only
 * then does the UI ask for anything.
 *
 * Every probe here is best-effort and short-timeout: a missing CLI, a broken
 * helper or an unreachable agent must degrade to "we don't have one", never to
 * a hang or a thrown error on the settings page.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { logger } from '../utils/logger';
import { getSecret } from './vault';

/**
 * How long a credential PROBE may take before we give up on it.
 *
 * Every probe is a subprocess: `gh auth token`, `glab auth status`, `ssh-add
 * -l`, `git credential fill`. Five seconds each was chosen for a batch job and
 * is far too long for a settings page a person is looking at — five probes that
 * each hang for their full budget is twenty-five seconds of a spinner, and the
 * answer for a machine that has none of these tools installed is "no" either
 * way. A helper that cannot answer in two and a half seconds is not going to be
 * a pleasant thing to authenticate with.
 */
const PROBE_TIMEOUT_MS = 2_500;

/* -------------------------------------------------------------------------- *
 * CACHING THE PROBES
 *
 * describeCredentialSources() is called every time the Connections page is
 * opened, and findForgeToken() is called by it twice more. Each one spawns
 * several subprocesses. On a machine without `gh` and `glab` installed that is
 * cheap-ish; on one with a slow credential helper, or over a network home
 * directory, opening the tab visibly hangs — which is exactly the "the
 * connections tab is not optimised, it re-does the auth thing every time"
 * complaint.
 *
 * None of this changes second to second. Someone does not install the GitHub
 * CLI while the settings page is open. So the answers are cached for a short
 * window, and the cache is dropped explicitly whenever Bubbly itself changes a
 * credential — which is the only moment the answer can change under us and the
 * one moment a stale answer would actually be wrong.
 * -------------------------------------------------------------------------- */
const PROBE_CACHE_TTL_MS = 60_000;

interface Cached<T> { at: number; value: T }
const probeCache = new Map<string, Cached<unknown>>();

function cached<T>(key: string, ttlMs: number, compute: () => T): T {
  const hit = probeCache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = compute();
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Forget every cached probe.
 *
 * Called after Bubbly saves or deletes a credential of its own. A token the
 * user has just entered must be visible on the very next request, not in a
 * minute — "I saved it and it still says no credential found" is precisely the
 * bug a cache introduces if nobody clears it.
 */
export function invalidateCredentialProbes(): void {
  probeCache.clear();
}

function run(file: string, args: string[], input?: string): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync(file, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      input,
      // A credential helper that decides to prompt must fail instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.error || r.status !== 0) return { ok: false, stdout: r.stdout ?? '' };
    return { ok: true, stdout: r.stdout ?? '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// --- SSH --------------------------------------------------------------------

export interface SshIdentity {
  /** Absolute path to a private key. */
  path: string;
  /** Matching public key, when present — used to show a fingerprint. */
  publicKeyPath?: string;
  /** True when the private key file is passphrase-protected. */
  encrypted: boolean;
  type: string;
}

const KEY_CANDIDATES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk'];

function sshDir(): string {
  return path.join(process.env.BUBBLY_HOME || os.homedir(), '.ssh');
}

/** Private keys in `~/.ssh`, newest-style first. */
export function discoverSshKeys(): SshIdentity[] {
  const dir = sshDir();
  const out: SshIdentity[] = [];
  for (const name of KEY_CANDIDATES) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 400);
      out.push({
        path: full,
        publicKeyPath: fs.existsSync(`${full}.pub`) ? `${full}.pub` : undefined,
        // Both the classic PEM header and the OpenSSH format announce
        // encryption in the first few lines.
        encrypted: /ENCRYPTED|bcrypt/i.test(head),
        type: name.replace(/^id_/, ''),
      });
    } catch { /* not present, or unreadable */ }
  }
  return out;
}

/** Is an ssh-agent reachable, and does it hold any identities? */
export function sshAgentIdentities(): { available: boolean; count: number } {
  // No socket/pipe means no agent — skip the spawn entirely.
  const hasSocket = !!process.env.SSH_AUTH_SOCK || process.platform === 'win32';
  if (!hasSocket) return { available: false, count: 0 };
  const r = run('ssh-add', ['-l']);
  if (!r.ok) {
    // Exit code 1 means "agent running, no identities"; 2 means "no agent".
    // spawnSync gives us neither cleanly here, so treat any failure whose output
    // mentions identities as a live agent.
    return { available: /no identities/i.test(r.stdout), count: 0 };
  }
  const count = r.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
  return { available: true, count };
}

export interface SshHostConfig {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/**
 * Parse `~/.ssh/config` into host blocks.
 *
 * Reading this matters more than it looks: most people's real connection
 * details live here, not in their head. Someone who types "prod" expects the
 * HostName, User, Port and IdentityFile their config already defines — asking
 * them to re-enter all four is how a connection dialog becomes a chore.
 *
 * Deliberately simple: `Host` blocks with the four keys that matter, wildcards
 * skipped (they configure a pattern, not a place you can connect to).
 */
export function parseSshConfig(content: string): SshHostConfig[] {
  const hosts: SshHostConfig[] = [];
  let current: SshHostConfig | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    const value = rest.join(' ').trim();
    const key = keyword.toLowerCase();

    if (key === 'host') {
      for (const name of rest) {
        if (name.includes('*') || name.includes('?')) continue;
        current = { host: name };
        hosts.push(current);
      }
      if (rest.every((n) => n.includes('*') || n.includes('?'))) current = null;
      continue;
    }
    if (!current) continue;
    if (key === 'hostname') current.hostName = value;
    else if (key === 'user') current.user = value;
    else if (key === 'port') current.port = Number(value) || undefined;
    else if (key === 'identityfile') {
      current.identityFile = value.replace(/^~/, process.env.BUBBLY_HOME || os.homedir());
    }
  }
  return hosts;
}

export function discoverSshHosts(): SshHostConfig[] {
  try {
    const file = path.join(sshDir(), 'config');
    if (!fs.existsSync(file)) return [];
    return parseSshConfig(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.debug('Could not read ~/.ssh/config', { error: String(err) });
    return [];
  }
}

// --- Git credential helper --------------------------------------------------

/**
 * Ask git for the credential it would use for a URL.
 *
 * This is the single best source available: it is the exact mechanism `git
 * push` uses, so whatever comes back is guaranteed to be the credential the
 * user's own git already works with — including Windows' Git Credential
 * Manager and macOS' osxkeychain, neither of which we could read directly.
 */
export function gitCredentialFor(url: string): { username?: string; password?: string } | null {
  try {
    const u = new URL(url);
    const request = [
      `protocol=${u.protocol.replace(':', '')}`,
      `host=${u.host}`,
      u.pathname && u.pathname !== '/' ? `path=${u.pathname.replace(/^\//, '')}` : '',
      '', '',
    ].filter((l) => l !== undefined).join('\n');

    const r = run('git', ['credential', 'fill'], request);
    if (!r.ok || !r.stdout) return null;

    const fields: Record<string, string> = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!fields.password && !fields.username) return null;
    return { username: fields.username, password: fields.password };
  } catch {
    return null;
  }
}

// --- Forge tokens -----------------------------------------------------------

export type Forge = 'github' | 'gitlab';

export interface TokenLookup {
  token: string;
  /** Where it came from, so the UI can say "using your gh CLI login". */
  source: 'gh-cli' | 'glab-cli' | 'environment' | 'git-credential' | 'vault';
}

/**
 * Find a token for a forge, cheapest and least intrusive first.
 *
 * `host` matters for self-hosted instances: a GitHub Enterprise or a private
 * GitLab needs its own token, and silently using the github.com one produces a
 * 401 that looks like a bug in Bubbly.
 */
export function findForgeToken(forge: Forge, host?: string): TokenLookup | null {
  const isDefaultHost = !host
    || (forge === 'github' && /^(api\.)?github\.com$/i.test(host))
    || (forge === 'gitlab' && /^gitlab\.com$/i.test(host));

  // A token the user explicitly gave Bubbly for THIS host always wins — it is
  // the most specific statement of intent available.
  //
  // Deliberately NOT cached: a vault read is an in-memory map lookup, and this
  // is the one branch that has to be correct the instant after a save.
  const vaultKey = `${forge}:${host ?? (forge === 'github' ? 'github.com' : 'gitlab.com')}:token`;
  const stored = getSecret(vaultKey);
  if (stored) return { token: stored, source: 'vault' };

  // Everything below spawns a subprocess, so it goes through the cache.
  return cached(`forge:${forge}:${host ?? ''}`, PROBE_CACHE_TTL_MS, () => discoverForgeToken(forge, host, isDefaultHost));
}

/** The subprocess half of findForgeToken — everything that is worth caching. */
function discoverForgeToken(forge: Forge, host: string | undefined, isDefaultHost: boolean): TokenLookup | null {

  if (forge === 'github') {
    if (isDefaultHost) {
      const gh = run('gh', ['auth', 'token']);
      const token = gh.stdout.trim();
      if (gh.ok && token) return { token, source: 'gh-cli' };
    } else {
      const gh = run('gh', ['auth', 'token', '--hostname', host!]);
      const token = gh.stdout.trim();
      if (gh.ok && token) return { token, source: 'gh-cli' };
    }
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (env) return { token: env, source: 'environment' };
  }

  if (forge === 'gitlab') {
    const glab = run('glab', ['auth', 'status', '--show-token']);
    // glab prints the token on stderr in some versions; spawnSync's stdout is
    // all we can rely on, so this is intentionally a best-effort parse.
    const m = /Token:\s*(\S+)/i.exec(glab.stdout);
    if (m) return { token: m[1], source: 'glab-cli' };
    const env = process.env.GITLAB_TOKEN || process.env.CI_JOB_TOKEN;
    if (env) return { token: env, source: 'environment' };
  }

  // Last resort before asking: the git credential helper for the web host.
  const webHost = host ?? (forge === 'github' ? 'github.com' : 'gitlab.com');
  const cred = gitCredentialFor(`https://${webHost}`);
  if (cred?.password) return { token: cred.password, source: 'git-credential' };

  return null;
}

/** A one-line, honest description of the credential situation, for the UI. */
export function describeCredentialSources(): {
  ssh: { agent: boolean; agentKeys: number; keyFiles: number; configuredHosts: number };
  github: TokenLookup['source'] | null;
  gitlab: TokenLookup['source'] | null;
} {
  return cached('describe', PROBE_CACHE_TTL_MS, describeCredentialSourcesUncached);
}

function describeCredentialSourcesUncached(): {
  ssh: { agent: boolean; agentKeys: number; keyFiles: number; configuredHosts: number };
  github: TokenLookup['source'] | null;
  gitlab: TokenLookup['source'] | null;
} {
  const agent = sshAgentIdentities();
  return {
    ssh: {
      agent: agent.available,
      agentKeys: agent.count,
      keyFiles: discoverSshKeys().length,
      configuredHosts: discoverSshHosts().length,
    },
    github: findForgeToken('github')?.source ?? null,
    gitlab: findForgeToken('gitlab')?.source ?? null,
  };
}
