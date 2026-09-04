/**
 * Repository and forge operations, as tools.
 *
 * TWO TOOLS, NOT TWELVE.
 *
 * The obvious design is one tool per operation: list_pull_requests,
 * create_pull_request, get_pull_request, comment_on_pull_request,
 * list_issues, get_issue… Twelve near-identical descriptions, all starting
 * "work with GitHub", differing in ways the model has to remember rather than
 * discover — which is exactly the failure the search tools already went through
 * and were consolidated to fix.
 *
 * So: `repo` for the working tree (status, branch, commit, push) and `forge`
 * for the hosted side (pull requests, issues). Each takes an `action`, and the
 * actions are the vocabulary a developer already uses.
 *
 * WHAT THESE DELIBERATELY DO NOT DO
 *
 * Nothing here merges, force-pushes, or closes anything. Those are the
 * operations whose blast radius extends to other people's work, they are all
 * one click away in a browser, and an agent that can do them will eventually do
 * one at the wrong moment. Opening a pull request is the right boundary: it
 * proposes, a human disposes.
 */

import type { ToolDefinition } from '../../types';
import { logger } from '../../utils/logger';
import {
  cloneOrReuse, parseRepoUrl, pushCurrentBranch, redact, repoStatus, runGit,
} from '../../workspace/gitSource';
import {
  commentOnIssue, commentOnPullRequest, createPullRequest, getIssue, getPullRequest,
  listIssues, listPullRequests, listRepositories, whoAmI, ForgeError, type ForgeTarget,
} from '../../workspace/forge';
import { gitSourceFor } from '../../workspace/registry';

export const REPOSITORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'repo',
    description:
      'The git working tree of this workspace: what has changed, which branch, committing, and pushing.\n' +
      'Actions: "status" (branch, ahead/behind, changed files, last commit), "branch" (create and switch), ' +
      '"commit" (stage everything and commit), "push" (push the current branch, creating its upstream if needed), ' +
      '"diff" (unified diff of what changed), "log" (recent commits).\n' +
      'Use status before committing, always — an agent that commits without looking commits whatever else happened to be in the tree.\n' +
      'This does NOT merge, force-push, rebase or delete branches. Those change other people\'s work and stay with the human.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'branch', 'commit', 'push', 'diff', 'log'] },
        name: { type: 'string', description: 'For "branch": the branch to create and switch to.' },
        message: { type: 'string', description: 'For "commit": the commit message. Write a real one — subject line, then why if it is not obvious.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'For "commit": stage only these paths. Omit to stage everything that changed.' },
        limit: { type: 'number', description: 'For "log": how many commits (default 10).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'forge',
    description:
      'The hosted side of the repository — GitHub or GitLab, including self-hosted instances. Works the same for both.\n' +
      'Actions: "list_prs", "get_pr", "create_pr", "comment_pr", "list_issues", "get_issue", "comment_issue", "whoami", "list_repos".\n' +
      'A pull request needs the branch to be PUSHED first — use repo(action:"push"). Creating one from an unpushed branch fails with a confusing error from the forge.\n' +
      'Reading an issue before implementing it is usually worth the call: the discussion underneath it is where the actual requirements are.\n' +
      'Merging and closing are deliberately not available: this proposes changes, a human decides on them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_prs', 'get_pr', 'create_pr', 'comment_pr', 'list_issues', 'get_issue', 'comment_issue', 'whoami', 'list_repos'],
        },
        number: { type: 'number', description: 'PR or issue number, for the get_/comment_ actions.' },
        title: { type: 'string', description: 'For create_pr.' },
        body: { type: 'string', description: 'For create_pr and the comment actions. Markdown.' },
        source_branch: { type: 'string', description: 'For create_pr: the branch with your changes. Defaults to the current branch.' },
        target_branch: { type: 'string', description: 'For create_pr: what to merge into. Defaults to the repository default branch.' },
        draft: { type: 'boolean', description: 'For create_pr: open it as a draft. Prefer this when the work is not finished.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'For the list actions. Default open.' },
        labels: { type: 'string', description: 'For list_issues: comma-separated label filter.' },
        limit: { type: 'number', description: 'For the list actions (default 20, max 100).' },
        search: { type: 'string', description: 'For list_repos: filter by name.' },
      },
      required: ['action'],
    },
  },
];

