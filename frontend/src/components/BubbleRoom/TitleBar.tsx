import React, { useEffect, useRef, useState } from 'react';
import { isDesktop } from '../../hooks/useDesktop';
import { useStore } from '../../store';
import { ArrowLeft, ArrowRight, PanelLeft, Search } from '../Shared/icons';
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
      className="desktop-titlebar"
      style={DRAG}
    >
      {/* Window navigation, aligned over the sidebar like a browser's. */}
      <div className="flex items-center gap-0.5" style={NO_DRAG}>
        <button
          onClick={() => store.setLeftHidden(!store.leftHidden)}
          className={`titlebar-icon ${store.leftHidden ? '' : 'titlebar-icon--active'}`}
          title={store.leftHidden ? 'Show sidebar (Ctrl+B)' : 'Hide sidebar (Ctrl+B)'}
          aria-label={store.leftHidden ? 'Show sidebar' : 'Hide sidebar'}
          aria-pressed={!store.leftHidden}
        >
          <PanelLeft size={15} />
        </button>
        <button onClick={() => window.history.back()} className="titlebar-icon" title="Back" aria-label="Back">
          <ArrowLeft size={15} />
        </button>
        <button onClick={() => window.history.forward()} className="titlebar-icon" title="Forward" aria-label="Forward">
          <ArrowRight size={15} />
        </button>
      </div>

      {/* Menus: the OS menu bar is hidden, so File / View / Help live here. */}
      <div className="flex items-center ml-1" style={NO_DRAG}>
        {menus.map((menu) => (
          <div key={menu.label} className="relative">
            <button
              onClick={() => setOpenMenu((m) => (m === menu.label ? null : menu.label))}
              onMouseEnter={() => { if (openMenu) setOpenMenu(menu.label); }}
              className={`titlebar-menu ${openMenu === menu.label ? 'is-open' : ''}`}
            >
              {menu.label}
            </button>
            {openMenu === menu.label && (
              <div className="titlebar-dropdown motion-pop">
                {menu.items.map((entry, i) => (
                  <React.Fragment key={entry.label}>
                    <button onClick={() => runEntry(entry)} className="titlebar-dropdown-item">
                      <span>{entry.label}</span>
                      {entry.hint && <kbd>{entry.hint}</kbd>}
                    </button>
                    {entry.separatorAfter && i < menu.items.length - 1 && <div className="titlebar-dropdown-sep" />}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex-1 flex justify-center min-w-0" style={NO_DRAG}>
        <ModeTabs />
      </div>

      <div className="flex items-center gap-1" style={NO_DRAG}>
        <button
          onClick={() => store.setCommandPaletteOpen(true)}
          className="titlebar-search"
          title="Search & commands (Ctrl+K)"
        >
          <Search size={13} className="shrink-0" />
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        <ThemeToggle />
      </div>

      {/* Room for the native window controls drawn by the title-bar overlay. */}
      <div style={{ width: 140 }} className="shrink-0" />
    </div>
  );
}
