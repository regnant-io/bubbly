import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Zap, ClipboardList, ChevronDown, Check, Code2, MessageSquare, Sparkles } from '../Shared/icons';
import type { ThreadType } from '../../types';

interface ModeOption {
  id: ThreadType;
  label: string;
  blurb: string;
  icon: React.ReactNode;
  description?: string;
  badge?: string;
}

const OPTIONS: ModeOption[] = [
  { 
    id: 'vibe_coding', 
    label: 'Vibe', 
    blurb: 'Fast & conversational', 
    icon: <Zap size={13} className="text-accent-bright" />,
    description: 'Quick iterations, minimal ceremony. Best for exploration and rapid prototyping.',
  },
  { 
    id: 'spec_session', 
    label: 'Spec', 
    blurb: 'Structured & thorough', 
    icon: <ClipboardList size={13} className="text-accent-bright" />,
    description: 'Formal requirements → design → implementation workflow with task tracking.',
  },
];

// Additional mode suggestions that could be shown in expanded view
const SUGGESTED_MODES: Array<{ label: string; description: string; icon: React.ReactNode }> = [
  {
    label: 'Code Review',
    description: 'Deep analysis of code quality, patterns, and potential issues',
    icon: <Code2 size={13} className="text-blue-400" />,
  },
  {
    label: 'Debug Session',
    description: 'Systematic bug investigation with hypothesis testing',
    icon: <Sparkles size={13} className="text-purple-400" />,
  },
  {
    label: 'Pairing',
    description: 'Collaborative development with shared decision-making',
    icon: <MessageSquare size={13} className="text-green-400" />,
  },
];

/**
 * Expanded mode picker for the chat input toolbar — lets the user choose
 * vibe/spec mode for a NEW session with detailed descriptions and suggestions.
 * Once a session has actual messages, the mode is locked (shown, not editable),
 * since switching mid-conversation doesn't mean anything.
 */
export function ThreadTypeSelector() {
  const { currentThreadType, setCurrentThreadType, currentSessionId, messages } = useStore();
  const [open, setOpen] = useState(false);
  const [showExpanded, setShowExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const locked = !!currentSessionId || messages.filter((m) => m.type !== 'status').length > 0;
  const active = OPTIONS.find((o) => o.id === currentThreadType) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowExpanded(false);
      }
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
        <div className={`absolute bottom-full mb-2 left-0 z-50 rounded-xl border border-border-bright bg-surface-1 shadow-2xl transition-all ${
          showExpanded ? 'w-96' : 'w-64'
        }`}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">Session Mode</span>
            <button
              onClick={() => setShowExpanded(!showExpanded)}
              className="text-[10px] text-accent-bright hover:underline"
            >
              {showExpanded ? 'Show less' : 'Show more'}
            </button>
          </div>

          {/* Active modes */}
          <div className="py-1">
            {OPTIONS.map((o) => {
              const isActive = currentThreadType === o.id;
              return (
                <button
                  key={o.id}
                  onClick={() => { setCurrentThreadType(o.id); setOpen(false); setShowExpanded(false); }}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface-3 transition-colors ${
                    isActive ? 'bg-accent/10 border-l-2 border-accent' : 'border-l-2 border-transparent'
                  }`}
                >
                  <span className="mt-0.5">{o.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${isActive ? 'text-accent-bright' : 'text-text'}`}>
                        {o.label}
                      </span>
                      {isActive && <Check size={12} className="text-accent-bright shrink-0" />}
                    </div>
                    <span className="block text-[11px] text-text-dim mt-0.5">{o.blurb}</span>
                    {showExpanded && o.description && (
                      <p className="text-[10px] text-text-dim/80 mt-1.5 leading-relaxed">
                        {o.description}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Suggested modes (expanded view only) */}
          {showExpanded && (
            <>
              <div className="border-t border-border px-3 py-1.5 bg-surface-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">Coming Soon</span>
              </div>
              <div className="py-1 pb-2">
                {SUGGESTED_MODES.map((mode, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2.5 px-3 py-2 opacity-50 cursor-not-allowed"
                  >
                    <span className="mt-0.5">{mode.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text">{mode.label}</div>
                      <p className="text-[10px] text-text-dim mt-0.5 leading-relaxed">
                        {mode.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Footer tip */}
          <div className="border-t border-border px-3 py-2 bg-surface-2/50">
            <p className="text-[10px] text-text-dim leading-relaxed">
              💡 Mode is locked once the conversation starts
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