/** The forge coordinates of the repository this workspace came from. */
function targetFor(workspacePath: string): ForgeTarget | { error: string } {
  const source = gitSourceFor(workspacePath);
  if (source?.forge && source.forge !== 'other' && source.host && source.owner && source.repo) {
    return { forge: source.forge, host: source.host, owner: source.owner, repo: source.repo };
  }

  // Not opened as a Git source, but the directory may still be a clone — which
  // is the common case for a local folder the user has been working in for
  // months. Reading `origin` is one command and saves them re-opening it.
  const remote = runGit(['remote', 'get-url', 'origin'], workspacePath);
  if (!remote.ok || !remote.stdout.trim()) {
    return {
      error:
        'This workspace has no git remote, so there is no GitHub/GitLab project to talk to. ' +
        'Open it as a repository source, or add a remote with git.',
    };
  }
  const parsed = parseRepoUrl(remote.stdout.trim());
  if (!parsed) return { error: `Could not understand the origin URL: ${redact(remote.stdout.trim())}` };
  if (parsed.forge === 'other') {
    return {
      error:
        `${parsed.host} is not a GitHub or GitLab host that Bubbly recognises, so pull requests and issues are not available. ` +
        `Ordinary git operations (repo tool) still work.`,
    };
  }
  return { forge: parsed.forge, host: parsed.host, owner: parsed.owner, repo: parsed.repo };
}

function currentBranch(workspacePath: string): string {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath).stdout.trim();
}

function defaultBranch(workspacePath: string): string {
  // The symbolic ref is the authoritative answer and is usually present after a
  // clone; the fallback covers repositories where it was never fetched.
  const ref = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], workspacePath).stdout.trim();
  const m = /refs\/remotes\/origin\/(.+)$/.exec(ref);
  if (m) return m[1];
  for (const candidate of ['main', 'master']) {
    if (runGit(['rev-parse', '--verify', `origin/${candidate}`], workspacePath).ok) return candidate;
  }
  return 'main';
}

export async function executeRepositoryTool(
  tool: string,
  args: Record<string, unknown>,
  workspacePath: string,
): Promise<string> {
  if (tool === 'repo') return executeRepo(args, workspacePath);
  if (tool === 'forge') return executeForge(args, workspacePath);
  return `Unknown repository tool: ${tool}`;
}

