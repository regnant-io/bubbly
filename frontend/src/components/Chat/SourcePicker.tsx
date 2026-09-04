import React from 'react';
import { useStore } from '../../store';
import {
  Folder, ChevronDown, Check, Server, GitBranch, Loader2, Plus, X, AlertCircle,
} from '../Shared/icons';
import { isDesktop } from '../../hooks/useDesktop';
import type { WorkspaceSource, SshConnectionSummary } from '../../types';

/**
 * Where the next thread will do its work.
 *
 * A thread now has three possible homes — a local folder, a directory on
 * another machine, or a repository — and the choice has to be made BEFORE the
 * first message, because it determines which machine every subsequent tool call
 * touches. Changing it afterwards is not "switching folder", it is a different
 * thread.
 *
 * So the picker sits on the composer, states the current source in one line, and
 * is locked once the thread has messages. Locking is not a limitation to
 * apologise for: a thread that read twelve files on a server and then silently
 * switched to a local folder would produce edits that look fine and land
 * nowhere near the code they were reasoning about.
 */

function shortName(p: string): string {
  if (!p) return 'No workspace';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

type Tab = 'local' | 'ssh' | 'git';

export function SourcePicker({ variant = 'inline' }: { variant?: 'pill' | 'inline' }) {
  const workspacePath = useStore((s) => s.workspacePath);
  const workspaceSource = useStore((s) => s.workspaceSource);
  const recentWorkspaces = useStore((s) => s.recentWorkspaces);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const setWorkspaceSource = useStore((s) => s.setWorkspaceSource);
  const messages = useStore((s) => s.messages);

  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>('local');
  const ref = React.useRef<HTMLDivElement>(null);

  const locked = messages.length > 0;

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const kind = workspaceSource?.kind ?? 'local';
  const Icon = kind === 'ssh' ? Server : kind === 'git' ? GitBranch : Folder;

  const label =
    kind === 'ssh' && workspaceSource?.kind === 'ssh'
      ? `${workspaceSource.hostLabel ?? 'remote'}:${shortName(workspaceSource.remotePath)}`
      : kind === 'git' && workspaceSource?.kind === 'git'
      ? `${workspaceSource.owner}/${workspaceSource.repo}`
      : shortName(workspacePath);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !locked && setOpen((v) => !v)}
        disabled={locked}
        title={
          locked
            ? 'The source is fixed once a thread has started. Start a new chat to work somewhere else.'
            : workspacePath || 'Choose where to work'
        }
        className={
          variant === 'pill'
            ? `flex items-center gap-1.5 rounded-full border bg-surface-2 px-2.5 py-1 text-[11px] shadow-sm
               transition-colors max-w-[220px] ${open ? 'border-accent/50 text-text' : 'border-border text-text-dim hover:text-text hover:border-border-bright'}
               ${locked ? 'opacity-70 cursor-default' : ''}`
            : `flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors max-w-[200px]
               ${locked ? 'text-text-dim cursor-default' : 'text-text-dim hover:text-text hover:bg-surface-3'}`
        }
      >
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
        {!locked && <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>

      {open && !locked && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-[360px] card bg-surface-1 shadow-xl overflow-hidden">
          <div className="flex items-center border-b border-border">
            {(['local', 'ssh', 'git'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors ${
                  tab === t ? 'text-accent-bright border-b-2 border-accent -mb-px' : 'text-text-dim hover:text-text'
                }`}
              >
                {t === 'local' && <Folder size={12} />}
                {t === 'ssh' && <Server size={12} />}
                {t === 'git' && <GitBranch size={12} />}
                {t === 'local' ? 'This machine' : t === 'ssh' ? 'SSH' : 'Repository'}
              </button>
            ))}
          </div>

          <div className="max-h-[340px] overflow-y-auto">
            {tab === 'local' && (
              <LocalTab
                current={workspacePath}
                recents={recentWorkspaces}
                onPick={(p) => {
                  switchWorkspace(p);
                  setWorkspaceSource({ kind: 'local', path: p });
                  setOpen(false);
                }}
              />
            )}
            {tab === 'ssh' && <SshTab onOpened={() => setOpen(false)} />}
            {tab === 'git' && <GitTab onOpened={() => setOpen(false)} />}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Local ------------------------------------------------------------------

function LocalTab({
  current, recents, onPick,
}: { current: string; recents: string[]; onPick: (p: string) => void }) {
  const pickFolder = async () => {
    if (isDesktop() && window.bubblyDesktop) {
      const folder = await window.bubblyDesktop.pickFolder();
      if (folder) onPick(folder);
    } else {
      const entered = window.prompt('Enter an absolute workspace path:');
      if (entered?.trim()) onPick(entered.trim());
    }
  };

  const others = recents.filter((p) => p && p !== current);

  return (
    <div className="p-1.5">
      <button
        onClick={pickFolder}
        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-text hover:bg-surface-3 transition-colors"
      >
        <Plus size={13} className="text-accent-bright" />
        Open a folder…
      </button>

      {current && (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-accent-bright">
          <Check size={13} />
          <span className="font-mono truncate" title={current}>{current}</span>
        </div>
      )}

      {others.length > 0 && (
        <>
          <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-dim">Recent</div>
          {others.slice(0, 8).map((p) => (
            <button
              key={p}
              onClick={() => onPick(p)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:bg-surface-3 hover:text-text transition-colors"
              title={p}
            >
              <Folder size={12} className="shrink-0 text-text-dim" />
              <span className="font-mono truncate">{p}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// --- SSH --------------------------------------------------------------------

function SshTab({ onOpened }: { onOpened: () => void }) {
  const setWorkspaceSource = useStore((s) => s.setWorkspaceSource);
  const setWorkspacePath = useStore((s) => s.setWorkspacePath);
  const [connections, setConnections] = React.useState<SshConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [remotePath, setRemotePath] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/connections/ssh')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setConnections(d.connections ?? []);
        if (d.connections?.[0]) {
          setSelected(d.connections[0].id);
          setRemotePath(d.connections[0].defaultPath ?? '');
        }
      })
      .catch(() => { if (!cancelled) setConnections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const openIt = async () => {
    if (!selected || !remotePath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/connections/ssh/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: selected, path: remotePath.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.hint ? `${data.error}\n${data.hint}` : data.error); return; }

      const conn = connections.find((c) => c.id === selected);
      setWorkspacePath(data.workspacePath);
      setWorkspaceSource({
        kind: 'ssh',
        connectionId: selected,
        remotePath: remotePath.trim(),
        hostLabel: conn ? `${conn.username}@${conn.host}` : undefined,
      });
      onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 flex justify-center"><Loader2 size={16} className="animate-spin text-text-dim" /></div>;
  }

  if (connections.length === 0) {
    return (
      <div className="p-4 text-center space-y-2">
        <Server size={18} className="mx-auto text-text-dim/50" />
        <p className="text-xs text-text-muted">No SSH connections yet.</p>
        <p className="text-[11px] text-text-dim leading-relaxed">
          Add one in Settings → Connections. Hosts already in your <code className="font-mono">~/.ssh/config</code> can
          be imported in one click, and an ssh-agent key needs no password from you at all.
        </p>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
      <div className="space-y-1">
        {connections.map((c) => (
          <button
            key={c.id}
            onClick={() => { setSelected(c.id); setRemotePath(c.defaultPath ?? remotePath); }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              selected === c.id ? 'bg-accent/10 text-accent-bright' : 'text-text-muted hover:bg-surface-3 hover:text-text'
            }`}
          >
            <Server size={12} className="shrink-0" />
            <span className="truncate">{c.name}</span>
            <span className="ml-auto text-[10px] text-text-dim font-mono truncate">
              {c.username}@{c.host}
            </span>
          </button>
        ))}
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-wide text-text-dim px-0.5 pb-1">
          Directory on the host
        </label>
        <input
          value={remotePath}
          onChange={(e) => setRemotePath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void openIt(); }}
          placeholder="/home/deploy/app"
          className="input w-full font-mono text-xs"
        />
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-agent bg-error-bg rounded-lg px-2 py-1.5">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      <button
        onClick={openIt}
        disabled={busy || !selected || !remotePath.trim()}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-accent/15 text-accent-bright
                   px-3 py-2 text-xs font-medium hover:bg-accent/25 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Server size={12} />}
        {busy ? 'Connecting…' : 'Work here'}
      </button>
    </div>
  );
}

