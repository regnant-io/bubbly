/**
 * GitHub and GitLab, behind one interface.
 *
 * The two APIs disagree about almost everything at the surface — pulls vs merge
 * requests, `state=open` vs `state=opened`, `Authorization: Bearer` vs
 * `PRIVATE-TOKEN`, cursor pagination vs `Link` headers — and about very little
 * underneath. Every caller wants the same six things: list PRs, open one, read
 * one, comment on it, list issues, read the file tree of a branch.
 *
 * So the differences live here, once, and the agent gets a single tool whose
 * vocabulary does not change depending on which forge the repository is on.
 *
 * SELF-HOSTED IS THE DEFAULT ASSUMPTION, NOT AN AFTERTHOUGHT. The host is a
 * parameter everywhere; github.com and gitlab.com are just the common values.
 * Hard-coding them is how integrations quietly exclude every company that
 * matters.
 */

import { findForgeToken } from '../secrets/credentialSources';
import { logger } from '../utils/logger';

export type ForgeKind = 'github' | 'gitlab';

export interface ForgeTarget {
  forge: ForgeKind;
  /** Web host: github.com, ghe.acme.com, gitlab.com, gitlab.internal. */
  host: string;
  /** owner/name, or a GitLab group path (which may contain slashes). */
  owner: string;
  repo: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  body?: string;
  /** Populated only by `getPullRequest`. */
  changedFiles?: Array<{ path: string; additions: number; deletions: number; status: string }>;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  labels: string[];
  createdAt: string;
  body?: string;
}

const USER_AGENT = 'Bubbly';
const REQUEST_TIMEOUT_MS = 20_000;

/** The API base for a host. GitHub's differs between .com and Enterprise. */
export function apiBase(target: Pick<ForgeTarget, 'forge' | 'host'>): string {
  if (target.forge === 'github') {
    return /^(api\.)?github\.com$/i.test(target.host)
      ? 'https://api.github.com'
      : `https://${target.host}/api/v3`;
  }
  return `https://${target.host}/api/v4`;
}

/** GitLab addresses projects by URL-encoded "group/subgroup/project". */
function gitlabProjectId(target: ForgeTarget): string {
  return encodeURIComponent(`${target.owner}/${target.repo}`);
}

export class ForgeError extends Error {
  constructor(message: string, readonly status?: number, readonly hint?: string) {
    super(message);
    this.name = 'ForgeError';
  }
}

