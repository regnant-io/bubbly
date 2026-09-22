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
    { id: 'vibe', label: 'Agent', icon: <Sparkles size={13} /> },
    { id: 'editor', label: 'Editor', icon: <FileCode size={13} /> },
  ];

  return (
    <div className="mode-tabs" role="group" aria-label="Layout" style={NO_DRAG}>
      {tabs.map((t) => {
        const active = uiMode === t.id;
        const switching = modeSwitching && active;
        return (
          <button
            key={t.id}
            onClick={() => setUiMode(t.id)}
            disabled={modeSwitching}
            aria-pressed={active}
            className={`mode-tab ${modeSwitching ? 'cursor-wait' : ''}`}
            title={t.id === 'vibe' ? 'Agent: conversation-first layout' : 'IDE layout: editor with AI on the right'}
          >
            {switching ? <Loader2 size={12} className="animate-spin" /> : t.icon}
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
