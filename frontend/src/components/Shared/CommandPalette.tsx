import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { findFiles, fetchFileContent } from '../../hooks/useApi';
import {
  MessageSquare, Folder, ClipboardList, Clock, Settings, LayoutGrid,
  HardDrive, Terminal, Plus, Command, Sun, Moon, Monitor, FileCode,
} from './icons';

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  keywords?: string;
}

interface CommandPaletteProps {
  onThreadSelect?: (threadId: string) => void;
}

/**
 * Command palette (Ctrl/Cmd+K) — fast keyboard navigation, the hallmark of a
 * real IDE. Lists panel navigation, terminal, theme, and session actions.
 */
export function CommandPalette({ onThreadSelect }: CommandPaletteProps) {
  const store = useStore();
  const { commandPaletteOpen, setCommandPaletteOpen } = store;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkey: Ctrl/Cmd+K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!useStore.getState().commandPaletteOpen);
      }
      if (e.key === 'Escape' && useStore.getState().commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
      // Ctrl+` toggles the terminal panel, like VS Code.
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        useStore.getState().toggleRightContext('terminal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCommandPaletteOpen]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelected(0);
      setFileResults([]);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [commandPaletteOpen]);

  // Debounced fuzzy file search against the workspace while the palette is open.
  useEffect(() => {
    if (!commandPaletteOpen) return;
    const q = query.trim();
    if (q.length < 2 || !store.workspacePath) { setFileResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const files = await findFiles(store.workspacePath, q, 12);
        if (!cancelled) setFileResults(files);
      } catch { if (!cancelled) setFileResults([]); }
    }, 140);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, commandPaletteOpen, store.workspacePath]);

  const openFileFromPalette = async (relPath: string) => {
    setCommandPaletteOpen(false);
    try {
      const data = await fetchFileContent(store.workspacePath, relPath);
      store.setOpenFile(relPath, data.content);
      store.setActivePanel('files');
    } catch { /* ignore */ }
  };

  const commands = useMemo<CommandItem[]>(() => {
    const go = (panel: any) => () => { store.setActivePanel(panel); setCommandPaletteOpen(false); };
    return [
      { id: 'chat', label: 'Go to Chat', icon: <MessageSquare size={15} />, run: go('chat'), keywords: 'conversation' },
      { id: 'threads', label: 'Go to Threads', icon: <LayoutGrid size={15} />, run: go('threads'), keywords: 'history sessions' },
      { id: 'files', label: 'Go to Files', icon: <Folder size={15} />, run: go('files'), keywords: 'explorer editor' },
      { id: 'specs', label: 'Go to Specs', icon: <ClipboardList size={15} />, run: go('specs') },
      { id: 'workspace', label: 'Go to Workspaces', icon: <HardDrive size={15} />, run: go('workspace') },
      { id: 'audit', label: 'Go to Audit', icon: <Clock size={15} />, run: go('audit') },
      { id: 'settings', label: 'Open Settings', icon: <Settings size={15} />, run: go('settings'), keywords: 'config preferences' },
      {
        id: 'terminal',
        label: 'Toggle Terminal',
        hint: 'Ctrl+`',
        icon: <Terminal size={15} />,
        run: () => { store.toggleRightContext('terminal'); setCommandPaletteOpen(false); },
        keywords: 'shell console',
      },
      {
        id: 'new-terminal',
        label: 'New Terminal',
        icon: <Plus size={15} />,
        run: () => { store.openRightContext('terminal'); setCommandPaletteOpen(false); },
        keywords: 'shell',
      },
      {
        id: 'new-session',
        label: 'New Chat Session',
        icon: <Plus size={15} />,
        run: () => { store.clearMessages(); store.setCurrentSessionId(null); store.setActivePanel('chat'); setCommandPaletteOpen(false); },
        keywords: 'reset clear',
      },
      { id: 'theme-dark', label: 'Theme: Dark', icon: <Moon size={15} />, run: () => { store.setTheme('dark'); setCommandPaletteOpen(false); } },
      { id: 'theme-light', label: 'Theme: Light', icon: <Sun size={15} />, run: () => { store.setTheme('light'); setCommandPaletteOpen(false); } },
      { id: 'theme-system', label: 'Theme: System', icon: <Monitor size={15} />, run: () => { store.setTheme('system'); setCommandPaletteOpen(false); } },
    ];
  }, [store, setCommandPaletteOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + ' ' + (c.keywords ?? '')).toLowerCase().includes(q));
  }, [query, commands]);

  // File results become command items appended after matching commands.
  const fileItems = useMemo<CommandItem[]>(
    () =>
      fileResults.map((p) => ({
        id: `file:${p}`,
        label: p.split(/[\\/]/).pop() || p,
        hint: p,
        icon: <FileCode size={15} />,
        run: () => openFileFromPalette(p),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileResults]
  );

  const results = useMemo(() => [...filtered, ...fileItems], [filtered, fileItems]);

  // Keep the selection within bounds when results change.
  useEffect(() => { setSelected((s) => Math.min(s, Math.max(0, results.length - 1))); }, [results.length]);

  if (!commandPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-2xl border border-border-bright bg-surface-1 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Command size={16} className="text-accent-bright" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); results[selected]?.run(); }
            }}
            placeholder="Search files & commands…"
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder:text-text-dim"
          />
          <kbd className="text-[10px] text-text-dim border border-border rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-text-dim">No results</div>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                onMouseEnter={() => setSelected(i)}
                onClick={() => c.run()}
                className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  i === selected ? 'bg-accent/15 text-text' : 'text-text-muted hover:bg-surface-2'
                }`}
              >
                <span className="text-text-dim shrink-0">{c.icon}</span>
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && (
                  <span className="text-[10px] text-text-dim truncate max-w-[200px]" title={c.hint}>{c.hint}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
