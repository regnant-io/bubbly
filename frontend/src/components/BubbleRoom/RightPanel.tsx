import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, type RightContextId } from '../../store';
import { AuditPanel } from '../Chat/AuditPanel';
import { SpecPanel } from '../SpecPanel/SpecPanel';
import { TaskQueue } from '../TaskQueue/TaskQueue';
import { DiffViewer } from '../Shared/DiffViewer';
import { BubblyPreview } from './BubblyPreview';
import { BackgroundProcessesPanel } from './BackgroundProcessesPanel';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { Monitor, Server, GitBranch, Terminal, ClipboardList, CheckCircle, Clock, X, ChevronDown } from '../Shared/icons';

const META: Record<RightContextId, { label: string; icon: typeof Monitor; render: () => React.ReactNode }> = {
  preview: { label: 'Bubbly Preview', icon: Monitor, render: () => <BubblyPreview /> },
  background: { label: 'Background', icon: Server, render: () => <BackgroundProcessesPanel /> },
  diff: { label: 'Changes', icon: GitBranch, render: () => <DiffView /> },
  terminal: { label: 'Terminal', icon: Terminal, render: () => <TerminalPanel /> },
  spec: { label: 'Specs', icon: ClipboardList, render: () => <SpecPanel /> },
  tasks: { label: 'Tasks', icon: CheckCircle, render: () => <TaskQueue /> },
  audit: { label: 'Audit', icon: Clock, render: () => <AuditPanel /> },
};

function DiffView() {
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  return (
    <div className="h-full overflow-y-auto p-3">
      <DiffViewer diffs={pendingDiffs} />
    </div>
  );
}

/**
 * Right-side context STACK. Each context opened from the bottom button bar (or
 * activity rail) appears here as its own card; when several are open they stack
 * vertically and share the height. Each card can be collapsed to just its header
 * or closed. This is the "stack modal context on the right" model.
 */
export function RightPanel() {
  const rightStack = useStore((s) => s.rightStack);
  const closeRightContext = useStore((s) => s.closeRightContext);
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  const [collapsed, setCollapsed] = React.useState<Set<RightContextId>>(new Set());

  const toggleCollapse = (id: RightContextId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (rightStack.length === 0) return null;

  return (
    <div className="h-full flex flex-col min-w-[280px] gap-2 overflow-hidden">
      <AnimatePresence initial={false}>
        {rightStack.map((id) => {
          const meta = META[id];
          if (!meta) return null;
          const isCollapsed = collapsed.has(id);
          const Icon = meta.icon;
          return (
            <motion.div
              key={id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className={`card bg-surface-1 overflow-hidden flex flex-col ${isCollapsed ? 'shrink-0' : 'flex-1 min-h-0'}`}
            >
              {/* Card header */}
              <div className="flex items-center gap-2 px-3 h-8 border-b border-border shrink-0 bg-surface-1">
                <Icon size={13} className="text-text-dim shrink-0" />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted flex-1 truncate">{meta.label}</span>
                {id === 'diff' && pendingDiffs.length > 0 && (
                  <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-accent/20 text-accent-bright text-[9px] font-bold flex items-center justify-center">{pendingDiffs.length}</span>
                )}
                <button onClick={() => toggleCollapse(id)} title={isCollapsed ? 'Expand' : 'Collapse'} className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors">
                  <ChevronDown size={13} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                </button>
                <button onClick={() => closeRightContext(id)} title="Close" className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors">
                  <X size={13} />
                </button>
              </div>
              {/* Card content (hidden when collapsed) */}
              {!isCollapsed && <div className="flex-1 min-h-0 overflow-hidden">{meta.render()}</div>}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
