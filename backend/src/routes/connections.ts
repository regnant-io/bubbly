/**
 * Connections: SSH hosts, forge accounts, and opening a repository.
 *
 * ONE RULE GOVERNS EVERY RESPONSE IN THIS FILE: no secret ever leaves it.
 *
 * Not the token, not the passphrase, not the password, not a masked prefix of
 * any of them. A "sk-…4f2a" style preview feels helpful and is a genuine leak —
 * it confirms which credential is stored and hands over entropy for free. What
 * callers actually need is whether a credential EXISTS and where it came from,
 * and that is what they get.
 */

import { Router } from 'express';
import fs from 'fs';
import { logger } from '../utils/logger';
import * as vault from '../secrets/vault';
import {
  describeCredentialSources, discoverSshKeys, findForgeToken, invalidateCredentialProbes
} from '../secrets/credentialSources';
import {
  deleteForgeAccount, deleteSshConnection, listForgeAccounts, listSshConnections,
  registerRemoteWorkspace, saveForgeAccount, saveSshConnection, sshConfigCandidates,
} from '../workspace/registry';
import { testSshConnection } from '../workspace/sshProvider';
import { cloneOrReuse, parseRepoUrl, repoStatus } from '../workspace/gitSource';
import { listRepositories, whoAmI, ForgeError } from '../workspace/forge';

export const connectionsRouter = Router();

/** Turn any thrown value into a 400/500 the UI can render. */
function fail(res: import('express').Response, err: unknown, status = 400): void {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof ForgeError ? err.hint : undefined;
  logger.warn('Connections API error', { message });
  res.status(status).json({ error: message, hint });
}

// --- Overview ---------------------------------------------------------------

/**
 * What Bubbly can already authenticate with, without asking for anything.
 *
 * This is the first thing the connection UI shows, and it is the difference
 * between "set up SSH" (a chore) and "you already have three keys and an agent
 * running" (a choice).
 */
