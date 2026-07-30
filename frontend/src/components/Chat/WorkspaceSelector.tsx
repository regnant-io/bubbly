import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Folder, ChevronDown, Check, Plus, FolderOpen } from '../Shared/icons';
import { isDesktop } from '../../hooks/useDesktop';

/** Short display name for a path (last 1–2 segments). */
function shortName(p: string): string {
  if (!p) return 'No workspace';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Workspace shortcut that floats above the composer. Shows the current
 * workspace and a dropdown of recent workspaces to switch between, plus an
 * "Open folder…" action (native picker in desktop) to add a new one.
 *
 * `variant` only changes the trigger's chrome: 'pill' is the standalone
 * floating capsule used over the input's top edge; 'inline' is the flat style
 * for sitting inside a toolbar row.
 */
export function WorkspaceSelector({ variant = 'inline' }: { variant?: 'pill' | 'inline' }) {
  const { workspacePath, recentWorkspaces, switchWorkspace } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pickFolder = async () => {
    if (isDesktop() && window.bubblyDesktop) {
      const folder = await window.bubblyDesktop.pickFolder();
      if (folder) switchWorkspace(folder);
    } else {
      const entered = window.prompt('Enter an absolute workspace path:');
      if (entered && entered.trim()) switchWorkspace(entered.trim());
    }
    setOpen(false);
  };

  const recents = recentWorkspaces.filter((p) => p && p !== workspacePath);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          variant === 'pill'
            ? `flex items-center gap-1.5 rounded-full border bg-surface-2 px-2.5 py-1 text-[11px] shadow-sm
               transition-colors max-w-[200px] ${open ? 'border-accent/50 text-text' : 'border-border text-text-dim hover:text-text hover:border-border-bright'}`
            : 'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-text-dim hover:text-text hover:bg-surface-3 transition-colors max-w-[180px]'
        }
        title={workspacePath || 'Select a workspace'}
      >
        <Folder size={variant === 'pill' ? 11 : 13} className="text-amber-agent/70 shrink-0" />
        <span className="truncate">{shortName(workspacePath)}</span>
        <ChevronDown size={variant === 'pill' ? 10 : 12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-72 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface-1 shadow-xl py-1">
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-dim">Workspace</div>

          {workspacePath && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-accent-bright">
              <FolderOpen size={13} className="shrink-0" />
              <span className="truncate flex-1" title={workspacePath}>{shortName(workspacePath)}</span>
              <Check size={12} className="shrink-0" />
            </div>
          )}

          {recents.length > 0 && (
            <>
              <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-text-dim">Recent</div>
              {recents.map((p) => (
                <button
                  key={p}
                  onClick={() => { switchWorkspace(p); setOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-text-muted hover:bg-surface-3 transition-colors"
                  title={p}
                >
                  <Folder size={13} className="text-amber-agent/60 shrink-0" />
                  <span className="truncate flex-1">{shortName(p)}</span>
                  <span className="truncate text-[10px] text-text-dim max-w-[90px]">{p.replace(/[\\/][^\\/]+$/, '')}</span>
                </button>
              ))}
            </>
          )}

          <div className="border-t border-border mt-1 pt-1">
            <button
              onClick={pickFolder}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-text-muted hover:bg-surface-3 transition-colors"
            >
              <Plus size={13} className="shrink-0" />
              Open folder…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
