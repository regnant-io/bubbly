/**
 * Opening a repository as a workspace.
 *
 * A git remote is storage, not a computer, so there is nothing to execute on
 * and nothing to be remote about: Bubbly clones it into a managed directory and
 * works there, exactly as a person would. What "Git source" buys over "clone it
 * yourself and open the folder" is everything around the clone — knowing which
 * forge it is, authenticating without a prompt, tracking the branch, and being
 * able to open a pull request at the end.
 *
 * WHERE CLONES GO
 *
 * `~/.bubbly/repos/<host>/<owner>/<repo>`, mirroring the URL. Predictable
 * enough that a user can find it in a file manager, namespaced enough that
 * `acme/api` and `personal/api` do not collide — which a flat `repos/<repo>`
 * scheme would do silently, and destructively.
 *
 * AUTHENTICATION
 *
 * Nothing is invented. An SSH URL uses the user's agent and keys, and needs
 * nothing from us. An HTTPS URL uses the git credential helper — the same
 * mechanism their own `git push` uses — and only if that comes up empty do we
 * reach for a token from `gh`/`glab`/the environment/the vault, injected for the
 * single command that needs it and never written to disk.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { logger } from '../utils/logger';
import { buildChildEnv } from '../utils/childEnv';
import { findForgeToken } from '../secrets/credentialSources';
import type { GitSource } from './types';

export interface ParsedRepoUrl {
  /** Normalised clone URL. */
  url: string;
  host: string;
  owner: string;
  repo: string;
  forge: 'github' | 'gitlab' | 'other';
  /** True when the URL is an SSH one (git@host:owner/repo.git or ssh://…). */
  ssh: boolean;
}

/**
 * Understand the many shapes a repository URL comes in.
 *
 * People paste whatever is on their clipboard: the browser address bar, the
 * green "Code" button's HTTPS URL, the SSH one, or `owner/repo` from memory.
 * Rejecting four of those five because they are not a clone URL is a bad
 * trade — recognising them costs one function.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl | null {
  const raw = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!raw) return null;

  const classify = (host: string): 'github' | 'gitlab' | 'other' =>
    /github/i.test(host) ? 'github' : /gitlab/i.test(host) ? 'gitlab' : 'other';

  // owner/repo — assume GitHub, which is what people mean when they type it.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    const [owner, repo] = raw.split('/');
    return { url: `https://github.com/${owner}/${repo}.git`, host: 'github.com', owner, repo, forge: 'github', ssh: false };
  }

  // git@host:owner/repo
  const scp = /^(?:ssh:\/\/)?(?:([\w.-]+)@)?([\w.-]+):(?:\d+\/)?([\w.-]+(?:\/[\w.-]+)*)\/([\w.-]+)$/.exec(raw);
  if (scp && !raw.startsWith('http')) {
    const [, , host, ownerPath, repo] = scp;
    return {
      url: raw.startsWith('ssh://') ? `${raw}.git` : `git@${host}:${ownerPath}/${repo}.git`,
      host, owner: ownerPath, repo, forge: classify(host), ssh: true,
    };
  }

  // https://host/owner/repo (including nested GitLab groups)
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const repo = segments[segments.length - 1];
    const owner = segments.slice(0, -1).join('/');
    return {
      url: `${u.protocol}//${u.host}${u.pathname}.git`,
      host: u.host,
      owner,
      repo,
      forge: classify(u.host),
      ssh: u.protocol === 'ssh:',
    };
  } catch {
    return null;
  }
}

function reposRoot(): string {
  return path.join(process.env.BUBBLY_HOME || os.homedir(), '.bubbly', 'repos');
}

/** Where a given repository is (or would be) cloned. */
export function clonePathFor(parsed: ParsedRepoUrl): string {
  const safe = (s: string) => s.replace(/[^\w.@-]+/g, '_');
  return path.join(reposRoot(), safe(parsed.host), ...parsed.owner.split('/').map(safe), safe(parsed.repo));
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run git with credentials, without ever writing one to disk.
 *
 * A token, when we need one, is passed through the `GIT_ASKPASS`-free route:
 * an `http.extraheader` on the command line for this invocation only. It lives
 * in the process's argv for the duration of one command and nowhere else — not
 * in the URL (which git writes into `.git/config` and every later push would
 * leak), not in a credential file, not in the environment of child processes.
 */
export function runGit(args: string[], cwd: string, opts: { token?: string; timeoutMs?: number } = {}): GitCommandResult {
  const full = opts.token
    ? ['-c', `http.extraheader=Authorization: Bearer ${opts.token}`, ...args]
    : args;

  const r = spawnSync('git', full, {
    cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: buildChildEnv({
      extra: {
        // Never block on a credential prompt we cannot answer.
        GIT_TERMINAL_PROMPT: '0',
        // Do not let a host key prompt hang a clone; the user's known_hosts
        // still applies, this only stops the interactive question.
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
      },
    }),
  });

  if (r.error) {
    const notInstalled = (r.error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      stdout: '',
      stderr: notInstalled
        ? 'git is not installed or not on PATH. Install Git to use repository sources.'
        : r.error.message,
      exitCode: 1,
    };
  }

  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status ?? 1,
  };
}