// --- Git --------------------------------------------------------------------

function GitTab({ onOpened }: { onOpened: () => void }) {
  const setWorkspaceSource = useStore((s) => s.setWorkspaceSource);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const [url, setUrl] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const openIt = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/connections/repo/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), branch: branch.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.hint ? `${data.error}\n\n${data.hint}` : data.error); return; }

      switchWorkspace(data.workspacePath);
      setWorkspaceSource(data.source as WorkspaceSource);
      setNote(data.message);
      onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-2 space-y-2">
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-text-dim px-0.5 pb-1">Repository</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void openIt(); }}
          placeholder="owner/repo, or a full https:// or git@ URL"
          className="input w-full font-mono text-xs"
          autoFocus
        />
        <p className="mt-1 text-[10px] text-text-dim leading-relaxed">
          Cloned to <code className="font-mono">~/.bubbly/repos</code> and worked on locally. Bubbly authenticates
          with your existing git credentials — nothing to paste if <code className="font-mono">gh</code> or an
          ssh key already works.
        </p>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-wide text-text-dim px-0.5 pb-1">
          Branch <span className="normal-case text-text-dim/70">(optional)</span>
        </label>
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="default branch"
          className="input w-full font-mono text-xs"
        />
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-agent bg-error-bg rounded-lg px-2 py-1.5">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}
      {note && <p className="text-[11px] text-green-agent px-0.5">{note}</p>}

      <button
        onClick={openIt}
        disabled={busy || !url.trim()}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-accent/15 text-accent-bright
                   px-3 py-2 text-xs font-medium hover:bg-accent/25 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
        {busy ? 'Cloning…' : 'Clone and work here'}
      </button>
    </div>
  );
}
