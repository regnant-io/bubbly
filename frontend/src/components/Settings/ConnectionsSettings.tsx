import React from 'react';
import {
  Server, GitBranch, KeyRound, Check, X, Plus, Loader2, AlertCircle, Trash2, ShieldCheck, Download,
} from '../Shared/icons';
import type { SshConnectionSummary, ForgeAccountSummary } from '../../types';

/**
 * Connections: SSH hosts and forge accounts.
 *
 * THE DESIGN PRINCIPLE HERE IS "TELL THEM WHAT THEY ALREADY HAVE".
 *
 * The reflex when building this screen is to open with an empty form and a
 * "paste your token" field. That is wrong twice over: most users already have a
 * working ssh-agent and a logged-in `gh`, so the form asks for a credential
 * Bubbly does not need; and a pasted token is a long-lived secret we then have
 * to protect for no gain.
 *
 * So the page opens with what was DETECTED — "3 keys in ~/.ssh, agent running
 * with 2 identities, GitHub via your gh CLI" — and the manual paths are there
 * for the cases detection cannot cover. A user whose setup is already good
 * should be able to close this page without typing anything.
 */

interface Overview {
  credentials: {
    ssh: { agent: boolean; agentKeys: number; keyFiles: number; configuredHosts: number };
    github: string | null;
    gitlab: string | null;
  };
  vault: { backend: string; unlocked: boolean; storedCount: number };
  sshConnections: SshConnectionSummary[];
  forgeAccounts: ForgeAccountSummary[];
}

interface SshCandidate {
  name: string; host: string; port: number; username: string;
  auth: 'agent' | 'key' | 'password'; privateKeyPath?: string; alreadySaved: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  'gh-cli': 'your gh CLI login',
  'glab-cli': 'your glab CLI login',
  environment: 'an environment variable',
  'git-credential': 'your git credential helper',
  vault: 'a token saved in Bubbly',
};

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 py-1.5 text-xs">{children}</div>;
}

/**
 * Survives unmounting, deliberately.
 *
 * Module scope rather than a store slice because it is a CACHE, not state: it
 * has no meaning outside this page, nothing else reads it, and it should be
 * thrown away when the app is reloaded. Putting it in the store would make it
 * look like something the rest of the app depends on.
 */
let cache: { overview: Overview; candidates: SshCandidate[]; keys: Array<{ path: string; type: string; encrypted: boolean }> } | null = null;

