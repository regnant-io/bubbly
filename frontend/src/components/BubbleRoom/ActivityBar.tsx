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
  PanelLeftClose,
} from '../Shared/icons';

type PanelId = 'chat' | 'threads' | 'files' | 'specs' | 'workspace' | 'audit';

/**
 * The rail, in two groups.
 *
 * A flat list of six identical icons made every destination look equally
 * likely, so finding one meant reading all of them. These are not equally
 * likely: the first three are where the work happens and get looked at
 * constantly; the last three are reference material you go to occasionally. A
 * hairline between them is enough to make that difference visible without
 * adding any chrome.
 */
const NAV_GROUPS: Array<Array<{ id: PanelId; icon: typeof MessageSquare; label: string }>> = [
  [
    { id: 'chat', icon: MessageSquare, label: 'Chat' },
    { id: 'threads', icon: LayoutGrid, label: 'Threads' },
    { id: 'files', icon: Folder, label: 'Explorer' },
  ],
  [
    { id: 'specs', icon: ClipboardList, label: 'Specs' },
    { id: 'workspace', icon: HardDrive, label: 'Workspaces' },
    { id: 'audit', icon: Clock, label: 'Audit' },
  ],
];

interface ItemProps {
  icon: typeof MessageSquare;
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: boolean;
  hint?: string;
}

/**
 * One rail button.
 *
 * The active state used to be a left border plus a background tint. On a rail
 * that is already flush against the window edge, a left border reads as part of
 * the frame rather than as a selection — so at a glance nothing looked
 * selected. It is now a filled tile with an accent indicator on the inside
 * edge, pointing at the panel it opens.
 *
 * The label is a real flyout rather than a `title` attribute: the browser's
 * native tooltip takes about a second to appear, which is far too slow for a
 * rail you are meant to scan.
 */
function Item({ icon: Icon, label, active, onClick, badge, hint }: ItemProps) {
  return (
    <div className="relative group/rail px-1.5">
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={`relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
          active
            ? 'bg-accent/15 text-accent-bright'
            : 'text-text-dim hover:text-text hover:bg-surface-3'
        }`}
      >
        <Icon size={17} />
        {badge && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-green-agent animate-pulse-slow" />
        )}
      </button>

      {/* Selection indicator, on the inside edge so it points into the panel. */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r bg-accent-bright" />
      )}

      {/* Hover flyout label. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-1 z-50 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-text shadow-lg opacity-0 group-hover/rail:opacity-100 transition-opacity"
      >
        {label}
        {hint && <span className="ml-1.5 text-text-dim">{hint}</span>}
      </span>
    </div>
  );
}

/**
 * Activity bar — the slim icon rail on the far left.
 *
 * Switches the primary sidebar/main content. Panel launchers for the right-hand
 * stack deliberately do NOT live here; they have their own grouped dock along
 * the bottom, so the rail answers exactly one question: what is the left side
 * showing?
 */
export function ActivityBar() {
  const {
    activePanel, setActivePanel, isRunning,
    setCommandPaletteOpen, setLeftHidden,
    setCurrentSessionId, setCurrentThreadType,
  } = useStore();

  const handleNewSession = () => {
    useStore.getState().resetThreadState();
    setCurrentSessionId(null);
    setCurrentThreadType('vibe_coding');
    try { window.location.hash = '/chat'; } catch { /* ignore */ }
    setActivePanel('chat');
  };

  return (
    <div className="w-12 shrink-0 card bg-surface-1 flex flex-col items-stretch py-1.5 gap-0.5">
      {/* Brand — browser only. The desktop shell shows it in the title bar, so
          repeating it here would just cost a row. */}
      {!isDesktop() && (
        <div className="h-9 flex items-center justify-center mb-0.5" title="Bubbly">
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

      <Item icon={Plus} label="New chat" onClick={handleNewSession} />

      <div className="h-px bg-border mx-3 my-1" />

      {NAV_GROUPS.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div className="h-px bg-border mx-3 my-1" />}
          {group.map((it) => (
            <Item
              key={it.id}
              icon={it.icon}
              label={it.label}
              active={activePanel === it.id}
              onClick={() => setActivePanel(it.id)}
              badge={it.id === 'chat' && isRunning}
            />
          ))}
        </React.Fragment>
      ))}

      <div className="flex-1" />

      <div className="h-px bg-border mx-3 my-1" />
      <Item
        icon={Command}
        label="Command Palette"
        hint="Ctrl+K"
        onClick={() => setCommandPaletteOpen(true)}
      />
      <Item
        icon={Settings}
        label="Settings"
        active={activePanel === 'settings'}
        onClick={() => setActivePanel('settings')}
      />
      {/* Collapse lives at the foot of the rail — the one place it can sit
          without covering something else, and where the eye already goes for
          view controls. The floating counterpart only exists once the rail
          itself is gone and there is nothing left to click. */}
      <Item
        icon={PanelLeftClose}
        label="Hide side panel"
        hint="Ctrl+B"
        onClick={() => setLeftHidden(true)}
      />
    </div>
  );
}
