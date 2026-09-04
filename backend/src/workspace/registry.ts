/**
 * The one place that answers "where does this thread's work happen".
 *
 * Every tool asks for a provider by workspace, and gets back something that
 * behaves identically whether the files are on this disk or on a machine three
 * time zones away. Providers are CACHED per source, because an SSH provider
 * holds a live authenticated connection and creating one per tool call would
 * reintroduce the handshake cost the persistent connection exists to avoid.
 *
 * A NOTE ON THE LOCAL FAST PATH
 *
 * `providerForWorkspacePath` returns a local provider for any plain path with
 * no registered source. That is not a fallback for missing data — it is the
 * common case, and it means every existing call site keeps working unchanged
 * while remote sources are opt-in. A migration that required every caller to
 * know about sources up front would have been a much larger and much riskier
 * change for no user-visible benefit.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { logger } from '../utils/logger';
import { deleteSecret, setSecret } from '../secrets/vault';
import { discoverSshHosts } from '../secrets/credentialSources';
import { LocalProvider } from './localProvider';
import { SshProvider } from './sshProvider';
import type {
  ForgeAccount, GitSource, SshConnection, WorkspaceProvider, WorkspaceSource,
} from './types';

// --- SSH connections --------------------------------------------------------

interface SshRow {
  id: string; name: string; host: string; port: number; username: string;
  auth: string; private_key_path: string | null; default_path: string | null;
  from_ssh_config: number; created_at: string; last_used_at: string | null;
}

function rowToConnection(r: SshRow): SshConnection {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    auth: (r.auth as SshConnection['auth']) ?? 'agent',
    privateKeyPath: r.private_key_path ?? undefined,
    defaultPath: r.default_path ?? undefined,
    fromSshConfig: r.from_ssh_config === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  };
}

export function listSshConnections(): SshConnection[] {
  const rows = getDb().prepare('SELECT * FROM ssh_connections ORDER BY last_used_at DESC, name ASC').all() as SshRow[];
  return rows.map(rowToConnection);
}

export function getSshConnection(id: string): SshConnection | null {
  const row = getDb().prepare('SELECT * FROM ssh_connections WHERE id = ?').get(id) as SshRow | undefined;
  return row ? rowToConnection(row) : null;
}

export interface SaveSshInput {
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  auth: SshConnection['auth'];
  privateKeyPath?: string;
  defaultPath?: string;
  fromSshConfig?: boolean;
  /** Written straight to the vault and never returned or logged. */
  passphrase?: string;
  password?: string;
}

