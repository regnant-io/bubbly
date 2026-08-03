import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import {
  fetchDirectory, fetchFileContent, type DirEntry,
  createEntryApi, renameEntryApi, duplicateEntryApi, trashEntryApi, revealEntryApi,
} from '../../hooks/useApi';
import {
  Folder, RefreshCw, ChevronRight, ChevronDown, Search, X, Loader2,
  FilePlus, FolderPlus, Pencil, Copy, Trash2, ExternalLink, File as FileIcon,
  ChevronsDownUp,
} from '../Shared/icons';
import { useAppContextMenu } from '../Shared/ContextMenu';
import { PanelHeader, PanelHeaderButton } from '../Shared/PanelHeader';
import { getFileIcon, getFolderIcon } from './fileIcons';

/** An in-progress create or rename, edited inline in the tree. */
type PendingEdit =
  | { kind: 'create'; type: 'file' | 'directory'; parent: string; value: string }
  | { kind: 'rename'; path: string; value: string };

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
  const { workspacePath, setOpenFile, activeEditorPath, editorTabs, expandedFolders, toggleFolderExpansion, setExpandedFolders, closeEditorTab } = useStore();
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

  // --- File CRUD -------------------------------------------------------------

  const { bind } = useAppContextMenu();
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingEdit) {
      editInputRef.current?.focus();
      // Preselect the basename on rename, not the extension — renaming
      // "Button.tsx" almost always means changing "Button".
      const el = editInputRef.current;
      if (el && pendingEdit.kind === 'rename') {
        const dot = pendingEdit.value.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : pendingEdit.value.length);
      }
    }
  }, [pendingEdit?.kind, pendingEdit?.kind === 'rename' ? pendingEdit.path : (pendingEdit as any)?.parent]);

  /** Reload just the folder an operation touched, so the tree stays put. */
  const refreshDir = (dirPath: string) => loadDir(dirPath);

  const parentOf = (p: string) => {
    const i = p.replace(/\\/g, '/').lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  };

  const startCreate = (parent: string, type: 'file' | 'directory') => {
    setOpError(null);
    // Creating inside a collapsed folder would hide the result — open it first.
    if (parent && !expandedSet.has(parent)) {
      toggleFolderExpansion(parent);
      if (children[parent] === undefined) loadDir(parent);
    }
    setPendingEdit({ kind: 'create', type, parent, value: '' });
  };

  const commitEdit = async () => {
    if (!pendingEdit || !workspacePath) return;
    const name = pendingEdit.value.trim();
    if (!name) { setPendingEdit(null); return; }
    setOpError(null);
    try {
      if (pendingEdit.kind === 'create') {
        const r = await createEntryApi(workspacePath, pendingEdit.parent, name, pendingEdit.type);
        await refreshDir(pendingEdit.parent);
        setPendingEdit(null);
        // Open a new file immediately — creating one is almost always the first
        // half of "and now let me write in it".
        if (pendingEdit.type === 'file' && r.path) setOpenFile(r.path, '');
      } else {
        const dir = parentOf(pendingEdit.path);
        const wasOpen = editorTabs.some((t) => t.path === pendingEdit.path);
        const r = await renameEntryApi(workspacePath, pendingEdit.path, name);
        await refreshDir(dir);
        setPendingEdit(null);
        // An open tab pointing at the old name is now pointing at nothing.
        if (wasOpen && r.path) {
          closeEditorTab(pendingEdit.path);
          try {
            const data = await fetchFileContent(workspacePath, r.path);
            setOpenFile(r.path, data.content);
          } catch { /* the file may be a directory or binary */ }
        }
      }
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDuplicate = async (entry: DirEntry) => {
    if (!workspacePath) return;
    setOpError(null);
    try {
      await duplicateEntryApi(workspacePath, entry.path);
      await refreshDir(parentOf(entry.path));
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTrash = async (entry: DirEntry) => {
    if (!workspacePath) return;
    const what = entry.type === 'directory' ? 'folder' : 'file';
    // Named explicitly, and honest about where it goes: the confirm is the only
    // thing standing between a stray click and a deleted directory.
    if (!window.confirm(
      `Move the ${what} "${entry.name}" to the Recycle Bin?\n\n${entry.path}` +
      (entry.type === 'directory' ? '\n\nEverything inside it goes too.' : ''),
    )) return;
    setOpError(null);
    try {
      await trashEntryApi(workspacePath, entry.path);
      if (entry.type !== 'directory') closeEditorTab(entry.path);
      await refreshDir(parentOf(entry.path));
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyToClipboard = (text: string) => { navigator.clipboard?.writeText(text); };

  /** The right-click menu for one entry. Items vary by file vs folder. */
  const menuItemsFor = (entry: DirEntry) => {
    const isDir = entry.type === 'directory';
    const containingDir = isDir ? entry.path : parentOf(entry.path);
    return [
      ...(isDir ? [
        { label: 'New File', icon: <FilePlus size={13} />, onSelect: () => startCreate(entry.path, 'file') },
        { label: 'New Folder', icon: <FolderPlus size={13} />, onSelect: () => startCreate(entry.path, 'directory'), separatorAfter: true },
      ] : [
        { label: 'New File', icon: <FilePlus size={13} />, onSelect: () => startCreate(containingDir, 'file') },
        { label: 'New Folder', icon: <FolderPlus size={13} />, onSelect: () => startCreate(containingDir, 'directory'), separatorAfter: true },
      ]),
      { label: 'Rename…', icon: <Pencil size={13} />, hint: 'F2', onSelect: () => { setOpError(null); setPendingEdit({ kind: 'rename', path: entry.path, value: entry.name }); } },
      { label: 'Duplicate', icon: <Copy size={13} />, onSelect: () => handleDuplicate(entry), separatorAfter: true },
      { label: 'Copy Path', icon: <Copy size={13} />, onSelect: () => copyToClipboard(`${workspacePath}/${entry.path}`.replace(/\\/g, '/')) },
      { label: 'Copy Relative Path', icon: <Copy size={13} />, onSelect: () => copyToClipboard(entry.path) },
      { label: 'Reveal in File Explorer', icon: <ExternalLink size={13} />, onSelect: () => { void revealEntryApi(workspacePath, entry.path).catch(() => setOpError('Could not open the file manager.')); }, separatorAfter: true },
      { label: 'Delete', icon: <Trash2 size={13} />, danger: true, hint: 'to Recycle Bin', onSelect: () => handleTrash(entry) },
    ];
  };

  /** Right-clicking empty space acts on the workspace root. */
  const rootMenuItems = () => [
    { label: 'New File', icon: <FilePlus size={13} />, onSelect: () => startCreate('', 'file') },
    { label: 'New Folder', icon: <FolderPlus size={13} />, onSelect: () => startCreate('', 'directory'), separatorAfter: true },
    { label: 'Refresh', icon: <RefreshCw size={13} />, onSelect: handleRefresh },
  ];

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
      <PanelHeader
        title={workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? 'Explorer'}
        count={total > 0 ? total : undefined}
        actions={
          <>
            <PanelHeaderButton icon={<FilePlus size={13} />} label="New file in the project root" onClick={() => startCreate('', 'file')} />
            <PanelHeaderButton icon={<FolderPlus size={13} />} label="New folder in the project root" onClick={() => startCreate('', 'directory')} />
            <PanelHeaderButton icon={<ChevronsDownUp size={13} />} label="Collapse all folders" onClick={handleCollapseAll} />
            <PanelHeaderButton icon={<RefreshCw size={13} className={rootLoading ? 'animate-spin' : ''} />} label="Refresh" onClick={handleRefresh} />
          </>
        }
      />

      {/* Inline name editor for a create or rename.
          It sits under the header rather than inside the tree because the tree
          is virtualized — splicing a phantom row into a windowed list means the
          input can be scrolled out from under the cursor mid-type. Here it
          stays put, and says exactly what it will do and where. */}
      {pendingEdit && (
        <div className="px-2 py-1.5 border-b border-border shrink-0 bg-surface-2/60">
          <div className="text-[10px] text-text-dim mb-1 truncate">
            {pendingEdit.kind === 'create'
              ? `New ${pendingEdit.type === 'directory' ? 'folder' : 'file'} in ${pendingEdit.parent || 'the project root'}`
              : `Rename ${pendingEdit.path}`}
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-1 border border-accent/60">
            {pendingEdit.kind === 'create' && pendingEdit.type === 'directory'
              ? <Folder size={12} className="text-text-dim shrink-0" />
              : <FileIcon size={12} className="text-text-dim shrink-0" />}
            <input
              ref={editInputRef}
              value={pendingEdit.value}
              onChange={(e) => setPendingEdit({ ...pendingEdit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
                else if (e.key === 'Escape') { e.preventDefault(); setPendingEdit(null); setOpError(null); }
              }}
              placeholder={pendingEdit.kind === 'create' ? (pendingEdit.type === 'directory' ? 'folder name' : 'file name') : 'new name'}
              className="flex-1 bg-transparent text-xs text-text placeholder-text-dim focus:outline-none min-w-0"
            />
            <button onClick={() => { setPendingEdit(null); setOpError(null); }} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text" title="Cancel (Esc)">
              <X size={11} />
            </button>
          </div>
        </div>
      )}

      {opError && (
        <div className="shrink-0 flex items-start gap-1.5 px-3 py-1.5 bg-error-bg border-b border-red-agent/30 text-[11px] text-red-agent">
          <span className="flex-1">{opError}</span>
          <button onClick={() => setOpError(null)} className="shrink-0 hover:underline">dismiss</button>
        </div>
      )}

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

      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto"
        {...bind(rootMenuItems)}
      >
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
                    onKeyDown={(e) => {
                      if (e.key === 'F2') {
                        e.preventDefault();
                        setOpError(null);
                        setPendingEdit({ kind: 'rename', path: entry.path, value: entry.name });
                      }
                    }}
                    className={`group relative w-full flex items-center gap-1 pr-2 text-xs hover:bg-surface-3 transition-colors text-left ${
                      isActive ? 'bg-accent/10 text-accent-bright' : isOpen ? 'text-text' : 'text-text-muted'
                    }`}
                    style={{ height: ROW_HEIGHT }}
                    title={entry.path}
                    {...bind(() => menuItemsFor(entry))}
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
