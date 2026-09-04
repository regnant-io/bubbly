import React, { useEffect, useRef, useState } from 'react';
import { isDesktop } from '../../hooks/useDesktop';
import { useStore } from '../../store';
import { Search } from '../Shared/icons';
import { ModeTabs } from './ModeTabs';
import { ThemeToggle } from '../Shared/ThemeToggle';

/**
 * VS Code-style custom title bar for the frameless desktop window.
 *
 * Left: app mark + File / View / Help menu dropdowns (these proxy to native
 * actions via the desktop bridge, since the OS menu bar is hidden).
 * Center: a search box that opens the command palette (commands + navigation).
 * The whole bar is a drag region; interactive controls opt out of dragging.
 *
 * Renders only in the desktop shell — in the browser there's no frame to
 * replace, so it's hidden.
 */

interface MenuEntry {
  label: string;
  action?: string;        // desktop menu-action id
  panel?: string;         // navigate to an in-app panel
  command?: () => void;   // arbitrary in-app command
  hint?: string;
  separatorAfter?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuEntry[];
}

const DRAG = { ['WebkitAppRegion' as any]: 'drag' };
const NO_DRAG = { ['WebkitAppRegion' as any]: 'no-drag' };

export function TitleBar() {
  const store = useStore();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Close any open menu on outside click / escape.
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [openMenu]);

  if (!isDesktop()) return null;

  const runAction = (action: string) => window.bubblyDesktop?.menuAction(action);

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Chat Session', command: () => { store.resetThreadState(); store.setCurrentSessionId(null); store.setActivePanel('chat'); } },
        { label: 'Open Folder…', action: 'open-folder', hint: 'Ctrl+O', separatorAfter: true },
        { label: 'Settings', panel: 'settings', hint: 'Ctrl+,', separatorAfter: true },
        { label: 'Exit', action: 'quit' },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Chat', panel: 'chat', hint: 'Ctrl+1' },
        { label: 'Threads', panel: 'threads', hint: 'Ctrl+2' },
        { label: 'Files', panel: 'files', hint: 'Ctrl+3' },
        { label: 'Specs', panel: 'specs', hint: 'Ctrl+4', separatorAfter: true },
        { label: 'Toggle Terminal', command: () => store.toggleRightContext('terminal'), hint: 'Ctrl+`' },
        { label: 'Command Palette', command: () => store.setCommandPaletteOpen(true), hint: 'Ctrl+K', separatorAfter: true },
        { label: 'Reload', action: 'reload' },
        { label: 'Toggle Developer Tools', action: 'toggle-devtools' },
        { label: 'Zoom In', action: 'zoom-in' },
        { label: 'Zoom Out', action: 'zoom-out' },
        { label: 'Reset Zoom', action: 'zoom-reset', separatorAfter: true },
        { label: 'Toggle Full Screen', action: 'toggle-fullscreen' },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Bubbly on the Web', action: 'open-web' },
        { label: 'View Logs', action: 'view-logs', separatorAfter: true },
        { label: 'About Bubbly', action: 'about' },
      ],
    },
  ];

  const runEntry = (entry: MenuEntry) => {
    setOpenMenu(null);
    if (entry.command) entry.command();
    else if (entry.panel) store.setActivePanel(entry.panel as any);
    else if (entry.action) runAction(entry.action);
  };

  return (
    <div
      ref={barRef}
      className="flex items-center h-9 shrink-0 bg-surface-1 select-none relative z-40"
      style={DRAG}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 pl-3 pr-2 shrink-0">
        <img src="/bubble.svg" alt="" className="w-4 h-4" />
      </div>

      {/* Menus */}
      <div className="flex items-center" style={NO_DRAG}>
        {menus.map((menu) => (
          <div key={menu.label} className="relative">
            <button
              onClick={() => setOpenMenu((m) => (m === menu.label ? null : menu.label))}
              onMouseEnter={() => { if (openMenu) setOpenMenu(menu.label); }}
              className={`px-2.5 h-9 text-xs transition-colors ${
                openMenu === menu.label ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              {menu.label}
            </button>
            {openMenu === menu.label && (
              <div className="absolute top-full left-0 mt-px w-60 rounded-lg border border-border bg-surface-1 shadow-xl py-1 z-50">
                {menu.items.map((entry, i) => (
                  <React.Fragment key={entry.label}>
                    <button
                      onClick={() => runEntry(entry)}
                      className="w-full flex items-center justify-between gap-4 px-3 py-1.5 text-xs text-left text-text-muted hover:bg-accent/15 hover:text-text transition-colors"
                    >
                      <span>{entry.label}</span>
                      {entry.hint && <span className="text-[10px] text-text-dim">{entry.hint}</span>}
                    </button>
                    {entry.separatorAfter && i < menu.items.length - 1 && (
                      <div className="my-1 border-t border-border" />
                    )}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Center search → command palette */}
      <div className="flex-1 flex justify-center items-center gap-3 px-4" style={NO_DRAG}>
        <ModeTabs />
        <button
          onClick={() => store.setCommandPaletteOpen(true)}
          className="flex items-center gap-2 w-full max-w-md h-7 box-border px-3 rounded-md bg-surface-2 border border-border hover:border-border-bright text-text-dim hover:text-text-muted transition-colors"
          title="Search & commands (Ctrl+K)"
        >
          <Search size={12} className="shrink-0" />
          <span className="text-[11px] truncate flex-1 text-left">
            {store.workspacePath ? `Search ${store.workspacePath.split(/[\\/]/).filter(Boolean).pop()}…` : 'Search & run commands…'}
          </span>
          <kbd className="text-[9px] border border-border rounded px-1 py-px shrink-0">Ctrl K</kbd>
        </button>
      </div>

      {/* Theme toggle (sun/moon) */}
      <div className="flex items-center pr-1 shrink-0" style={NO_DRAG}>
        <ThemeToggle />
      </div>

      {/* Right spacer reserves room for native window controls (overlay). */}
      <div style={{ width: 140 }} className="shrink-0" />
    </div>
  );
}