async function request<T>(
  target: ForgeTarget,
  pathname: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const lookup = findForgeToken(target.forge, target.host);
  if (!lookup) {
    throw new ForgeError(
      `No ${target.forge === 'github' ? 'GitHub' : 'GitLab'} credential for ${target.host}.`,
      401,
      target.forge === 'github'
        ? 'Run `gh auth login`, set GH_TOKEN, or add a token in Settings → Connections.'
        : 'Run `glab auth login`, set GITLAB_TOKEN, or add a token in Settings → Connections.',
    );
  }

  const url = new URL(`${apiBase(target)}${pathname}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: target.forge === 'github' ? 'application/vnd.github+json' : 'application/json',
  };
  if (target.forge === 'github') {
    headers.Authorization = `Bearer ${lookup.token}`;
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  } else {
    headers['PRIVATE-TOKEN'] = lookup.token;
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ForgeError(
        `${target.forge} API ${res.status} on ${init.method ?? 'GET'} ${pathname}: ${text.slice(0, 400)}`,
        res.status,
        explainStatus(res.status, target, lookup.source),
      );
    }

    // A 204 has no body; parsing it would throw on a perfectly good response.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ForgeError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ForgeError(`${target.host} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`, undefined,
        'Check the host is reachable, and that a VPN is connected if this is a private instance.');
    }
    throw new ForgeError(`Could not reach ${target.host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Say what a status code MEANS here, not what it means in general.
 *
 * A 404 from a forge API is almost never "no such thing" — it is "your token
 * cannot see that thing", because both forges hide private resources rather
 * than admitting they exist. An agent told "not found" goes and creates a
 * duplicate; an agent told "your token lacks repo scope" fixes the actual
 * problem.
 */
function explainStatus(status: number, target: ForgeTarget, source: string): string | undefined {
  if (status === 401) {
    return `The token (from ${source}) was rejected. It may have expired or been revoked.`;
  }
  if (status === 403) {
    return `Authenticated, but not permitted. On ${target.forge} this is usually a missing scope ` +
      `(${target.forge === 'github' ? '`repo` for private repositories, `workflow` for Actions' : '`api` scope'}) ` +
      `or a rate limit — check the response above for which.`;
  }
  if (status === 404) {
    return `Either it does not exist, or the token (from ${source}) cannot see it — both forges return 404 ` +
      `for private resources you lack access to rather than admitting they exist. Verify the owner/repo spelling first, then the token's scopes.`;
  }
  if (status === 422) {
    return 'The forge rejected the request as invalid — most often a pull request whose source and target branches are the same, or one that already exists.';
  }
  return undefined;
}

// --- Pull requests / merge requests -----------------------------------------

export async function listPullRequests(
  target: ForgeTarget,
  opts: { state?: 'open' | 'closed' | 'all'; limit?: number } = {},
): Promise<PullRequest[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const state = opts.state ?? 'open';

  if (target.forge === 'github') {
    const raw = await request<Array<Record<string, any>>>(target, `/repos/${target.owner}/${target.repo}/pulls`, {
      query: { state, per_page: limit },
    });
    return raw.map(githubPr);
  }

  const raw = await request<Array<Record<string, any>>>(target, `/projects/${gitlabProjectId(target)}/merge_requests`, {
    // GitLab spells the states differently, which is exactly the kind of
    // difference callers should never have to remember.
    query: { state: state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all', per_page: limit },
  });
  return raw.map(gitlabMr);
}

export async function getPullRequest(target: ForgeTarget, number: number): Promise<PullRequest> {
  if (target.forge === 'github') {
    const pr = await request<Record<string, any>>(target, `/repos/${target.owner}/${target.repo}/pulls/${number}`);
    const files = await request<Array<Record<string, any>>>(
      target, `/repos/${target.owner}/${target.repo}/pulls/${number}/files`, { query: { per_page: 100 } },
    ).catch(() => []);
    return {
      ...githubPr(pr),
      changedFiles: files.map((f) => ({
        path: String(f.filename), additions: Number(f.additions ?? 0),
        deletions: Number(f.deletions ?? 0), status: String(f.status ?? 'modified'),
      })),
    };
  }

  const mr = await request<Record<string, any>>(target, `/projects/${gitlabProjectId(target)}/merge_requests/${number}`);
  const changes = await request<Record<string, any>>(
    target, `/projects/${gitlabProjectId(target)}/merge_requests/${number}/changes`,
  ).catch(() => ({ changes: [] }));
  return {
    ...gitlabMr(mr),
    changedFiles: (changes.changes ?? []).map((c: Record<string, any>) => ({
      path: String(c.new_path ?? c.old_path),
      // GitLab does not give per-file counts on this endpoint; reporting 0 is
      // honest, inventing a number from the diff text would not be.
      additions: 0,
      deletions: 0,
      status: c.new_file ? 'added' : c.deleted_file ? 'removed' : c.renamed_file ? 'renamed' : 'modified',
    })),
  };
}

export async function createPullRequest(
  target: ForgeTarget,
  opts: { title: string; body?: string; sourceBranch: string; targetBranch: string; draft?: boolean },
): Promise<PullRequest> {
  if (target.forge === 'github') {
    const pr = await request<Record<string, any>>(target, `/repos/${target.owner}/${target.repo}/pulls`, {
      method: 'POST',
      body: {
        title: opts.title, body: opts.body ?? '',
        head: opts.sourceBranch, base: opts.targetBranch, draft: opts.draft ?? false,
      },
    });
    return githubPr(pr);
  }

  const mr = await request<Record<string, any>>(target, `/projects/${gitlabProjectId(target)}/merge_requests`, {
    method: 'POST',
    body: {
      title: opts.draft ? `Draft: ${opts.title}` : opts.title,
      description: opts.body ?? '',
      source_branch: opts.sourceBranch,
      target_branch: opts.targetBranch,
    },
  });
  return gitlabMr(mr);
}

export async function commentOnPullRequest(target: ForgeTarget, number: number, body: string): Promise<void> {
  if (target.forge === 'github') {
    await request(target, `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, {
      method: 'POST', body: { body },
    });
    return;
  }
  await request(target, `/projects/${gitlabProjectId(target)}/merge_requests/${number}/notes`, {
    method: 'POST', body: { body },
  });
}

// --- Issues -----------------------------------------------------------------

export async function listIssues(
  target: ForgeTarget,
  opts: { state?: 'open' | 'closed' | 'all'; limit?: number; labels?: string } = {},
): Promise<Issue[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const state = opts.state ?? 'open';

  if (target.forge === 'github') {
    const raw = await request<Array<Record<string, any>>>(target, `/repos/${target.owner}/${target.repo}/issues`, {
      query: { state, per_page: limit, labels: opts.labels },
    });
    // GitHub returns pull requests from the issues endpoint. Almost nobody
    // wants that, and a "list issues" that is half PRs is actively misleading.
    return raw.filter((i) => !i.pull_request).map(githubIssue);
  }

  const raw = await request<Array<Record<string, any>>>(target, `/projects/${gitlabProjectId(target)}/issues`, {
    query: { state: state === 'open' ? 'opened' : state, per_page: limit, labels: opts.labels },
  });
  return raw.map(gitlabIssue);
}

export async function getIssue(target: ForgeTarget, number: number): Promise<Issue> {
  if (target.forge === 'github') {
    return githubIssue(await request<Record<string, any>>(target, `/repos/${target.owner}/${target.repo}/issues/${number}`));
  }
  return gitlabIssue(await request<Record<string, any>>(target, `/projects/${gitlabProjectId(target)}/issues/${number}`));
}

export async function commentOnIssue(target: ForgeTarget, number: number, body: string): Promise<void> {
  if (target.forge === 'github') {
    await request(target, `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
    return;
  }
  await request(target, `/projects/${gitlabProjectId(target)}/issues/${number}/notes`, { method: 'POST', body: { body } });
}

// --- Identity ---------------------------------------------------------------

/** Who the current token belongs to — the "Test connection" answer. */
export async function whoAmI(forge: ForgeKind, host: string): Promise<{ username: string; name?: string }> {
  const target: ForgeTarget = { forge, host, owner: '', repo: '' };
  if (forge === 'github') {
    const me = await request<Record<string, any>>(target, '/user');
    return { username: String(me.login), name: me.name ? String(me.name) : undefined };
  }
  const me = await request<Record<string, any>>(target, '/user');
  return { username: String(me.username), name: me.name ? String(me.name) : undefined };
}

/** Repositories the token can see, for the "open a repository" picker. */
export async function listRepositories(
  forge: ForgeKind,
  host: string,
  opts: { limit?: number; search?: string } = {},
): Promise<Array<{ fullName: string; url: string; description?: string; private: boolean; updatedAt: string }>> {
  const target: ForgeTarget = { forge, host, owner: '', repo: '' };
  const limit = Math.min(opts.limit ?? 30, 100);

  if (forge === 'github') {
    const raw = await request<Array<Record<string, any>>>(target, '/user/repos', {
      query: { per_page: limit, sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
    });
    const filtered = opts.search
      ? raw.filter((r) => String(r.full_name).toLowerCase().includes(opts.search!.toLowerCase()))
      : raw;
    return filtered.map((r) => ({
      fullName: String(r.full_name),
      url: String(r.clone_url),
      description: r.description ? String(r.description) : undefined,
      private: !!r.private,
      updatedAt: String(r.updated_at),
    }));
  }

  const raw = await request<Array<Record<string, any>>>(target, '/projects', {
    query: { membership: 'true', per_page: limit, order_by: 'last_activity_at', search: opts.search },
  });
  return raw.map((r) => ({
    fullName: String(r.path_with_namespace),
    url: String(r.http_url_to_repo),
    description: r.description ? String(r.description) : undefined,
    private: r.visibility !== 'public',
    updatedAt: String(r.last_activity_at),
  }));
}

// --- Shape adapters ---------------------------------------------------------

function githubPr(pr: Record<string, any>): PullRequest {
  return {
    number: Number(pr.number),
    title: String(pr.title),
    state: String(pr.state),
    author: String(pr.user?.login ?? 'unknown'),
    sourceBranch: String(pr.head?.ref ?? ''),
    targetBranch: String(pr.base?.ref ?? ''),
    url: String(pr.html_url),
    draft: !!pr.draft,
    createdAt: String(pr.created_at),
    updatedAt: String(pr.updated_at),
    body: pr.body ? String(pr.body) : undefined,
  };
}

function gitlabMr(mr: Record<string, any>): PullRequest {
  return {
    number: Number(mr.iid),
    title: String(mr.title).replace(/^Draft:\s*/i, ''),
    state: String(mr.state) === 'opened' ? 'open' : String(mr.state),
    author: String(mr.author?.username ?? 'unknown'),
    sourceBranch: String(mr.source_branch ?? ''),
    targetBranch: String(mr.target_branch ?? ''),
    url: String(mr.web_url),
    draft: !!mr.draft || /^Draft:/i.test(String(mr.title)),
    createdAt: String(mr.created_at),
    updatedAt: String(mr.updated_at),
    body: mr.description ? String(mr.description) : undefined,
  };
}

function githubIssue(i: Record<string, any>): Issue {
  return {
    number: Number(i.number),
    title: String(i.title),
    state: String(i.state),
    author: String(i.user?.login ?? 'unknown'),
    url: String(i.html_url),
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : String(l.name))),
    createdAt: String(i.created_at),
    body: i.body ? String(i.body) : undefined,
  };
}

function gitlabIssue(i: Record<string, any>): Issue {
  return {
    number: Number(i.iid),
    title: String(i.title),
    state: String(i.state) === 'opened' ? 'open' : String(i.state),
    author: String(i.author?.username ?? 'unknown'),
    url: String(i.web_url),
    labels: (i.labels ?? []).map(String),
    createdAt: String(i.created_at),
    body: i.description ? String(i.description) : undefined,
  };
}

/** Log a forge call without ever logging the token. */
export function logForgeCall(target: ForgeTarget, action: string): void {
  logger.info('Forge API call', { forge: target.forge, host: target.host, repo: `${target.owner}/${target.repo}`, action });
}
