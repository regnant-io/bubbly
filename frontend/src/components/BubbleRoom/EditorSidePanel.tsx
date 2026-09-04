import React from 'react';
import { useStore, type RightContextId } from '../../store';
import { RIGHT_PANEL_META } from './RightPanel';
import { ChatPanel } from '../Chat/ChatPanel';
import { MessageSquare, X } from '../Shared/icons';

/**
 * The right-hand region in Editor mode: chat and context panels, as TABS.
 *
 * THE PROBLEM THIS REPLACES
 *
 * Editor mode used to lay out four columns side by side — file tree, editor,
 * a column for the context panels, and a column for the chat. On a 1440px
 * screen, with the tree at 240 and two right columns at 380 and 420, the editor
 * is left with about 380px: roughly forty characters of code. Open a second
 * context panel and it is unusable. The panels themselves were no better off,
 * each squeezed into a third of the height of a narrow column.
 *
 * The mistake was treating "chat" and "context panels" as two regions that must
 * both be visible. In practice you are reading ONE of them at a time — you are
 * either talking to the agent or looking at the diff — and the editor is what
 * you want the space for either way.
 *
 * So they share one region and one width, selected by a tab strip. The editor
 * keeps its width no matter how many panels are open, opening a panel never
 * shrinks anything, and each panel gets the full height of the column instead of
 * a quarter of it.
 *
 * (Vibe mode is unchanged: there is no editor competing for width, so the
 * stacked panels of RightPanel are the right shape there.)
 */
export function EditorSidePanel() {
  const rightStack = useStore((s) => s.rightStack);
  const closeRightContext = useStore((s) => s.closeRightContext);
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  const watchers = useStore((s) => s.watchers);
  const isRunning = useStore((s) => s.isRunning);

  const [active, setActive] = React.useState<'chat' | RightContextId>('chat');

  /*
   * Opening a panel selects it.
   *
   * Anything else makes the launcher feel broken: you click "Changes" in the
   * menu, the tab appears, and you are still looking at the chat. Tracked by
   * comparing against the previous stack so that CLOSING a panel does not also
   * count as an open.
   */
  const previousStack = React.useRef<RightContextId[]>(rightStack);
  React.useEffect(() => {
    const opened = rightStack.find((id) => !previousStack.current.includes(id));
    if (opened) setActive(opened);
    // The active tab was just closed — fall back to chat rather than to a blank
    // region.
    if (active !== 'chat' && !rightStack.includes(active)) setActive('chat');
    previousStack.current = rightStack;
  }, [rightStack, active]);

  const badgeFor = (id: RightContextId): number | null => {
    if (id === 'diff') return pendingDiffs.length || null;
    if (id === 'watchers') return watchers.filter((w) => !w.settled).length || null;
    return null;
  };

  const tabs: Array<{ id: 'chat' | RightContextId; label: string; icon: typeof MessageSquare; badge: number | null; closable: boolean }> = [
    { id: 'chat', label: 'Chat', icon: MessageSquare, badge: null, closable: false },
    ...rightStack
      .filter((id) => RIGHT_PANEL_META[id])
      .map((id) => ({
        id,
        label: RIGHT_PANEL_META[id].label,
        icon: RIGHT_PANEL_META[id].icon,
        badge: badgeFor(id),
        closable: true,
      })),
  ];

  return (
    <div className="h-full flex flex-col card bg-surface-1 overflow-hidden">
      {/* The tab strip only earns its height once there is a choice to make. */}
      {tabs.length > 1 && (
        <div className="flex items-stretch border-b border-border overflow-x-auto shrink-0">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = active === tab.id;
            return (
              <div
                key={tab.id}
                className={`group relative flex items-center ${
                  selected ? 'bg-surface-1' : 'bg-surface-2/50 hover:bg-surface-2'
                }`}
              >
                <button
                  onClick={() => setActive(tab.id)}
                  className={`flex items-center gap-1.5 px-3 h-8 text-[11px] whitespace-nowrap transition-colors ${
                    selected ? 'text-accent-bright' : 'text-text-dim hover:text-text'
                  }`}
                >
                  <span className="relative">
                    <Icon size={12} />
                    {tab.id === 'chat' && isRunning && !selected && (
                      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    )}
                  </span>
                  {tab.label}
                  {tab.badge !== null && (
                    <span className="min-w-[14px] h-[14px] px-1 rounded-full bg-accent/20 text-accent-bright text-[9px] font-bold flex items-center justify-center tabular-nums">
                      {tab.badge}
                    </span>
                  )}
                </button>

                {tab.closable && (
                  <button
                    onClick={() => closeRightContext(tab.id as RightContextId)}
                    className="pr-2 text-text-dim/60 hover:text-red-agent opacity-0 group-hover:opacity-100 transition-opacity"
                    title={`Close ${tab.label}`}
                    aria-label={`Close ${tab.label}`}
                  >
                    <X size={10} />
                  </button>
                )}

                {selected && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
              </div>
            );
          })}
        </div>
      )}

      {/*
        Every tab stays MOUNTED and is hidden with CSS rather than unmounted.
        A terminal that unmounts loses its buffer, a preview reloads its page,
        and a chat scrolled to the middle of a long thread jumps back to the
        bottom — all for switching tab and switching back.
      */}
      <div className="flex-1 min-h-0 relative">
        <div className={`absolute inset-0 ${active === 'chat' ? '' : 'invisible pointer-events-none'}`}>
          <ChatPanel />
        </div>

        {rightStack.filter((id) => RIGHT_PANEL_META[id]).map((id) => (
          <div
            key={id}
            className={`absolute inset-0 ${active === id ? '' : 'invisible pointer-events-none'}`}
          >
            {RIGHT_PANEL_META[id].render()}
          </div>
        ))}
      </div>
    </div>
  );
}
