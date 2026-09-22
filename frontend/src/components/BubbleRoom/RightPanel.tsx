import React from 'react';
import { useStore, type RightContextId } from '../../store';
import { AuditPanel } from '../Chat/AuditPanel';
import { SpecPanel } from '../SpecPanel/SpecPanel';
import { TaskQueue } from '../TaskQueue/TaskQueue';
import { DiffViewer } from '../Shared/DiffViewer';
import { FilePreviewContent } from '../Shared/FilePreviewContent';
import { BubblyPreview } from './BubblyPreview';
import { BackgroundProcessesPanel } from './BackgroundProcessesPanel';
import { WatchersPanel } from './WatchersPanel';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { PlansPanel } from '../Chat/PlansPanel';
import { ArtifactsPanel } from '../Artifacts/ArtifactsPanel';
import {
  Monitor, Server, GitBranch, Terminal, ClipboardList, CheckCircle, Clock,
  X, ChevronDown, ListTree, FileBox, File, Eye, Maximize2, Minimize2,
} from '../Shared/icons';

function DiffView() {
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  return (
    <div className="h-full overflow-y-auto p-3">
      <DiffViewer diffs={pendingDiffs} />
    </div>
  );
}

function FilePreviewView() {
  const filePreview = useStore((s) => s.filePreview);
  if (!filePreview) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <p className="text-sm text-text-dim text-center">
          No file open. Click a file name in the conversation to see it here.
        </p>
      </div>
    );
  }
  return <FilePreviewContent {...filePreview} />;
}

export const RIGHT_PANEL_META: Record<RightContextId, { label: string; icon: typeof Monitor; render: () => React.ReactNode }> = {
  preview: { label: 'Preview', icon: Monitor, render: () => <BubblyPreview /> },
  background: { label: 'Background', icon: Server, render: () => <BackgroundProcessesPanel /> },
  watchers: { label: 'Watchers', icon: Eye, render: () => <WatchersPanel /> },
  diff: { label: 'Changes', icon: GitBranch, render: () => <DiffView /> },
  terminal: { label: 'Terminal', icon: Terminal, render: () => <TerminalPanel /> },
  spec: { label: 'Specs', icon: ClipboardList, render: () => <SpecPanel /> },
  tasks: { label: 'Tasks', icon: CheckCircle, render: () => <TaskQueue /> },
  audit: { label: 'Audit', icon: Clock, render: () => <AuditPanel /> },
  plans: { label: 'Plans', icon: ListTree, render: () => <PlansPanel /> },
  artifacts: { label: 'Artifacts', icon: FileBox, render: () => <ArtifactsPanel /> },
  'file-preview': { label: 'File', icon: File, render: () => <FilePreviewView /> },
};

/** Content-aware bento grid. Collapsing and focusing preserve mounted tool state. */
const WIDE_PANELS = new Set<RightContextId>(['preview', 'terminal', 'diff', 'file-preview']);

export function RightPanel() {
  const rightStack = useStore(s => s.rightStack);
  const closeRightContext = useStore(s => s.closeRightContext);
  const pendingDiffs = useStore(s => s.pendingDiffs);
  const watchers = useStore(s => s.watchers);
  const [collapsed, setCollapsed] = React.useState<Set<RightContextId>>(new Set());
  const [focused, setFocused] = React.useState<RightContextId | null>(null);
  const regionRef = React.useRef<HTMLElement>(null);
  const [twoColumns, setTwoColumns] = React.useState(false);
  React.useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const observer = new ResizeObserver(([entry]) => setTwoColumns(entry.contentRect.width >= 510));
    observer.observe(region);
    return () => observer.disconnect();
  }, [rightStack.length > 0]);
  const focusId = focused && rightStack.includes(focused) ? focused : null;
  const toggleCollapse = (id: RightContextId) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const visible = focusId ? [focusId] : rightStack;
  const rows: RightContextId[][] = [];
  for (const id of visible) {
    const previous = rows[rows.length - 1];
    const folded = collapsed.has(id) && id !== focusId;
    const narrow = folded || !WIDE_PANELS.has(id);
    const previousId = previous?.[0];
    if (twoColumns && narrow && previous?.length === 1 &&
        collapsed.has(previousId) === folded &&
        (folded || !WIDE_PANELS.has(previousId))) previous.push(id);
    else rows.push([id]);
  }
  const placements = new Map(rows.flatMap((row, index) => row.map((id, column) =>
    [id, { gridRow: index + 1, gridColumn: row.length === 1 ? '1 / -1' : String(column + 1) }] as const)));
  const rowSizes = rows.map(row => row.every(id => collapsed.has(id) && id !== focusId)
    ? '42px' : 'minmax(180px, 1fr)').join(' ');
  if (!rightStack.length) return null;
  return (
    <section ref={regionRef} className="bento-region" aria-label="Workspace tool grid">
      <div style={{ gridTemplateColumns: twoColumns ? "repeat(2,minmax(0,1fr))" : "minmax(0,1fr)", gridTemplateRows: rowSizes }} className={`bento-grid ${rightStack.length === 1 ? 'bento-grid--single' : ''} ${focusId ? 'bento-grid--focused' : ''}`}>
        {rightStack.map(id => {
          const meta = RIGHT_PANEL_META[id];
          if (!meta) return null;
          const Icon = meta.icon;
          const isCollapsed = collapsed.has(id) && focusId !== id;
          const badge = id === 'diff' ? pendingDiffs.length : id === 'watchers' ? watchers.filter(w => !w.settled).length : 0;
          return (
            <section key={id} aria-label={meta.label} style={placements.get(id)}
              hidden={!!focusId && focusId !== id}
              className={`bento-cell card ${WIDE_PANELS.has(id) ? 'bento-cell--wide' : ''} ${id === 'preview' || id === 'file-preview' ? 'bento-cell--hero' : ''} ${isCollapsed ? 'bento-cell--collapsed' : ''}`}>
              <header className="bento-header">
                <Icon size={14} />
                <span className="bento-title">{meta.label}</span>
                {badge > 0 && <span className="bento-badge">{badge}</span>}
                <button onClick={() => setFocused(focusId === id ? null : id)}
                  aria-label={focusId === id ? `Restore ${meta.label} to grid` : `Focus ${meta.label}`}
                  title={focusId === id ? 'Restore to grid' : 'Focus panel'} aria-pressed={focusId === id}>
                  {focusId === id ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
                <button onClick={() => {
                    if (focusId === id) {
                      setFocused(null);
                      setCollapsed(prev => new Set([...prev, id]));
                    } else toggleCollapse(id);
                  }}
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${meta.label}`} aria-expanded={!isCollapsed}
                  aria-controls={`bento-content-${id}`} title={isCollapsed ? 'Expand' : 'Collapse'}>
                  <ChevronDown size={14} className={isCollapsed ? '-rotate-90' : ''} />
                </button>
                <button onClick={() => closeRightContext(id)} aria-label={`Close ${meta.label}`} title={`Close ${meta.label}`}><X size={14} /></button>
              </header>
              <div id={`bento-content-${id}`} className="bento-content" hidden={isCollapsed}>{meta.render()}</div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