export function saveSshConnection(input: SaveSshInput): SshConnection {
  const db = getDb();
  const id = input.id ?? `ssh_${uuidv4().slice(0, 8)}`;
  const existing = input.id ? getSshConnection(input.id) : null;

  if (existing) {
    db.prepare(`
      UPDATE ssh_connections
         SET name = ?, host = ?, port = ?, username = ?, auth = ?,
             private_key_path = ?, default_path = ?
       WHERE id = ?
    `).run(
      input.name, input.host, input.port ?? 22, input.username, input.auth,
      input.privateKeyPath ?? null, input.defaultPath ?? null, id,
    );
  } else {
    db.prepare(`
      INSERT INTO ssh_connections (id, name, host, port, username, auth, private_key_path, default_path, from_ssh_config, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.host, input.port ?? 22, input.username, input.auth,
      input.privateKeyPath ?? null, input.defaultPath ?? null,
      input.fromSshConfig ? 1 : 0, new Date().toISOString(),
    );
  }

  // Secrets never touch the database. An EMPTY string means "clear it"; an
  // absent field means "leave whatever is stored alone", so editing a
  // connection's port does not silently wipe its passphrase.
  if (input.passphrase !== undefined) {
    if (input.passphrase) setSecret(`ssh:${id}:passphrase`, input.passphrase);
    else deleteSecret(`ssh:${id}:passphrase`);
  }
  if (input.password !== undefined) {
    if (input.password) setSecret(`ssh:${id}:password`, input.password);
    else deleteSecret(`ssh:${id}:password`);
  }

  logger.info('SSH connection saved', { id, host: input.host, auth: input.auth });
  return getSshConnection(id)!;
}

export function deleteSshConnection(id: string): void {
  getDb().prepare('DELETE FROM ssh_connections WHERE id = ?').run(id);
  deleteSecret(`ssh:${id}:passphrase`);
  deleteSecret(`ssh:${id}:password`);
  // Drop any cached provider so the next use cannot reach a deleted host.
  for (const [key, entry] of providerCache) {
    if (key.startsWith(`ssh:${id}:`)) {
      void entry.provider.dispose();
      providerCache.delete(key);
    }
  }
  logger.info('SSH connection deleted', { id });
}

export function markSshConnectionUsed(id: string): void {
  try {
    getDb().prepare('UPDATE ssh_connections SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  } catch { /* usage tracking must never fail a connection */ }
}

/**
 * Offer the hosts already in `~/.ssh/config` as connections.
 *
 * Most people's real connection details live there, and re-typing four fields
 * they already wrote down once is the kind of friction that makes a feature go
 * unused. Nothing is saved without the user choosing it — this only produces
 * candidates.
 */
export function sshConfigCandidates(): Array<SaveSshInput & { alreadySaved: boolean }> {
  const saved = listSshConnections();
  return discoverSshHosts().map((h) => ({
    name: h.host,
    host: h.hostName || h.host,
    port: h.port ?? 22,
    username: h.user || process.env.USER || process.env.USERNAME || 'root',
    auth: h.identityFile ? 'key' : 'agent',
    privateKeyPath: h.identityFile,
    fromSshConfig: true,
    alreadySaved: saved.some((s) => s.host === (h.hostName || h.host) && s.username === (h.user || '')),
  }));
}

// --- Forge accounts ---------------------------------------------------------

interface ForgeRow {
  id: string; forge: string; host: string; username: string | null;
  token_source: string; created_at: string; last_used_at: string | null;
}

function rowToForge(r: ForgeRow): ForgeAccount {
  return {
    id: r.id,
    forge: r.forge as ForgeAccount['forge'],
    host: r.host,
    username: r.username ?? undefined,
    tokenSource: r.token_source as ForgeAccount['tokenSource'],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
  };
}

export function listForgeAccounts(): ForgeAccount[] {
  const rows = getDb().prepare('SELECT * FROM forge_accounts ORDER BY forge, host').all() as ForgeRow[];
  return rows.map(rowToForge);
}

export function saveForgeAccount(input: {
  forge: ForgeAccount['forge'];
  host: string;
  username?: string;
  tokenSource: ForgeAccount['tokenSource'];
  /** Stored in the vault, never in the row. */
  token?: string;
}): ForgeAccount {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM forge_accounts WHERE forge = ? AND host = ?')
    .get(input.forge, input.host) as ForgeRow | undefined;
  const id = existing?.id ?? `forge_${uuidv4().slice(0, 8)}`;

  if (existing) {
    db.prepare('UPDATE forge_accounts SET username = ?, token_source = ? WHERE id = ?')
      .run(input.username ?? existing.username, input.tokenSource, id);
  } else {
    db.prepare(`
      INSERT INTO forge_accounts (id, forge, host, username, token_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.forge, input.host, input.username ?? null, input.tokenSource, new Date().toISOString());
  }

  if (input.token) setSecret(`${input.forge}:${input.host}:token`, input.token);

  logger.info('Forge account saved', { forge: input.forge, host: input.host, tokenSource: input.tokenSource });
  return rowToForge(db.prepare('SELECT * FROM forge_accounts WHERE id = ?').get(id) as ForgeRow);
}

export function deleteForgeAccount(id: string): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM forge_accounts WHERE id = ?').get(id) as ForgeRow | undefined;
  if (!row) return;
  db.prepare('DELETE FROM forge_accounts WHERE id = ?').run(id);
  deleteSecret(`${row.forge}:${row.host}:token`);
  logger.info('Forge account deleted', { id, forge: row.forge, host: row.host });
}

// --- Providers --------------------------------------------------------------

interface CacheEntry {
  provider: WorkspaceProvider;
  lastUsed: number;
}

const providerCache = new Map<string, CacheEntry>();

function cacheKey(source: WorkspaceSource): string {
  switch (source.kind) {
    case 'local': return `local:${source.path}`;
    case 'ssh': return `ssh:${source.connectionId}:${source.remotePath}`;
    case 'git': return `local:${source.localPath}`;
  }
}

/**
 * The provider for a source, creating and caching one if needed.
 *
 * A git source resolves to a LOCAL provider over its clone — which is the whole
 * point of cloning. Nothing downstream needs to know the directory came from a
 * repository; the git-specific operations (status, push, PR) are separate tools,
 * not a different filesystem.
 */