async function executeRepo(args: Record<string, unknown>, workspacePath: string): Promise<string> {
  const action = String(args.action ?? 'status');

  switch (action) {
    case 'status': {
      const status = repoStatus(workspacePath);
      if (!status) return 'This workspace is not a git repository.';
      const lines = [
        `Branch: ${status.branch}`,
        status.ahead || status.behind
          ? `Ahead ${status.ahead}, behind ${status.behind} of the upstream.`
          : 'In step with the upstream.',
        status.dirty
          ? `${status.changedFiles} file(s) changed and not committed.`
          : 'Working tree clean.',
        status.lastCommit
          ? `Last commit: ${status.lastCommit.hash} "${status.lastCommit.subject}" by ${status.lastCommit.author}, ${status.lastCommit.date}`
          : 'No commits yet.',
        `Remote: ${status.remoteUrl || '(none)'}`,
      ];
      return lines.join('\n');
    }

    case 'branch': {
      const name = String(args.name ?? '').trim();
      if (!name) return 'FAILED: branch needs a name.';
      if (!/^[\w./-]+$/.test(name)) {
        return `FAILED: "${name}" is not a valid branch name. Use letters, digits, dots, dashes, underscores and slashes.`;
      }
      const existing = runGit(['rev-parse', '--verify', name], workspacePath);
      const r = existing.ok
        ? runGit(['checkout', name], workspacePath)
        : runGit(['checkout', '-b', name], workspacePath);
      if (!r.ok) return `FAILED: ${redact(r.stderr).trim()}`;
      return existing.ok ? `Switched to the existing branch ${name}.` : `Created and switched to ${name}.`;
    }

    case 'commit': {
      const message = String(args.message ?? '').trim();
      if (!message) return 'FAILED: a commit needs a message.';

      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : null;
      const add = paths && paths.length > 0
        ? runGit(['add', '--', ...paths], workspacePath)
        : runGit(['add', '-A'], workspacePath);
      if (!add.ok) return `FAILED to stage: ${redact(add.stderr).trim()}`;

      const staged = runGit(['diff', '--cached', '--name-only'], workspacePath).stdout.trim();
      if (!staged) return 'Nothing to commit — no changes are staged.';

      const r = runGit(['commit', '-m', message], workspacePath);
      if (!r.ok) return `FAILED to commit: ${redact(r.stderr || r.stdout).trim()}`;
      return `Committed ${staged.split('\n').length} file(s):\n${r.stdout.trim()}`;
    }

    case 'push': {
      const r = pushCurrentBranch(workspacePath);
      if (!r.ok) {
        const hint = /rejected|non-fast-forward/i.test(r.stderr)
          ? '\n\nThe remote has commits you do not. Pull and rebase, then push again — do NOT force-push; that discards someone else\'s work.'
          : /Authentication|could not read Username|403/i.test(r.stderr)
          ? '\n\nAuthentication failed. Bubbly uses your git credential helper, then gh/glab, then a saved token. `gh auth login` is usually the fix.'
          : '';
        return `FAILED to push: ${r.stderr.trim()}${hint}`;
      }
      return `Pushed ${currentBranch(workspacePath)}.\n${(r.stderr || r.stdout).trim()}`;
    }

    case 'diff': {
      const r = runGit(['diff', '--stat'], workspacePath);
      const full = runGit(['diff'], workspacePath);
      const body = full.stdout.length > 20_000
        ? `${full.stdout.slice(0, 20_000)}\n…(diff truncated; use repo status or look at specific files)`
        : full.stdout;
      return `${r.stdout.trim() || 'No unstaged changes.'}\n\n${body}`.trim();
    }

    case 'log': {
      const n = Math.min(Number(args.limit ?? 10) || 10, 100);
      const r = runGit(['log', `-${n}`, '--format=%h %ad %an: %s', '--date=short'], workspacePath);
      return r.stdout.trim() || 'No commits yet.';
    }

    default:
      return `Unknown repo action "${action}". Use status, branch, commit, push, diff or log.`;
  }
}