export function ConnectionsSettings() {
  const [overview, setOverview] = React.useState<Overview | null>(cache?.overview ?? null);
  const [candidates, setCandidates] = React.useState<SshCandidate[]>(cache?.candidates ?? []);
  const [keys, setKeys] = React.useState<Array<{ path: string; type: string; encrypted: boolean }>>(cache?.keys ?? []);
  const [loading, setLoading] = React.useState(!cache);
  const [showSshForm, setShowSshForm] = React.useState(false);
  const [showTokenForm, setShowTokenForm] = React.useState<'github' | 'gitlab' | null>(null);

  /**
   * The last answer, kept ACROSS MOUNTS.
   *
   * Discovering what this machine can already authenticate with means spawning
   * `gh`, `glab`, `ssh-add` and the git credential helper. The backend now
   * caches that, but this component was throwing its own state away every time
   * the tab was switched — so leaving Connections and coming back showed a full
   * loading spinner and then, a beat later, the same answer as before. A module
   * -level cache makes the second visit instant and the data is refreshed
   * behind it, which is the behaviour people read as "it just works".
   */
  const reload = React.useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
    try {
      const [ov, ssh] = await Promise.all([
        fetch('/api/connections/overview').then((r) => r.json()),
        fetch('/api/connections/ssh').then((r) => r.json()),
      ]);
      cache = { overview: ov, candidates: ssh.candidates ?? [], keys: ssh.keys ?? [] };
      setOverview(ov);
      setCandidates(cache.candidates);
      setKeys(cache.keys);
    } catch {
      // Keep whatever was on screen. Blanking a working page because one
      // refresh failed is strictly worse than showing slightly older truth.
      if (!cache) setOverview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // A cached answer paints immediately and is refreshed in the background;
    // a cold start shows the spinner exactly once per app launch.
    void reload({ quiet: !!cache });
  }, [reload]);

  if (loading && !overview) {
    return <div className="p-6 flex justify-center"><Loader2 size={18} className="animate-spin text-text-dim" /></div>;
  }
  if (!overview) {
    return <p className="text-xs text-text-dim">Could not load connections.</p>;
  }

  const { credentials, vault } = overview;

  return (
    <div className="space-y-6">
      {/* --- What we found ---------------------------------------------- */}
      <section>
        <h3 className="text-sm font-semibold text-text mb-1">Already available</h3>
        <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
          Bubbly uses the credentials you already have before asking for anything. Everything listed here works
          right now with no setup.
        </p>
        <div className="card bg-surface-2 px-3 py-2 divide-y divide-border">
          <Row>
            {credentials.ssh.agent
              ? <Check size={13} className="text-green-agent shrink-0" />
              : <X size={13} className="text-text-dim shrink-0" />}
            <span className="text-text-muted">ssh-agent</span>
            <span className="ml-auto text-text-dim">
              {credentials.ssh.agent
                ? `${credentials.ssh.agentKeys} identit${credentials.ssh.agentKeys === 1 ? 'y' : 'ies'} loaded`
                : 'not running'}
            </span>
          </Row>
          <Row>
            {credentials.ssh.keyFiles > 0
              ? <Check size={13} className="text-green-agent shrink-0" />
              : <X size={13} className="text-text-dim shrink-0" />}
            <span className="text-text-muted">Keys in ~/.ssh</span>
            <span className="ml-auto text-text-dim">{credentials.ssh.keyFiles} found</span>
          </Row>
          <Row>
            {credentials.ssh.configuredHosts > 0
              ? <Check size={13} className="text-green-agent shrink-0" />
              : <X size={13} className="text-text-dim shrink-0" />}
            <span className="text-text-muted">Hosts in ~/.ssh/config</span>
            <span className="ml-auto text-text-dim">{credentials.ssh.configuredHosts} defined</span>
          </Row>
          <Row>
            {credentials.github
              ? <Check size={13} className="text-green-agent shrink-0" />
              : <X size={13} className="text-text-dim shrink-0" />}
            <span className="text-text-muted">GitHub</span>
            <span className="ml-auto text-text-dim">
              {credentials.github ? `via ${SOURCE_LABEL[credentials.github] ?? credentials.github}` : 'no credential found'}
            </span>
          </Row>
          <Row>
            {credentials.gitlab
              ? <Check size={13} className="text-green-agent shrink-0" />
              : <X size={13} className="text-text-dim shrink-0" />}
            <span className="text-text-muted">GitLab</span>
            <span className="ml-auto text-text-dim">
              {credentials.gitlab ? `via ${SOURCE_LABEL[credentials.gitlab] ?? credentials.gitlab}` : 'no credential found'}
            </span>
          </Row>
        </div>
      </section>

      {/* --- SSH connections --------------------------------------------- */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-text">SSH hosts</h3>
          <button
            onClick={() => setShowSshForm((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-accent-bright hover:underline"
          >
            <Plus size={12} /> Add a host
          </button>
        </div>
        <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
          A thread opened against a host runs everything there — reads, writes, searches, commands, terminals.
          Nothing is copied to this machine.
        </p>

        {overview.sshConnections.length === 0 && !showSshForm && (
          <p className="text-xs text-text-dim py-2">No hosts saved yet.</p>
        )}

        <div className="space-y-1">
          {overview.sshConnections.map((c) => (
            <SshConnectionRow key={c.id} connection={c} onChanged={reload} />
          ))}
        </div>

        {candidates.filter((c) => !c.alreadySaved).length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-wide text-text-dim mb-1">
              From your ~/.ssh/config
            </p>
            <div className="space-y-1">
              {candidates.filter((c) => !c.alreadySaved).map((c) => (
                <div key={`${c.host}:${c.username}`} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-2 text-xs">
                  <Server size={12} className="text-text-dim shrink-0" />
                  <span className="text-text truncate">{c.name}</span>
                  <span className="text-[10px] text-text-dim font-mono truncate">{c.username}@{c.host}</span>
                  <button
                    onClick={async () => {
                      await fetch('/api/connections/ssh', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(c),
                      });
                      void reload({ quiet: true });
                    }}
                    className="ml-auto flex items-center gap-1 text-[11px] text-accent-bright hover:underline shrink-0"
                  >
                    <Download size={11} /> Import
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {showSshForm && (
          <SshForm keys={keys} onDone={() => { setShowSshForm(false); void reload({ quiet: true }); }} onCancel={() => setShowSshForm(false)} />
        )}
      </section>

      {/* --- Forge accounts ---------------------------------------------- */}
      <section>
        <h3 className="text-sm font-semibold text-text mb-1">GitHub &amp; GitLab</h3>
        <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
          Only needed if nothing was detected above, or for a self-hosted instance. A token needs
          <code className="font-mono"> repo</code> scope on GitHub, or <code className="font-mono">api</code> on GitLab.
        </p>

        <div className="space-y-1">
          {overview.forgeAccounts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-2 text-xs">
              <GitBranch size={12} className="text-text-dim shrink-0" />
              <span className="text-text">{a.host}</span>
              {a.username && <span className="text-text-dim">as {a.username}</span>}
              <span className="ml-auto text-[10px] text-text-dim">
                {SOURCE_LABEL[a.tokenSource] ?? a.tokenSource}
              </span>
              <button
                onClick={async () => {
                  await fetch(`/api/connections/forge/${a.id}`, { method: 'DELETE' });
                  void reload({ quiet: true });
                }}
                className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-red-agent transition-colors"
                title="Remove"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-2">
          {(['github', 'gitlab'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setShowTokenForm(showTokenForm === f ? null : f)}
              className="flex items-center gap-1 text-[11px] text-accent-bright hover:underline"
            >
              <Plus size={12} /> {f === 'github' ? 'GitHub' : 'GitLab'} account
            </button>
          ))}
        </div>

        {showTokenForm && (
          <ForgeForm forge={showTokenForm} onDone={() => { setShowTokenForm(null); void reload({ quiet: true }); }} onCancel={() => setShowTokenForm(null)} />
        )}
      </section>

      {/* --- Vault -------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-semibold text-text mb-1">Credential storage</h3>
        <div className="card bg-surface-2 px-3 py-2 text-xs space-y-1.5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={13} className={vault.backend === 'locked' ? 'text-amber-agent' : 'text-green-agent'} />
            <span className="text-text-muted">
              {vault.backend === 'os-keychain' && 'Protected by your operating system’s keychain.'}
              {vault.backend === 'passphrase' && 'Protected by your passphrase.'}
              {vault.backend === 'key-file' && 'Protected by a key file in ~/.bubbly, readable only by your user.'}
              {vault.backend === 'locked' && 'Locked — enter your passphrase to use saved credentials.'}
            </span>
            <span className="ml-auto text-text-dim">{vault.storedCount} stored</span>
          </div>
          {vault.backend === 'key-file' && (
            <p className="text-[11px] text-text-dim leading-relaxed">
              A key file protects your credentials from other accounts on this machine and from a stray backup.
              It does not protect them from someone who already has your own read access — set a passphrase if
              you need that.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

// --- SSH connection row -----------------------------------------------------

function SshConnectionRow({ connection, onChanged }: { connection: SshConnectionSummary; onChanged: () => void }) {
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch('/api/connections/ssh/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: connection.id }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <Server size={12} className="text-text-dim shrink-0" />
        <span className="text-text truncate">{connection.name}</span>
        <span className="text-[10px] text-text-dim font-mono truncate">
          {connection.username}@{connection.host}:{connection.port}
        </span>
        <span className="text-[10px] text-text-dim">
          {connection.auth === 'agent' ? 'ssh-agent' : connection.auth === 'key' ? 'key file' : 'password'}
        </span>
        <button
          onClick={test}
          disabled={testing}
          className="ml-auto text-[11px] text-accent-bright hover:underline disabled:opacity-50 shrink-0"
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          onClick={async () => {
            await fetch(`/api/connections/ssh/${connection.id}`, { method: 'DELETE' });
            onChanged();
          }}
          className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-red-agent transition-colors shrink-0"
          title="Remove"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {result && (
        <p className={`mt-1 text-[11px] leading-snug ${result.ok ? 'text-green-agent' : 'text-red-agent'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}

// --- Forms ------------------------------------------------------------------

function SshForm({
  keys, onDone, onCancel,
}: {
  keys: Array<{ path: string; type: string; encrypted: boolean }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = React.useState({
    name: '', host: '', port: 22, username: '', auth: 'agent' as 'agent' | 'key' | 'password',
    privateKeyPath: keys[0]?.path ?? '', defaultPath: '', passphrase: '', password: '',
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tested, setTested] = React.useState<{ ok: boolean; message: string } | null>(null);

  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const call = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, name: form.name || form.host }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return null; }
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const selectedKey = keys.find((k) => k.path === form.privateKeyPath);

  return (
    <div className="mt-2 card bg-surface-2 p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">Host</span>
          <input className="input w-full text-xs mt-0.5" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="10.0.0.5 or server.acme.com" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">User</span>
          <input className="input w-full text-xs mt-0.5" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="deploy" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">Port</span>
          <input type="number" className="input w-full text-xs mt-0.5" value={form.port} onChange={(e) => set('port', Number(e.target.value) || 22)} />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">Name</span>
          <input className="input w-full text-xs mt-0.5" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="same as host" />
        </label>
      </div>

      <div>
        <span className="text-[10px] uppercase tracking-wide text-text-dim">Authentication</span>
        <div className="flex gap-1.5 mt-1">
          {(['agent', 'key', 'password'] as const).map((a) => (
            <button
              key={a}
              onClick={() => set('auth', a)}
              className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] border transition-colors ${
                form.auth === a ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
              }`}
            >
              {a === 'agent' ? 'ssh-agent' : a === 'key' ? 'Key file' : 'Password'}
            </button>
          ))}
        </div>
        {form.auth === 'agent' && (
          <p className="mt-1 text-[10px] text-text-dim leading-relaxed">
            The best option: your agent signs the login and Bubbly never sees a secret at all.
          </p>
        )}
      </div>

      {form.auth === 'key' && (
        <div className="space-y-1.5">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-text-dim">Private key</span>
            <select className="input w-full text-xs mt-0.5 font-mono" value={form.privateKeyPath} onChange={(e) => set('privateKeyPath', e.target.value)}>
              {keys.length === 0 && <option value="">No keys found in ~/.ssh</option>}
              {keys.map((k) => <option key={k.path} value={k.path}>{k.path}{k.encrypted ? ' (passphrase)' : ''}</option>)}
            </select>
          </label>
          {selectedKey?.encrypted && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-text-dim">Key passphrase</span>
              <input type="password" className="input w-full text-xs mt-0.5" value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)} autoComplete="off" />
            </label>
          )}
        </div>
      )}

      {form.auth === 'password' && (
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">Password</span>
          <input type="password" className="input w-full text-xs mt-0.5" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="off" />
        </label>
      )}

      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-text-dim">Default directory (optional)</span>
        <input className="input w-full text-xs mt-0.5 font-mono" value={form.defaultPath} onChange={(e) => set('defaultPath', e.target.value)} placeholder="/home/deploy/app" />
      </label>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-agent">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {tested && (
        <p className={`text-[11px] ${tested.ok ? 'text-green-agent' : 'text-red-agent'}`}>{tested.message}</p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={async () => { const r = await call('/api/connections/ssh/test'); if (r) setTested(r); }}
          disabled={busy || !form.host || !form.username}
          className="flex-1 rounded-lg border border-border px-3 py-1.5 text-[11px] text-text-muted hover:border-border-bright disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin mx-auto" /> : 'Test'}
        </button>
        <button
          onClick={async () => { if (await call('/api/connections/ssh')) onDone(); }}
          disabled={busy || !form.host || !form.username}
          className="flex-1 rounded-lg bg-accent/15 text-accent-bright px-3 py-1.5 text-[11px] font-medium hover:bg-accent/25 disabled:opacity-40"
        >
          Save
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[11px] text-text-dim hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}

function ForgeForm({
  forge, onDone, onCancel,
}: { forge: 'github' | 'gitlab'; onDone: () => void; onCancel: () => void }) {
  const [host, setHost] = React.useState(forge === 'github' ? 'github.com' : 'gitlab.com');
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/connections/forge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forge, host, token: token || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.hint ? `${data.error}\n${data.hint}` : data.error); return; }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 card bg-surface-2 p-3 space-y-2">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-text-dim">Host</span>
        <input className="input w-full text-xs mt-0.5 font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-text-dim">
          Token <span className="normal-case">(leave empty to use what is already on this machine)</span>
        </span>
        <input
          type="password"
          className="input w-full text-xs mt-0.5 font-mono"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={forge === 'github' ? 'ghp_… — optional' : 'glpat-… — optional'}
          autoComplete="off"
        />
      </label>
      <p className="text-[10px] text-text-dim leading-relaxed flex items-start gap-1">
        <KeyRound size={11} className="shrink-0 mt-0.5" />
        Saved to the encrypted vault, never to the database and never shown again.
      </p>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-agent">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 rounded-lg bg-accent/15 text-accent-bright px-3 py-1.5 text-[11px] font-medium hover:bg-accent/25 disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin mx-auto" /> : 'Connect'}
        </button>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[11px] text-text-dim hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}
