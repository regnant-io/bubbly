import React from 'react';
import { useStore } from '../../store';
import { BubblyMark } from '../Shared/BubblyMark';
import {
  SquarePen, Search, Folder, ClipboardList, HardDrive, History, Settings,
  PanelLeftClose, PanelLeftOpen, ChevronsUpDown, AlertCircle, ChevronRight, MessageSquare,
} from '../Shared/icons';
import { useThreadList, threadTitle, relativeTime, startNewThread, openThread, refreshThreads, type ThreadRow } from '../../utils/threads';
import { useAppContextMenu } from '../Shared/ContextMenu';

type PanelId = 'files' | 'specs' | 'workspace' | 'audit' | 'threads' | 'settings' | 'chat';

const NAV: Array<{ id: PanelId; icon: typeof Folder; label: string }> = [
  { id: 'files', icon: Folder, label: 'Files' },
  { id: 'specs', icon: ClipboardList, label: 'Specs' },
  { id: 'workspace', icon: HardDrive, label: 'Workspaces' },
  { id: 'audit', icon: History, label: 'Activity' },
];

function basename(p: string | null | undefined): string {
  return (p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Fixed-height placeholder rows while the first list loads — no layout jump. */
function ThreadSkeleton() {
  return (
    <div aria-hidden="true">
      {[72, 54, 64, 46, 58].map((w, i) => (
        <div key={i} className="sb-thread sb-thread--ghost">
          <span className="skeleton" style={{ width: `${w}%`, height: 8, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

const ThreadItem = React.memo(function ThreadItem({
  row, active, onOpen,
}: { row: ThreadRow; active: boolean; onOpen: (id: string) => void }) {
  const title = threadTitle(row);
  const { bind } = useAppContextMenu();
  return (
    <button
      className={`sb-thread ${active ? 'is-active' : ''} ${row.running ? 'is-running' : ''}`}
      onClick={() => onOpen(row.id)}
      title={title}
      aria-current={active ? 'page' : undefined}
      {...bind(() => [
        { label: 'Open', onSelect: () => onOpen(row.id), separatorAfter: true },
        { label: 'Delete thread…', danger: true, disabled: row.running, onSelect: () => { void deleteThread(row.id, title); } },
      ])}
    >
      <span className="sb-thread-title">{title}</span>
      <span className="sb-thread-meta">
        {row.running
          ? <span className="sb-thread-live" aria-label="Running" />
          : relativeTime(row.updatedAt)}
      </span>
    </button>
  );
});

/** Delete from the sidebar: confirm, remove, and step off it if it is open. */
async function deleteThread(id: string, title: string): Promise<void> {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(res.statusText);
    if (useStore.getState().currentSessionId === id) startNewThread();
  } catch (err) {
    console.warn('Could not delete thread:', err);
  } finally {
    void refreshThreads();
  }
}

/** A project's threads, folded under its folder name. */
function ProjectGroup({
  name, path, rows, single, defaultOpen, currentSessionId, onOpen,
}: {
  name: string;
  path: string;
  rows: ThreadRow[];
  /** The only project: no header, just the threads. */
  single: boolean;
  defaultOpen: boolean;
  currentSessionId: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Opening a thread in a folded project unfolds it, so the selection is seen.
  React.useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const running = rows.some((r) => r.running);
  const list = rows.map((row) => (
    <ThreadItem key={row.id} row={row} active={row.id === currentSessionId} onOpen={onOpen} />
  ));
  if (single) return <>{list}</>;
  return (
    <div className={`sb-project ${open ? 'is-open' : ''}`}>
      <button className="sb-project-row" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={path || undefined}>
        <ChevronRight size={12} className="sb-project-caret" />
        <span className="sb-project-name">{name}</span>
        {running && !open && <span className="sb-thread-live" aria-label="A thread is running" />}
        <span className="sb-project-count">{rows.length}</span>
      </button>
      {open && <div className="sb-project-threads">{list}</div>}
    </div>
  );
}

/**
 * The left sidebar: start work, jump to a tool, and — the thing it is mostly
 * for — get back to a thread.
 *
 * Threads live HERE, the way they do in every agent app people already know,
 * rather than one click away behind a "Conversations" panel. A thread working
 * in the background carries a live dot, so "is that build still going?" is
 * answered without opening anything.
 */
export function ActivityBar({ onThreadSelect }: { onThreadSelect?: (id: string) => void }) {
  const activePanel = useStore((s) => s.activePanel);
  const setActivePanel = useStore((s) => s.setActivePanel);
  const navHidden = useStore((s) => s.navHidden);
  const setNavHidden = useStore((s) => s.setNavHidden);
  const workspacePath = useStore((s) => s.workspacePath);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const { threads, failed } = useThreadList();
  const rightStackCount = useStore((s) => s.rightStack.length);
  const uiMode = useStore((s) => s.uiMode);

  /*
   * A crowded window folds the sidebar to its icon rail by itself.
   *
   * With a second column open (files, specs…), a tool panel on the right or
   * the editor layout, a full sidebar on a laptop-width window left the
   * conversation too narrow to read — or pushed it off the edge entirely.
   * This never overrides a choice the user made; it only stops the default
   * from being unusable. Widen the window and the sidebar comes back.
   */
  const [narrow, setNarrow] = React.useState(() => typeof window !== 'undefined' && window.innerWidth < 1280);
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 1279px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const secondColumn = ['files', 'threads', 'specs', 'workspace', 'audit'].includes(activePanel);
  const crowded = narrow && (secondColumn || rightStackCount > 0 || uiMode === 'editor');
  const collapsed = navHidden || crowded;

  const open = React.useCallback((id: string) => {
    if (onThreadSelect) onThreadSelect(id);
    else void openThread(id);
  }, [onThreadSelect]);

  // A tool is a toggle: clicking the open one goes back to the conversation.
  const go = (id: PanelId) => setActivePanel(activePanel === id ? 'chat' : id);

  const wsName = basename(workspacePath);
  // Threads grouped by project, the current project first, then by recency.
  const groups = React.useMemo(() => {
    const byPath = new Map<string, ThreadRow[]>();
    for (const row of threads ?? []) {
      const key = row.workspacePath ?? '';
      const list = byPath.get(key);
      if (list) list.push(row); else byPath.set(key, [row]);
    }
    return [...byPath.entries()]
      .map(([path, rows]) => ({ path, rows }))
      .sort((a, b) => (a.path === workspacePath ? -1 : b.path === workspacePath ? 1 : 0));
  }, [threads, workspacePath]);

  return (
    <nav className={`sb ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main navigation">
      <div className="sb-top">
        <div className="sb-brand">
          <BubblyMark size={18} />
          <span>bubbly</span>
        </div>
        <button
          className="sb-icon"
          onClick={() => setNavHidden(!navHidden)}
          disabled={crowded && !navHidden}
          title={crowded && !navHidden ? 'Widen the window to expand the sidebar' : collapsed ? 'Expand sidebar (Ctrl+Shift+B)' : 'Collapse sidebar (Ctrl+Shift+B)'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <div className="sb-actions">
        <button className="sb-item sb-item--primary" onClick={startNewThread} title="New thread">
          <SquarePen size={15} /><span>New thread</span>
        </button>
        {/* In the icon rail the thread list is gone, so threads get a door of their own. */}
        <button
          className="sb-item sb-rail-only"
          onClick={() => go('threads')}
          aria-current={activePanel === 'threads' ? 'page' : undefined}
          title="Threads"
        >
          <MessageSquare size={15} /><span>Threads</span>
        </button>
        <button className="sb-item" onClick={() => setCommandPaletteOpen(true)} title="Search (Ctrl+K)">
          <Search size={15} /><span>Search</span><kbd>Ctrl K</kbd>
        </button>
        {NAV.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            className="sb-item"
            aria-current={activePanel === id ? 'page' : undefined}
            onClick={() => go(id)}
            title={label}
          >
            <Icon size={15} /><span>{label}</span>
          </button>
        ))}
      </div>

      <div className="sb-section">
        <span>Threads</span>
        <button onClick={() => go('threads')} aria-current={activePanel === 'threads' ? 'page' : undefined}>
          View all
        </button>
      </div>
      <div className="sb-threads">
        {threads === null && !failed && <ThreadSkeleton />}
        {failed && (
          <p className="sb-empty"><AlertCircle size={12} /> Couldn’t load threads</p>
        )}
        {threads && threads.length === 0 && (
          <p className="sb-empty">No threads yet. Start one above.</p>
        )}
        {groups.map((g) => (
          <ProjectGroup
            key={g.path || 'none'}
            name={basename(g.path) || 'Other'}
            path={g.path}
            rows={g.rows}
            single={groups.length === 1}
            defaultOpen={g.path === workspacePath || g.rows.some((r) => r.id === currentSessionId || r.running)}
            currentSessionId={currentSessionId}
            onOpen={open}
          />
        ))}
      </div>

      <div className="sb-foot">
        <button
          className="sb-workspace"
          onClick={() => go('workspace')}
          title={workspacePath ? `${workspacePath}\nSwitch workspace` : 'Choose a workspace'}
        >
          <span className="sb-workspace-icon"><Folder size={14} /></span>
          <span className="sb-workspace-text">
            <strong>{wsName || 'No workspace'}</strong>
            <small>{workspacePath ? 'Local' : 'Choose a folder'}</small>
          </span>
          <ChevronsUpDown size={13} className="sb-workspace-caret" />
        </button>
        <button
          className="sb-icon"
          onClick={() => go('settings')}
          aria-current={activePanel === 'settings' ? 'page' : undefined}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
        >
          <Settings size={15} />
        </button>
      </div>
    </nav>
  );
}