connectionsRouter.get('/overview', (_req, res) => {
  try {
    res.json({
      credentials: describeCredentialSources(),
      vault: { backend: vault.backend(), unlocked: vault.isUnlocked(), storedCount: vault.listSecretNames().length },
      sshConnections: listSshConnections(),
      forgeAccounts: listForgeAccounts(),
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

// --- Vault ------------------------------------------------------------------

connectionsRouter.post('/vault/unlock', (req, res) => {
  const { passphrase } = req.body ?? {};
  if (typeof passphrase !== 'string' || !passphrase) {
    res.status(400).json({ error: 'A passphrase is required.' });
    return;
  }
  const ok = vault.unlock(passphrase);
  res.status(ok ? 200 : 401).json(
    ok ? { ok: true, backend: vault.backend() } : { error: 'That passphrase does not open the vault.' },
  );
});

connectionsRouter.post('/vault/passphrase', (req, res) => {
  const { passphrase } = req.body ?? {};
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    res.status(400).json({ error: 'Choose a passphrase of at least 8 characters.' });
    return;
  }
  try {
    vault.setPassphrase(passphrase);
    res.json({ ok: true, backend: vault.backend() });
  } catch (err) {
    fail(res, err, 500);
  }
});

connectionsRouter.post('/vault/lock', (_req, res) => {
  vault.lock();
  res.json({ ok: true });
});

// --- SSH --------------------------------------------------------------------

connectionsRouter.get('/ssh', (_req, res) => {
  res.json({
    connections: listSshConnections(),
    // Everything needed to fill the "new connection" form without typing:
    // the hosts already in ~/.ssh/config and the keys already on disk.
    candidates: sshConfigCandidates(),
    keys: discoverSshKeys().map((k) => ({ path: k.path, type: k.type, encrypted: k.encrypted })),
  });
});

connectionsRouter.post('/ssh', (req, res) => {
  const body = req.body ?? {};
  if (!body.host || !body.username) {
    res.status(400).json({ error: 'A host and a username are required.' });
    return;
  }
  if (body.auth === 'key' && body.privateKeyPath && !fs.existsSync(String(body.privateKeyPath))) {
    res.status(400).json({ error: `No private key at ${body.privateKeyPath}.` });
    return;
  }
  try {
    const saved = saveSshConnection({
      id: body.id,
      name: String(body.name || body.host),
      host: String(body.host),
      port: Number(body.port) || 22,
      username: String(body.username),
      auth: body.auth === 'key' || body.auth === 'password' ? body.auth : 'agent',
      privateKeyPath: body.privateKeyPath ? String(body.privateKeyPath) : undefined,
      defaultPath: body.defaultPath ? String(body.defaultPath) : undefined,
      fromSshConfig: !!body.fromSshConfig,
      passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
      password: typeof body.password === 'string' ? body.password : undefined,
    });
    res.json({ connection: saved });
  } catch (err) {
    fail(res, err);
  }
});

connectionsRouter.delete('/ssh/:id', (req, res) => {
  try {
    deleteSshConnection(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 500);
  }
});

/**
 * Try a connection and report what is on the other end.
 *
 * Accepts an unsaved connection body as well as a saved id, so the dialog can
 * verify before committing anything — testing only what you have already saved
 * is the wrong way round.
 */
connectionsRouter.post('/ssh/test', async (req, res) => {
  const body = req.body ?? {};
  try {
    const connection = body.id
      ? listSshConnections().find((c) => c.id === body.id)
      : {
          id: body.id ?? 'probe',
          name: String(body.name || body.host || 'probe'),
          host: String(body.host ?? ''),
          port: Number(body.port) || 22,
          username: String(body.username ?? ''),
          auth: body.auth === 'key' || body.auth === 'password' ? body.auth : 'agent',
          privateKeyPath: body.privateKeyPath ? String(body.privateKeyPath) : undefined,
          defaultPath: body.defaultPath ? String(body.defaultPath) : undefined,
          createdAt: new Date().toISOString(),
        };

    if (!connection) { res.status(404).json({ error: 'No such connection.' }); return; }
    if (!connection.host || !connection.username) {
      res.status(400).json({ error: 'A host and a username are required.' });
      return;
    }

    // An unsaved probe with a password/passphrase needs it available to the
    // vault-backed lookup, so stash it under the probe id and remove it after.
    const probeId = connection.id;
    const temporary: string[] = [];
    if (!body.id && typeof body.password === 'string' && body.password) {
      vault.setSecret(`ssh:${probeId}:password`, body.password);
      temporary.push(`ssh:${probeId}:password`);
    }
    if (!body.id && typeof body.passphrase === 'string' && body.passphrase) {
      vault.setSecret(`ssh:${probeId}:passphrase`, body.passphrase);
      temporary.push(`ssh:${probeId}:passphrase`);
    }

    try {
      const result = await testSshConnection(connection);
      res.json(result);
    } finally {
      for (const name of temporary) vault.deleteSecret(name);
    }
  } catch (err) {
    fail(res, err);
  }
});

/** Browse the remote filesystem, so the user can pick a directory. */
connectionsRouter.get('/ssh/:id/list', async (req, res) => {
  const connection = listSshConnections().find((c) => c.id === req.params.id);
  if (!connection) { res.status(404).json({ error: 'No such connection.' }); return; }

  const target = String(req.query.path || connection.defaultPath || '.');
  const { SshProvider } = await import('../workspace/sshProvider');
  // Rooted at '/' for browsing: the path containment rule exists to stop the
  // AGENT wandering out of its workspace, and this is the user choosing where
  // that workspace will be.
  const provider = new SshProvider(connection, '/');
  try {
    await provider.ensureReady();
    const home = (await provider.exec('echo "$HOME"')).stdout.trim();
    const start = target === '.' ? (home || '/') : target;
    const entries = await provider.list(start.replace(/^\//, ''));
    res.json({
      path: start,
      home,
      entries: entries
        .filter((e) => e.isDirectory)
        .map((e) => ({ name: e.name, path: `${start.replace(/\/$/, '')}/${e.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    fail(res, err);
  } finally {
    await provider.dispose();
  }
});

// --- Forge accounts ---------------------------------------------------------

connectionsRouter.get('/forge', (_req, res) => {
  res.json({
    accounts: listForgeAccounts(),
    // What is available WITHOUT saving anything — usually the whole answer.
    detected: {
      github: findForgeToken('github')?.source ?? null,
      gitlab: findForgeToken('gitlab')?.source ?? null,
    },
  });
});

connectionsRouter.post('/forge', async (req, res) => {
  const body = req.body ?? {};
  const forge = body.forge === 'gitlab' ? 'gitlab' : 'github';
  const host = String(body.host || (forge === 'github' ? 'github.com' : 'gitlab.com'));

  try {
    // Save first so the token is findable, then verify. A token that does not
    // work is worse than no token, so a failed check removes what we just saved
    // rather than leaving a broken account behind.
    const saved = saveForgeAccount({
      forge,
      host,
      tokenSource: body.token ? 'vault' : (findForgeToken(forge, host)?.source ?? 'vault'),
      token: typeof body.token === 'string' && body.token ? body.token : undefined,
    });

    try {
      // The token is in the vault now, so every probe answer that said "no
      // credential found" is stale. Clearing before the check also means
      // whoAmI reads the token that was just saved rather than a cached miss.
      invalidateCredentialProbes();
      const me = await whoAmI(forge, host);
      const withUser = saveForgeAccount({ forge, host, username: me.username, tokenSource: saved.tokenSource });
      invalidateCredentialProbes();
      res.json({ account: withUser, username: me.username });
    } catch (verifyErr) {
      if (body.token) deleteForgeAccount(saved.id);
      invalidateCredentialProbes();
      fail(res, verifyErr, 401);
    }
  } catch (err) {
    fail(res, err);
  }
});

connectionsRouter.delete('/forge/:id', (req, res) => {
  try {
    deleteForgeAccount(req.params.id);
    invalidateCredentialProbes();
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 500);
  }
});

connectionsRouter.get('/forge/repos', async (req, res) => {
  const forge = req.query.forge === 'gitlab' ? 'gitlab' : 'github';
  const host = String(req.query.host || (forge === 'github' ? 'github.com' : 'gitlab.com'));
  try {
    const repos = await listRepositories(forge, host, {
      limit: Number(req.query.limit) || 50,
      search: req.query.search ? String(req.query.search) : undefined,
    });
    res.json({ repos });
  } catch (err) {
    fail(res, err, err instanceof ForgeError && err.status === 401 ? 401 : 400);
  }
});

// --- Opening a repository ---------------------------------------------------

connectionsRouter.post('/repo/open', (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) { res.status(400).json({ error: 'A repository URL is required.' }); return; }

  const parsed = parseRepoUrl(url);
  if (!parsed) {
    res.status(400).json({
      error: `"${url}" is not a repository URL.`,
      hint: 'Use https://host/owner/repo, git@host:owner/repo.git, or owner/repo for GitHub.',
    });
    return;
  }

  const outcome = cloneOrReuse(url, {
    branch: req.body?.branch ? String(req.body.branch) : undefined,
    depth: req.body?.depth ? Number(req.body.depth) : undefined,
  });

  if (!outcome.ok || !outcome.source) {
    res.status(400).json({ error: outcome.message });
    return;
  }

  registerRemoteWorkspace(outcome.source);
  res.json({
    source: outcome.source,
    workspacePath: outcome.source.localPath,
    reused: outcome.reused ?? false,
    message: outcome.message,
    status: repoStatus(outcome.source.localPath),
  });
});

/** Open an SSH workspace: verify the directory exists, then register it. */
connectionsRouter.post('/ssh/open', async (req, res) => {
  const connectionId = String(req.body?.connectionId ?? '');
  const remotePath = String(req.body?.path ?? '').trim();
  const connection = listSshConnections().find((c) => c.id === connectionId);

  if (!connection) { res.status(404).json({ error: 'No such connection.' }); return; }
  if (!remotePath) { res.status(400).json({ error: 'A remote directory is required.' }); return; }

  const { SshProvider } = await import('../workspace/sshProvider');
  const provider = new SshProvider(connection, remotePath);
  try {
    await provider.ensureReady();
    const stat = await provider.stat('.');
    if (!stat.exists || !stat.isDirectory) {
      res.status(400).json({
        error: `${remotePath} is not a directory on ${connection.host}.`,
        hint: 'Check the path, or create it on the host first.',
      });
      return;
    }

    const source = { kind: 'ssh' as const, connectionId, remotePath };
    const workspacePath = registerRemoteWorkspace(source);
    res.json({ source, workspacePath, message: `Opened ${remotePath} on ${connection.host}.` });
  } catch (err) {
    fail(res, err);
  } finally {
    await provider.dispose();
  }
});
