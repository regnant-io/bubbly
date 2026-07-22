import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { fetchDirectory, fetchFileContent, type DirEntry } from '../../hooks/useApi';
import { Folder, RefreshCw, ChevronRight, ChevronDown, Search, X, Loader2 } from '../Shared/icons';
import { getFileIcon, getFolderIcon } from './fileIcons';

/**
 * Lazy, recursive IDE file tree.
 *
 * Unlike the old approach (parse a depth-limited ASCII tree string), this loads
 * each directory's children on demand from /api/files/list. Every folder — at
 * any depth — keeps its own expand/collapse state, so structure is never lost
 * no matter how large or deeply nested the project is. Reads are shallow (one
 * level per request), so opening a giant folder never blocks the backend.
 */

interface TreeNode {
  entry: DirEntry;
  depth: number;
}

const ROW_HEIGHT = 22;
const OVERSCAN = 10;

export function FileExplorer() {
  const { workspacePath, setOpenFile, activeEditorPath, editorTabs, expandedFolders, toggleFolderExpansion, setExpandedFolders } = useStore();
  const openTabPaths = new Set(editorTabs.map((t) => t.path));

  // Cache of directory path → its children (entries). Root is keyed by ''.
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [rootLoading, setRootLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  const expandedSet = new Set(expandedFolders);

  const loadDir = useCallback(async (dirPath: string) => {
    if (!workspacePath) return;
    setLoadingPaths((s) => new Set(s).add(dirPath));
    try {
      const { entries } = await fetchDirectory(workspacePath, dirPath || '.');
      setChildren((c) => ({ ...c, [dirPath]: entries }));
    } catch {
      setChildren((c) => ({ ...c, [dirPath]: [] }));
    } finally {
      setLoadingPaths((s) => { const n = new Set(s); n.delete(dirPath); return n; });
    }
  }, [workspacePath]);

  // Load the root level on mount / workspace change.
  const loadRoot = useCallback(async () => {
    if (!workspacePath) return;
    setRootLoading(true);
    await loadDir('');
    setRootLoading(false);
  }, [workspacePath, loadDir]);

  useEffect(() => { loadRoot(); }, [loadRoot]);

  // Re-fetch any already-expanded folders that don't have cached children yet
  // (e.g. after a refresh restores expandedFolders from persistence).
  useEffect(() => {
    if (!workspacePath) return;
    for (const p of expandedFolders) {
      if (children[p] === undefined && !loadingPaths.has(p)) loadDir(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedFolders, workspacePath]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleToggleFolder = (entry: DirEntry) => {
    const isOpen = expandedSet.has(entry.path);
    toggleFolderExpansion(entry.path);
    if (!isOpen && children[entry.path] === undefined) {
      loadDir(entry.path);
    }
  };

  const handleOpenFile = async (entry: DirEntry) => {
    try {
      const data = await fetchFileContent(workspacePath, entry.path);
      setOpenFile(entry.path, data.content);
    } catch (e) {
      console.error(e);
    }
  };

  const handleRefresh = () => {
    // Re-fetch root + every currently-expanded folder; keep expansion intact.
    setChildren({});
    loadRoot();
    for (const p of expandedFolders) loadDir(p);
  };

  const handleCollapseAll = () => setExpandedFolders([]);

  // Flatten the tree into the visible, ordered list (respecting expansion).
  // This recursion walks only loaded + expanded folders, so it's cheap.
  const flatten = useCallback((): TreeNode[] => {
    const out: TreeNode[] = [];
    const walk = (dirPath: string, depth: number) => {
      const kids = children[dirPath];
      if (!kids) return;
      for (const entry of kids) {
        out.push({ entry, depth });
        if (entry.type === 'directory' && expandedSet.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };
    walk('', 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, expandedFolders]);

  // When filtering, do a client-side filter over loaded entries (a shallow,
  // forgiving match). For unloaded deep folders the user can expand to search;
  // this keeps filtering instant without a full crawl.
  const allVisible = flatten();
  const q = filter.trim().toLowerCase();
  const visibleNodes = q
    ? allVisible.filter((n) => n.entry.name.toLowerCase().includes(q))
    : allVisible;

  const total = visibleNodes.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const slice = visibleNodes.slice(startIdx, endIdx);

  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <Folder size={28} className="text-text-dim mb-2" />
        <p className="text-sm text-text-dim">No workspace set</p>
        <p className="text-xs text-text-dim mt-1">Configure in Settings</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text truncate uppercase tracking-wide" title={workspacePath}>
          {workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? 'Explorer'}
          {total > 0 ? <span className="text-text-dim normal-case font-normal tracking-normal"> · {total}</span> : null}
        </span>
        <div className="flex items-center gap-1">
          <button onClick={handleCollapseAll} className="px-1.5 py-0.5 text-[10px] rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors" title="Collapse all">
            Collapse
          </button>
          <button onClick={handleRefresh} className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors" title="Refresh">
            <RefreshCw size={12} className={rootLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-2 border border-border focus-within:border-accent/60 transition-colors">
          <Search size={12} className="text-text-dim shrink-0" />
          <input
            value={filter}
            onChange={(e) => { setFilter(e.target.value); if (scrollRef.current) scrollRef.current.scrollTop = 0; setScrollTop(0); }}
            placeholder="Filter open folders…"
            className="flex-1 bg-transparent text-xs text-text placeholder-text-dim focus:outline-none min-w-0"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text" title="Clear">
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="flex-1 overflow-y-auto">
        {rootLoading && total === 0 ? (
          <div className="px-3 py-4 text-xs text-text-dim animate-pulse">Loading…</div>
        ) : total === 0 ? (
          <div className="px-3 py-4 text-xs text-text-dim">{filter ? 'No matches in open folders' : 'Empty'}</div>
        ) : (
          <div style={{ height: total * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ position: 'absolute', top: startIdx * ROW_HEIGHT, left: 0, right: 0 }}>
              {slice.map((node, i) => {
                const { entry, depth } = node;
                const isDir = entry.type === 'directory';
                const expanded = isDir && expandedSet.has(entry.path);
                const isActive = activeEditorPath === entry.path;
                const isOpen = !isDir && openTabPaths.has(entry.path);
                const isLoading = loadingPaths.has(entry.path);
                return (
                  <button
                    key={`${entry.path}-${startIdx + i}`}
                    onClick={() => (isDir ? handleToggleFolder(entry) : handleOpenFile(entry))}
                    className={`group relative w-full flex items-center gap-1 pr-2 text-xs hover:bg-surface-3 transition-colors text-left ${
                      isActive ? 'bg-accent/10 text-accent-bright' : isOpen ? 'text-text' : 'text-text-muted'
                    }`}
                    style={{ height: ROW_HEIGHT }}
                    title={entry.path}
                  >
                    {/* Active-file accent bar (absolute so it doesn't shift content). */}
                    {isActive && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent-bright" />}
                    {/* Indent guides — one subtle vertical rule per depth level. */}
                    {Array.from({ length: depth }).map((_, k) => (
                      <span key={k} className="shrink-0 self-stretch w-3 border-l border-border/40" aria-hidden />
                    ))}
                    <span className="pl-1 flex items-center gap-1 min-w-0">
                    {isDir ? (
                      <>
                        <span className="w-3 shrink-0 flex items-center justify-center">
                          {isLoading
                            ? <Loader2 size={11} className="text-text-dim animate-spin" />
                            : expanded
                            ? <ChevronDown size={11} className="text-text-dim" />
                            : <ChevronRight size={11} className="text-text-dim" />}
                        </span>
                        {getFolderIcon(entry.name, expanded)}
                      </>
                    ) : (
                      <>
                        <span className="w-3 shrink-0" />
                        {getFileIcon(entry.name)}
                      </>
                    )}
                    <span className="truncate">{entry.name}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
