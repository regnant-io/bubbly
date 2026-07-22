import React from 'react';
import { useStore } from '../../store';
import {
  MessageSquare,
  Folder,
  ClipboardList,
  Clock,
  Settings,
  LayoutGrid,
  HardDrive,
  Terminal,
  Command,
} from '../Shared/icons';

const NAV_ITEMS = [
  { id: 'chat' as const, icon: MessageSquare, label: 'Chat' },
  { id: 'threads' as const, icon: LayoutGrid, label: 'Threads' },
  { id: 'files' as const, icon: Folder, label: 'Files' },
  { id: 'specs' as const, icon: ClipboardList, label: 'Specs' },
  { id: 'workspace' as const, icon: HardDrive, label: 'Workspace' },
  { id: 'audit' as const, icon: Clock, label: 'Audit' },
  { id: 'settings' as const, icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const { activePanel, setActivePanel, isRunning, bottomPanelOpen, setBottomPanelOpen, setCommandPaletteOpen } = useStore();

  return (
    <div className="w-14 h-full bg-surface-1 border-r border-border flex flex-col items-center py-3 gap-1 shrink-0">
      {/* Logo */}
      <div className="w-9 h-9 rounded-xl bg-primary-light border border-primary/25 flex items-center justify-center mb-2 shrink-0">
        <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5">
          <circle cx="10" cy="10" r="8" fill="url(#logo-grad)" />
          <circle cx="7" cy="8" r="2.5" fill="white" fillOpacity="0.2" />
          <circle cx="6" cy="7" r="1.2" fill="white" fillOpacity="0.45" />
          <defs>
            <radialGradient id="logo-grad" cx="35%" cy="30%" r="70%">
              <stop offset="0%" stopColor="var(--brown-primary)" />
              <stop offset="100%" stopColor="var(--brown-secondary)" />
            </radialGradient>
          </defs>
        </svg>
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          onClick={() => setActivePanel(id)}
          title={label}
          className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all relative ${
            activePanel === id
              ? 'bg-surface-3 text-text border border-border-bright'
              : 'text-text-dim hover:text-text hover:bg-surface-2'
          }`}
        >
          <Icon size={17} />
          {id === 'chat' && isRunning && (
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-green-agent animate-pulse-slow" />
          )}
        </button>
      ))}

      {/* Spacer pushes utility buttons to the bottom */}
      <div className="flex-1" />

      {/* Terminal toggle */}
      <button
        onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
        title="Toggle Terminal (Ctrl+`)"
        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
          bottomPanelOpen
            ? 'bg-surface-3 text-text border border-border-bright'
            : 'text-text-dim hover:text-text hover:bg-surface-2'
        }`}
      >
        <Terminal size={17} />
      </button>

      {/* Command palette */}
      <button
        onClick={() => setCommandPaletteOpen(true)}
        title="Command Palette (Ctrl+K)"
        className="w-10 h-10 rounded-xl flex items-center justify-center text-text-dim hover:text-text hover:bg-surface-2 transition-all"
      >
        <Command size={17} />
      </button>
    </div>
  );
}