export function providerFor(source: WorkspaceSource): WorkspaceProvider {
  const key = cacheKey(source);
  const hit = providerCache.get(key);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.provider;
  }

  let provider: WorkspaceProvider;
  if (source.kind === 'ssh') {
    const connection = getSshConnection(source.connectionId);
    if (!connection) {
      throw new Error(
        `This thread uses a saved SSH connection (${source.connectionId}) that no longer exists. ` +
        `Re-create it in Settings → Connections, or open the workspace locally.`,
      );
    }
    markSshConnectionUsed(connection.id);
    provider = new SshProvider(connection, source.remotePath);
  } else {
    provider = new LocalProvider(source.kind === 'git' ? source.localPath : source.path);
  }

  providerCache.set(key, { provider, lastUsed: Date.now() });
  return provider;
}

/** The source recorded for a thread, or a local one derived from its path. */
export function sourceForSession(sessionId: string, fallbackPath: string): WorkspaceSource {
  try {
    const row = getDb()
      .prepare('SELECT source_kind, source_config FROM sessions WHERE id = ?')
      .get(sessionId) as { source_kind?: string; source_config?: string } | undefined;

    if (row?.source_kind && row.source_kind !== 'local' && row.source_config) {
      const parsed = JSON.parse(row.source_config) as WorkspaceSource;
      if (parsed && parsed.kind === row.source_kind) return parsed;
    }
  } catch (err) {
    logger.warn('Could not read a session source; treating it as local', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  return { kind: 'local', path: fallbackPath };
}

export function setSessionSource(sessionId: string, source: WorkspaceSource): void {
  getDb()
    .prepare('UPDATE sessions SET source_kind = ?, source_config = ? WHERE id = ?')
    .run(source.kind, JSON.stringify(source), sessionId);
}

/**
 * The provider for a bare workspace path.
 *
 * The bridge that lets every existing tool keep its signature. A path that
 * belongs to a registered remote source resolves to that source's provider;
 * anything else is a local directory, which is what it has always been.
 */
export function providerForWorkspacePath(workspacePath: string): WorkspaceProvider {
  const registered = remotePathIndex.get(workspacePath);
  if (registered) return providerFor(registered);
  return providerFor({ kind: 'local', path: workspacePath });
}

/**
 * Remote workspaces addressed by a synthetic local-looking path.
 *
 * Tools pass a `workspacePath` string everywhere. Rather than change that
 * signature in forty places, a remote workspace registers a stable synthetic
 * path (`ssh://<connection>/<remote path>`) which this index maps back to its
 * source. The alternative — threading a source object through every call —
 * would have touched every tool and every test for no behavioural gain.
 */
const remotePathIndex = new Map<string, WorkspaceSource>();

/** The synthetic path that stands for a remote workspace. */
export function syntheticPathFor(source: WorkspaceSource): string {
  switch (source.kind) {
    case 'local': return source.path;
    case 'git': return source.localPath;
    case 'ssh': return `ssh://${source.connectionId}${source.remotePath.startsWith('/') ? '' : '/'}${source.remotePath}`;
  }
}

export function registerRemoteWorkspace(source: WorkspaceSource): string {
  const p = syntheticPathFor(source);
  if (source.kind !== 'local') remotePathIndex.set(p, source);
  return p;
}

export function isRemotePath(workspacePath: string): boolean {
  return remotePathIndex.has(workspacePath) || workspacePath.startsWith('ssh://');
}

/** Rehydrate the index from every thread that has a remote source. Called at boot. */
export function restoreRemoteWorkspaces(): void {
  try {
    const rows = getDb()
      .prepare("SELECT source_config FROM sessions WHERE source_kind IN ('ssh','git') AND source_config IS NOT NULL")
      .all() as Array<{ source_config: string }>;
    let restored = 0;
    for (const row of rows) {
      try {
        const source = JSON.parse(row.source_config) as WorkspaceSource;
        if (source?.kind === 'ssh' || source?.kind === 'git') {
          registerRemoteWorkspace(source);
          restored++;
        }
      } catch { /* one unreadable row must not stop the rest */ }
    }
    if (restored > 0) logger.info('Restored remote workspaces', { count: restored });
  } catch (err) {
    // A pre-migration database has no such columns. Not an error.
    logger.debug('No remote workspaces to restore', { error: String(err) });
  }
}

/** Close every cached provider. Called on shutdown. */
export async function disposeAllProviders(): Promise<void> {
  const entries = [...providerCache.values()];
  providerCache.clear();
  await Promise.all(entries.map((e) => e.provider.dispose().catch(() => undefined)));
}

/** A git source's clone directory, for the UI and for git tools. */
export function gitSourceFor(workspacePath: string): GitSource | null {
  const source = remotePathIndex.get(workspacePath);
  if (source?.kind === 'git') return source;
  // A git workspace is addressed by its clone path, so also look it up that way.
  for (const s of remotePathIndex.values()) {
    if (s.kind === 'git' && s.localPath === workspacePath) return s;
  }
  return null;
}
