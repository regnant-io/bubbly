import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Zap, ClipboardList, ChevronDown, Check } from '../Shared/icons';
import type { ThreadType } from '../../types';

const OPTIONS: Array<{ id: ThreadType; label: string; blurb: string; icon: React.ReactNode }> = [
  { id: 'vibe_coding', label: 'Vibe', blurb: 'Fast & conversational', icon: <Zap size={13} className="text-accent-bright" /> },
  { id: 'spec_session', label: 'Spec', blurb: 'Structured & thorough', icon: <ClipboardList size={13} className="text-accent-bright" /> },
];

/**
 * Compact mode picker for the chat input toolbar — lets the user choose
 * vibe/spec mode for a NEW session without a blocking full-screen picker.
 * Once a session has actual messages, the mode is locked (shown, not editable),
 * since switching mid-conversation doesn't mean anything.
 */
export function ThreadTypeSelector() {
  const { currentThreadType, setCurrentThreadType, currentSessionId, messages } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const locked = !!currentSessionId || messages.filter((m) => m.type !== 'status').length > 0;
  const active = OPTIONS.find((o) => o.id === currentThreadType) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !locked && setOpen((v) => !v)}
        disabled={locked}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-text-dim hover:text-text hover:bg-surface-3 transition-colors disabled:hover:bg-transparent disabled:opacity-70"
        title={locked ? `${active.label} mode (locked for this conversation)` : 'Choose vibe/spec mode for a new conversation'}
      >
        {active.icon}
        <span className="truncate">{active.label}</span>
        {!locked && <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>

      {open && !locked && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-56 rounded-xl border border-border bg-surface-1 shadow-xl py-1">
          <div className="px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">Mode</span>
          </div>
          {OPTIONS.map((o) => {
            const isActive = currentThreadType === o.id;
            return (
              <button
                key={o.id}
                onClick={() => { setCurrentThreadType(o.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-3 transition-colors ${
                  isActive ? 'text-accent-bright' : 'text-text-muted'
                }`}
              >
                {o.icon}
                <span className="flex-1">
                  <span className="block">{o.label}</span>
                  <span className="block text-[10px] text-text-dim">{o.blurb}</span>
                </span>
                {isActive && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
