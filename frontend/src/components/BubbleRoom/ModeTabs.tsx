import React from 'react';
import { useStore } from '../../store';
import { Sparkles, FileCode, Loader2 } from '../Shared/icons';

/**
 * Top-left segmented control to switch the whole workspace between:
 *   - Vibe   — the conversational, chat-centric layout (default)
 *   - Editor — an IDE-centric layout: file tree + code editor in the middle,
 *              the AI assistant docked on the right.
 *
 * Switching shows a brief loading state (store.modeSwitching) so the layout
 * transition reads as deliberate rather than a jarring instant swap.
 */
const NO_DRAG = { ['WebkitAppRegion' as any]: 'no-drag' };

export function ModeTabs() {
  const { uiMode, setUiMode, modeSwitching } = useStore();

  const tabs: Array<{ id: 'vibe' | 'editor'; label: string; icon: React.ReactNode }> = [
    { id: 'vibe', label: 'Agents', icon: <Sparkles size={12} /> },
    { id: 'editor', label: 'Editor', icon: <FileCode size={12} /> },
  ];

  return (
    <div className="flex items-center gap-0.5 h-7 box-border p-0.5 rounded-lg bg-surface-2 border border-border shrink-0" style={NO_DRAG}>
      {tabs.map((t) => {
        const active = uiMode === t.id;
        const switching = modeSwitching && active;
        return (
          <button
            key={t.id}
            onClick={() => setUiMode(t.id)}
            disabled={modeSwitching}
            className={`flex items-center gap-1.5 px-2.5 h-full rounded-md text-[11px] font-medium transition-colors ${
              active ? 'bg-accent/20 text-accent-bright' : 'text-text-dim hover:text-text hover:bg-surface-3'
            } ${modeSwitching ? 'cursor-wait' : ''}`}
            title={t.id === 'vibe' ? 'Agents — conversational layout' : 'IDE layout — editor with AI on the right'}
          >
            {switching ? <Loader2 size={12} className="animate-spin" /> : t.icon}
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
