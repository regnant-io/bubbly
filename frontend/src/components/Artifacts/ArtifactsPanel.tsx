import React from 'react';
import { useStore } from '../../store';
import type { Artifact } from '../../types';
import { ArtifactView } from './ArtifactView';
import { saveArtifactToWorkspace, deleteArtifactApi, fetchArtifacts, fetchArtifact } from '../../hooks/useApi';
import {
  FileBox, Copy, Save, Trash2, Code2, Eye, ArrowLeft, History, Check,
} from '../Shared/icons';

const KIND_LABEL: Record<Artifact['kind'], string> = {
  markdown: 'Document',
  html: 'Page',
  code: 'Code',
  svg: 'Diagram',
  mermaid: 'Diagram',
  json: 'Data',
};

function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** A short-lived confirmation on a button that did something invisible. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timer.current), []);
  return [on, () => { setOn(true); clearTimeout(timer.current); timer.current = setTimeout(() => setOn(false), 1400); }];
}

function ArtifactList({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen: (id: string) => void }) {
  return (
    <div className="h-full overflow-y-auto p-2 space-y-1">
      {artifacts.map((a) => {
        const latest = a.versions[a.versions.length - 1];
        return (
          <button
            key={a.id}
            onClick={() => onOpen(a.id)}
            className="w-full text-left px-2.5 py-2 rounded-lg border border-border hover:border-accent/50 hover:bg-surface-2 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileBox size={13} className="text-accent-bright shrink-0" />
              <span className="text-xs font-medium text-text truncate flex-1">{a.title}</span>
              {a.versions.length > 1 && (
                <span className="shrink-0 text-[9px] tabular-nums text-text-dim px-1 rounded bg-surface-3">
                  v{latest?.version}
                </span>
              )}
            </div>
            <div className="mt-0.5 pl-[21px] text-[10px] text-text-dim">
              {KIND_LABEL[a.kind]}{a.language ? ` · ${a.language}` : ''} · {relativeTime(a.updatedAt)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ArtifactDetail({ artifact, onBack }: { artifact: Artifact; onBack: () => void }) {
  const workspacePath = useStore((s) => s.workspacePath);
  const removeArtifact = useStore((s) => s.removeArtifact);
  const setOpenFile = useStore((s) => s.setOpenFile);
  const [showSource, setShowSource] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const [version, setVersion] = React.useState<number | undefined>(undefined);
  const [copied, flashCopied] = useFlash();
  const [saved, flashSaved] = useFlash();
  const [error, setError] = React.useState<string | null>(null);

  // A summary loaded from the list has no bodies yet — fetch them on open.
  const setArtifacts = useStore((s) => s.setArtifacts);
  const needsBody = artifact.versions.length === 0;
  React.useEffect(() => {
    if (!needsBody || !workspacePath) return;
    let cancelled = false;
    (async () => {
      try {
        const { artifact: full } = await fetchArtifact(workspacePath, artifact.id);
        if (cancelled || !full) return;
        const all = useStore.getState().artifacts;
        setArtifacts(all.map((a) => (a.id === full.id ? full : a)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [needsBody, workspacePath, artifact.id, setArtifacts]);

  const latest = artifact.versions[artifact.versions.length - 1];
  const shown = version != null ? artifact.versions.find((v) => v.version === version) : latest;
  const isOldVersion = version != null && version !== latest?.version;
  // Only a rendered kind has a source view worth toggling to.
  const hasSourceToggle = artifact.kind !== 'json' && artifact.kind !== 'mermaid';

  const copy = () => { navigator.clipboard?.writeText(shown?.content ?? ''); flashCopied(); };

  const saveToWorkspace = async () => {
    if (!workspacePath) { setError('Set a workspace first.'); return; }
    setError(null);
    try {
      const r = await saveArtifactToWorkspace(workspacePath, artifact.id, version);
      flashSaved();
      // Opening it closes the loop: the document is now a real file, and the
      // user is looking at that file rather than at a copy of it.
      if (r.path) setOpenFile(r.path, shown?.content ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (!workspacePath) return;
    if (!window.confirm(`Delete the artifact "${artifact.title}"? Its version history goes with it.`)) return;
    try { await deleteArtifactApi(workspacePath, artifact.id); } catch { /* removed locally regardless */ }
    removeArtifact(artifact.id);
    onBack();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
        <button onClick={onBack} title="Back to all artifacts" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          <ArrowLeft size={13} />
        </button>
        <span className="text-xs font-medium text-text truncate flex-1" title={artifact.title}>{artifact.title}</span>

        {artifact.versions.length > 1 && (
          <button
            onClick={() => setShowHistory((h) => !h)}
            title="Version history"
            className={`p-1 rounded transition-colors ${showHistory ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            <History size={13} />
          </button>
        )}
        {hasSourceToggle && (
          <button
            onClick={() => setShowSource((s) => !s)}
            title={showSource ? 'Show rendered' : 'Show source'}
            className={`p-1 rounded transition-colors ${showSource ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            {showSource ? <Eye size={13} /> : <Code2 size={13} />}
          </button>
        )}
        <button onClick={copy} title="Copy content" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          {copied ? <Check size={13} className="text-green-agent" /> : <Copy size={13} />}
        </button>
        <button onClick={saveToWorkspace} title="Save into the workspace as a file" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          {saved ? <Check size={13} className="text-green-agent" /> : <Save size={13} />}
        </button>
        <button onClick={remove} title="Delete artifact" className="p-1 rounded text-text-dim hover:text-red-agent hover:bg-surface-3 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>

      {showHistory && (
        <div className="shrink-0 border-b border-border bg-surface-2/50 max-h-32 overflow-y-auto">
          {[...artifact.versions].reverse().map((v) => (
            <button
              key={v.version}
              onClick={() => { setVersion(v.version === latest?.version ? undefined : v.version); }}
              className={`flex items-baseline gap-2 w-full text-left px-3 py-1.5 text-[11px] hover:bg-surface-3 transition-colors ${
                (version ?? latest?.version) === v.version ? 'text-text bg-surface-3' : 'text-text-dim'
              }`}
            >
              <span className="tabular-nums font-medium shrink-0">v{v.version}</span>
              <span className="truncate flex-1">{v.note ?? (v.version === 1 ? 'first version' : 'revised')}</span>
              <span className="shrink-0 text-text-dim/70">{relativeTime(v.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {isOldVersion && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1 bg-warning-bg text-[11px] text-amber-agent border-b border-amber-agent/30">
          Viewing v{version} — not the latest.
          <button onClick={() => setVersion(undefined)} className="underline">Show v{latest?.version}</button>
        </div>
      )}

      {error && (
        <div className="shrink-0 px-3 py-1.5 bg-error-bg text-[11px] text-red-agent border-b border-red-agent/30">{error}</div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {needsBody
          ? <div className="p-4 text-xs text-text-dim">Loading…</div>
          : <ArtifactView artifact={artifact} version={version} source={showSource} />}
      </div>
    </div>
  );
}

/**
 * The Artifacts panel: everything the agent has authored for this project.
 *
 * Two states, deliberately — a list of documents, and one document open. The
 * open document is the default when the agent has just written something,
 * because at that moment the user wants to read it, not choose it.
 */
export function ArtifactsPanel() {
  const artifacts = useStore((s) => s.artifacts);
  const activeArtifactId = useStore((s) => s.activeArtifactId);
  const setActiveArtifact = useStore((s) => s.setActiveArtifact);
  const setArtifacts = useStore((s) => s.setArtifacts);
  const workspacePath = useStore((s) => s.workspacePath);
  const active = artifacts.find((a) => a.id === activeArtifactId) ?? null;

  /**
   * Load what the project already has.
   *
   * The WebSocket only carries artifacts written during THIS session, but they
   * are stored per-project and outlive it — reopening a workspace tomorrow
   * should show yesterday's documents. The list endpoint returns summaries;
   * bodies are fetched when a document is actually opened, so a project with
   * thirty artifacts doesn't pull thirty documents to draw a list.
   */
  React.useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    (async () => {
      try {
        const { artifacts: summaries } = await fetchArtifacts(workspacePath);
        if (cancelled || !Array.isArray(summaries)) return;
        const live = useStore.getState().artifacts;
        const merged: Artifact[] = summaries.map((s: any) => {
          // Anything already in memory (written this session) is complete —
          // don't replace it with a body-less summary.
          const known = live.find((a) => a.id === s.id);
          if (known && known.versions.length > 0) return known;
          return {
            id: s.id, title: s.title, kind: s.kind, language: s.language,
            createdAt: s.createdAt, updatedAt: s.updatedAt, versions: [],
          };
        });
        setArtifacts(merged);
      } catch { /* an unreachable API just means an empty panel */ }
    })();
    return () => { cancelled = true; };
  }, [workspacePath, setArtifacts]);

  if (artifacts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-text-dim">
        <FileBox size={22} className="text-text-dim/60" />
        <p className="text-xs">No artifacts yet.</p>
        <p className="text-[11px] leading-relaxed max-w-[230px]">
          When the agent writes a document for you — a plan, a report, a page, a
          diagram — it appears here with its full version history instead of
          filling up the chat.
        </p>
      </div>
    );
  }

  return active
    ? <ArtifactDetail artifact={active} onBack={() => setActiveArtifact(null)} />
    : <ArtifactList artifacts={artifacts} onOpen={setActiveArtifact} />;
}