async function executeForge(args: Record<string, unknown>, workspacePath: string): Promise<string> {
  const action = String(args.action ?? '');

  try {
    // whoami and list_repos are account-level and do not need a repository.
    if (action === 'whoami' || action === 'list_repos') {
      const resolved = targetFor(workspacePath);
      const forge = 'error' in resolved ? 'github' : resolved.forge;
      const host = 'error' in resolved ? 'github.com' : resolved.host;

      if (action === 'whoami') {
        const me = await whoAmI(forge, host);
        return `Signed in to ${host} as ${me.username}${me.name ? ` (${me.name})` : ''}.`;
      }
      const repos = await listRepositories(forge, host, {
        limit: Number(args.limit ?? 30) || 30,
        search: args.search ? String(args.search) : undefined,
      });
      if (repos.length === 0) return `No repositories visible on ${host} with this token.`;
      return repos.map((r) => `${r.fullName}${r.private ? ' (private)' : ''} — ${r.description ?? 'no description'}`).join('\n');
    }

    const target = targetFor(workspacePath);
    if ('error' in target) return `FAILED: ${target.error}`;

    switch (action) {
      case 'list_prs': {
        const prs = await listPullRequests(target, {
          state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
          limit: Number(args.limit ?? 20) || 20,
        });
        if (prs.length === 0) return `No ${args.state ?? 'open'} pull requests in ${target.owner}/${target.repo}.`;
        return prs.map((p) =>
          `#${p.number} ${p.draft ? '[draft] ' : ''}${p.title}\n` +
          `   ${p.sourceBranch} → ${p.targetBranch} · by ${p.author} · ${p.url}`).join('\n');
      }

      case 'get_pr': {
        const number = Number(args.number);
        if (!number) return 'FAILED: get_pr needs a number.';
        const pr = await getPullRequest(target, number);
        const files = pr.changedFiles?.length
          ? `\n\nChanged files (${pr.changedFiles.length}):\n` +
            pr.changedFiles.slice(0, 50).map((f) => `  ${f.status.padEnd(9)} ${f.path} +${f.additions} −${f.deletions}`).join('\n')
          : '';
        return (
          `#${pr.number} ${pr.title}${pr.draft ? ' [draft]' : ''}\n` +
          `${pr.sourceBranch} → ${pr.targetBranch} · ${pr.state} · by ${pr.author}\n${pr.url}\n\n` +
          `${pr.body?.trim() || '(no description)'}${files}`
        );
      }

      case 'create_pr': {
        const title = String(args.title ?? '').trim();
        if (!title) return 'FAILED: create_pr needs a title.';
        const source = String(args.source_branch ?? currentBranch(workspacePath));
        const base = String(args.target_branch ?? defaultBranch(workspacePath));
        if (source === base) {
          return `FAILED: the source and target branch are both "${source}". Create a branch for your work first (repo action:"branch").`;
        }

        // A branch the forge cannot see produces an error that reads like a
        // permissions problem, so check it here where the fix is obvious.
        const pushed = runGit(['rev-parse', '--verify', `origin/${source}`], workspacePath);
        if (!pushed.ok) {
          return `FAILED: the branch "${source}" has not been pushed yet, so ${target.host} cannot see it. Run repo(action:"push") first.`;
        }

        const pr = await createPullRequest(target, {
          title,
          body: args.body ? String(args.body) : undefined,
          sourceBranch: source,
          targetBranch: base,
          draft: args.draft === true,
        });
        logger.info('Opened a pull request', { repo: `${target.owner}/${target.repo}`, number: pr.number });
        return `Opened #${pr.number}: ${pr.title}\n${pr.url}`;
      }

      case 'comment_pr': {
        const number = Number(args.number);
        const body = String(args.body ?? '').trim();
        if (!number || !body) return 'FAILED: comment_pr needs a number and a body.';
        await commentOnPullRequest(target, number, body);
        return `Commented on #${number}.`;
      }

      case 'list_issues': {
        const issues = await listIssues(target, {
          state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
          limit: Number(args.limit ?? 20) || 20,
          labels: args.labels ? String(args.labels) : undefined,
        });
        if (issues.length === 0) return `No ${args.state ?? 'open'} issues in ${target.owner}/${target.repo}.`;
        return issues.map((i) =>
          `#${i.number} ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}\n   by ${i.author} · ${i.url}`).join('\n');
      }

      case 'get_issue': {
        const number = Number(args.number);
        if (!number) return 'FAILED: get_issue needs a number.';
        const issue = await getIssue(target, number);
        return (
          `#${issue.number} ${issue.title} (${issue.state})\n` +
          `by ${issue.author}${issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}\n${issue.url}\n\n` +
          `${issue.body?.trim() || '(no description)'}`
        );
      }

      case 'comment_issue': {
        const number = Number(args.number);
        const body = String(args.body ?? '').trim();
        if (!number || !body) return 'FAILED: comment_issue needs a number and a body.';
        await commentOnIssue(target, number, body);
        return `Commented on issue #${number}.`;
      }

      default:
        return `Unknown forge action "${action}".`;
    }
  } catch (err) {
    if (err instanceof ForgeError) {
      return `FAILED: ${err.message}${err.hint ? `\n\n${err.hint}` : ''}`;
    }
    return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Clone a repository as a workspace. Used by the API, not exposed as a tool. */
export function openRepository(url: string, opts: { branch?: string; depth?: number } = {}) {
  return cloneOrReuse(url, opts);
}