/** Redact anything that looks like a credential before this reaches a log or the UI. */
export function redact(text: string): string {
  return text
    .replace(/(Authorization: Bearer )\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1***:***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\b(glpat-[A-Za-z0-9_-]{16,})\b/g, '***');
}

export interface CloneOutcome {
  ok: boolean;
  source?: GitSource;
  message: string;
  /** True when the directory already held this repository and was reused. */
  reused?: boolean;
}

/**
 * Clone a repository, or reuse the clone we already have.
 *
 * Reuse is the important half. Re-cloning a 2GB monorepo because the user
 * opened it again is both slow and destructive — it would discard uncommitted
 * work from the last session. So an existing clone of the SAME remote is
 * fetched and checked out instead, and a directory that turns out to hold a
 * DIFFERENT remote is refused rather than overwritten.
 */
export function cloneOrReuse(
  input: string,
  opts: { branch?: string; depth?: number } = {},
): CloneOutcome {
  const parsed = parseRepoUrl(input);
  if (!parsed) {
    return {
      ok: false,
      message:
        `"${input}" is not a repository URL. Use https://host/owner/repo, git@host:owner/repo.git, or owner/repo for GitHub.`,
    };
  }

  const target = clonePathFor(parsed);
  const token = parsed.ssh ? undefined : findForgeToken(
    parsed.forge === 'other' ? 'github' : parsed.forge,
    parsed.host,
  )?.token;

  const source: GitSource = {
    kind: 'git',
    url: parsed.url,
    branch: opts.branch,
    localPath: target,
    forge: parsed.forge,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
  };

  // Already cloned?
  if (fs.existsSync(path.join(target, '.git'))) {
    const remote = runGit(['remote', 'get-url', 'origin'], target);
    const existing = remote.stdout.trim().replace(/\.git$/, '');
    const wanted = parsed.url.replace(/\.git$/, '');
    const sameRepo = existing && (
      existing === wanted ||
      // https and ssh forms of the same repo are the same repo.
      existing.replace(/^git@([^:]+):/, 'https://$1/') === wanted ||
      wanted.replace(/^git@([^:]+):/, 'https://$1/') === existing
    );

    if (!sameRepo) {
      return {
        ok: false,
        message:
          `${target} already exists and points at a different repository (${redact(existing) || 'unknown'}). ` +
          `Move or delete that directory, or open it as a local folder instead.`,
      };
    }

    const fetch = runGit(['fetch', '--all', '--prune'], target, { token });
    if (!fetch.ok) {
      logger.warn('Reused a clone but could not fetch', { repo: parsed.repo, error: redact(fetch.stderr) });
    }
    if (opts.branch) {
      const checkout = runGit(['checkout', opts.branch], target, { token });
      if (!checkout.ok) {
        return { ok: false, message: `Cannot check out "${opts.branch}": ${redact(checkout.stderr).trim()}` };
      }
    }
    return {
      ok: true,
      source,
      reused: true,
      message: `Using the existing clone at ${target}${fetch.ok ? ' (fetched the latest refs)' : ''}.`,
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const args = ['clone'];
  if (opts.depth && opts.depth > 0) args.push('--depth', String(opts.depth));
  if (opts.branch) args.push('--branch', opts.branch);
  args.push(parsed.url, target);

  const clone = runGit(args, path.dirname(target), { token, timeoutMs: 900_000 });
  if (!clone.ok) {
    const stderr = redact(clone.stderr).trim();
    // The two failures worth naming, because the generic message sends people
    // hunting in entirely the wrong place.
    const hint = /Authentication failed|could not read Username|403/i.test(stderr)
      ? `\n\nBubbly could not authenticate. For an HTTPS URL it uses your git credential helper, then \`gh\`/\`glab\`, then a token you have saved. Sign in with \`gh auth login\`, or add a token in Settings → Connections.`
      : /Permission denied \(publickey\)/i.test(stderr)
      ? `\n\nThe server rejected your SSH key. Check \`ssh -T git@${parsed.host}\` works, and that your key is in the agent (\`ssh-add -l\`).`
      : '';
    return { ok: false, message: `Clone failed: ${stderr}${hint}` };
  }

  logger.info('Cloned a repository', { host: parsed.host, owner: parsed.owner, repo: parsed.repo, target });
  return { ok: true, source, message: `Cloned ${parsed.owner}/${parsed.repo} into ${target}.` };
}

export interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: number;
  remoteUrl: string;
  lastCommit?: { hash: string; subject: string; author: string; date: string };
}

/** Everything the UI shows about a repository workspace, in two git calls. */
export function repoStatus(localPath: string): RepoStatus | null {
  if (!fs.existsSync(path.join(localPath, '.git'))) return null;

  const status = runGit(['status', '--porcelain=v1', '-b'], localPath);
  if (!status.ok) return null;

  const lines = status.stdout.split('\n');
  const header = lines[0] ?? '';
  const branchMatch = /^## ([^.\s]+)/.exec(header);
  const aheadMatch = /ahead (\d+)/.exec(header);
  const behindMatch = /behind (\d+)/.exec(header);
  const changed = lines.slice(1).filter((l) => l.trim()).length;

  const log = runGit(['log', '-1', '--format=%h%x09%s%x09%an%x09%ad', '--date=relative'], localPath);
  const [hash, subject, author, date] = log.ok ? log.stdout.trim().split('\t') : [];

  return {
    branch: branchMatch?.[1] ?? 'HEAD',
    ahead: Number(aheadMatch?.[1] ?? 0),
    behind: Number(behindMatch?.[1] ?? 0),
    dirty: changed > 0,
    changedFiles: changed,
    remoteUrl: redact(runGit(['remote', 'get-url', 'origin'], localPath).stdout.trim()),
    lastCommit: hash ? { hash, subject, author, date } : undefined,
  };
}

/** Push the current branch, creating the upstream if it has none. */
export function pushCurrentBranch(localPath: string, opts: { setUpstream?: boolean } = {}): GitCommandResult {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], localPath).stdout.trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, stdout: '', stderr: 'Not on a branch (detached HEAD). Check out a branch before pushing.', exitCode: 1 };
  }
  const remote = runGit(['remote', 'get-url', 'origin'], localPath).stdout.trim();
  const parsed = parseRepoUrl(remote);
  const token = parsed && !parsed.ssh
    ? findForgeToken(parsed.forge === 'other' ? 'github' : parsed.forge, parsed.host)?.token
    : undefined;

  const args = opts.setUpstream !== false
    ? ['push', '--set-upstream', 'origin', branch]
    : ['push', 'origin', branch];
  const r = runGit(args, localPath, { token });
  return { ...r, stderr: redact(r.stderr) };
}
