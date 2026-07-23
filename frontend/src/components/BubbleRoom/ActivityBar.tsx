import React from 'react';
import { useStore } from '../../store';
import { isDesktop } from '../../hooks/useDesktop';
import {
  MessageSquare,
  Folder,
  ClipboardList,
  Clock,
  Settings,
  LayoutGrid,
  HardDrive,
  Command,
  Plus,
} from '../Shared/icons';

const NAV_ITEMS = [
  { id: 'chat' as const, icon: MessageSquare, label: 'Chat' },
  { id: 'threads' as const, icon: LayoutGrid, label: 'Threads' },
  { id: 'files' as const, icon: Folder, label: 'Explorer' },
  { id: 'specs' as const, icon: ClipboardList, label: 'Specs' },
  { id: 'workspace' as const, icon: HardDrive, label: 'Workspaces' },
  { id: 'audit' as const, icon: Clock, label: 'Audit' },
];

/**
 * Activity bar — the slim icon rail on the far left, VS Code-style.
 * Switches the primary sidebar/main content; bottom holds terminal,
 * command palette, and settings.
 */
export function ActivityBar() {
  const {
    activePanel, setActivePanel, isRunning,
    setCommandPaletteOpen,
    setCurrentSessionId, setCurrentThreadType,
  } = useStore();

  const handleNewSession = () => {
    useStore.getState().resetThreadState();
    setCurrentSessionId(null);
    setCurrentThreadType('vibe_coding');
    try { window.location.hash = '/chat'; } catch { /* ignore */ }
    setActivePanel('chat');
  };

  const Item = ({ id, icon: Icon, label, active, onClick, badge, count }: {
    id: string; icon: any; label: string; active: boolean; onClick: () => void; badge?: boolean; count?: number;
  }) => (
    <button
      key={id}
      onClick={onClick}
      title={label}
      className={`relative w-12 h-11 flex items-center justify-center transition-colors ${
        active
          ? 'text-text border-l-2 border-primary bg-surface-2'
          : 'text-text-dim hover:text-text border-l-2 border-transparent'
      }`}
    >
      <Icon size={20} />
      {badge && <span className="absolute top-2 right-2.5 w-1.5 h-1.5 rounded-full bg-green-agent animate-pulse-slow" />}
      {!!count && count > 0 && (
        <span className="absolute top-1.5 right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-surface-0 text-[9px] font-bold flex items-center justify-center">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );

  return (
    <div className="w-12 shrink-0 card bg-surface-1 flex flex-col items-stretch overflow-hidden">
      {/* Brand bubble — only in the browser. The desktop shell shows the brand
          in the custom title bar, so we hide this duplicate there. Uses the
          Bubbly purple gradient (not the orange --primary accent). */}
      {!isDesktop() && (
        <div className="w-12 h-11 flex items-center justify-center" title="Bubbly">
          <svg viewBox="0 0 32 32" className="w-5 h-5">
            <defs>
              <radialGradient id="ab-bubble" cx="40%" cy="35%" r="65%">
                <stop offset="0%" stopColor="#a78bfa" />
                <stop offset="100%" stopColor="#5b21b6" />
              </radialGradient>
            </defs>
            <circle cx="16" cy="16" r="13" fill="url(#ab-bubble)" />
            <circle cx="11" cy="11" r="3" fill="white" fillOpacity="0.3" />
          </svg>
        </div>
      )}

      {/* New chat — relocated from the chat panel header */}
      <button
        onClick={handleNewSession}
        title="New chat"
        className="w-12 h-11 flex items-center justify-center text-text-dim hover:text-text border-l-2 border-transparent transition-colors"
      >
        <Plus size={20} />
      </button>

      <div className="h-px bg-border mx-2 my-1" />

      {NAV_ITEMS.map((it) => (
        <Item
          key={it.id}
          id={it.id}
          icon={it.icon}
          label={it.label}
          active={activePanel === it.id}
          onClick={() => setActivePanel(it.id)}
          badge={it.id === 'chat' && isRunning}
        />
      ))}

      <div className="flex-1" />

      {/* NOTE: context launchers (Browser / Background / Changes / Terminal /
          Specs / Tasks / Audit) live in the bottom status pill, not here. */}
      <Item
        id="palette"
        icon={Command}
        label="Command Palette (Ctrl+K)"
        active={false}
        onClick={() => setCommandPaletteOpen(true)}
      />
      <Item
        id="settings"
        icon={Settings}
        label="Settings"
        active={activePanel === 'settings'}
        onClick={() => setActivePanel('settings')}
      />
    </div>
  );
}
