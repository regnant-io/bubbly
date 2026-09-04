import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, type RightContextId } from '../../store';
import { RIGHT_PANEL_META } from '../BubbleRoom/RightPanel';
import { MoreVertical } from '../Shared/icons';

/**
 * The panel menu.
 *
 * TWO THINGS IT HAS TO GET RIGHT
 *
 * 1. IT MUST SHOW WHERE SOMETHING IS HAPPENING. A closed panel is invisible, so
 *    an agent that started a dev server, opened three files and hit an error in
 *    the terminal produces no signal at all if those panels are shut. The whole
 *    value of a menu over hidden state is telling you what is behind each door.
 *
 *    "Activity" and "a count" are different, and both matter. Changes has a
 *    count (4 files) because the number is the information; the terminal has a
 *    PULSE because "something is running" is the information and "1" is not.
 *
 * 2. IT MUST BE FAST TO USE. Every item takes a number, and the number opens it.
 *    A menu you navigate with the mouse is a menu you stop opening.
 */

const GROUPS: Array<{ name: string; ids: RightContextId[] }> = [
  { name: 'Run', ids: ['preview', 'terminal', 'background', 'watchers'] },
  { name: 'Work', ids: ['diff', 'file-preview', 'tasks', 'plans', 'artifacts'] },
  { name: 'Reference', ids: ['spec', 'audit'] },
];

interface Signal {
  /** A number worth showing. Zero means no badge. */
  count: number;
  /** Something is happening right now — rendered as a pulse, not a number. */
  live: boolean;
  /** Something went wrong in there. */
  attention: boolean;
}

export function PanelDropdownMenu() {
  const [isOpen, setIsOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const rightStack = useStore((s) => s.rightStack);
  const toggleRightContext = useStore((s) => s.toggleRightContext);
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  const artifacts = useStore((s) => s.artifacts);
  const plans = useStore((s) => s.plans);
  const terminals = useStore((s) => s.terminals);
  const watchers = useStore((s) => s.watchers);
  const specs = useStore((s) => s.specs);
  const filePreview = useStore((s) => s.filePreview);
  const previewUrl = useStore((s) => s.previewUrl);
  const lastValidation = useStore((s) => s.lastValidation);
  const taskProgress = useStore((s) => s.taskProgress);
  const agentPlan = useStore((s) => s.agentPlan);

  /**
   * What each panel has to say for itself.
   *
   * Computed together so the button's summary and the menu's rows can never
   * disagree — a dot on the button with nothing behind it is worse than no dot.
   */
  const signals = React.useMemo((): Record<string, Signal> => {
    const liveTerminals = terminals.filter((t) => t.alive);
    const awaitingInput = terminals.some((t) => t.awaitingInput);
    const liveWatchers = watchers.filter((w) => !w.settled);
    const failedWatchers = watchers.filter((w) => w.settled && (w.outcome === 'failed' || w.outcome === 'timeout'));
    const runningTasks = Object.values(taskProgress).filter((t) => t.phase !== 'done');
    const errors = lastValidation.filter((v) => v.severity === 'error');

    return {
      preview: { count: 0, live: !!previewUrl, attention: false },
      terminal: { count: liveTerminals.length, live: liveTerminals.length > 0, attention: awaitingInput },
      background: { count: 0, live: false, attention: false },
      watchers: { count: liveWatchers.length, live: liveWatchers.length > 0, attention: failedWatchers.length > 0 },
      diff: { count: pendingDiffs.length, live: false, attention: false },
      'file-preview': { count: 0, live: !!filePreview, attention: !!filePreview?.error },
      tasks: { count: runningTasks.length, live: runningTasks.length > 0, attention: false },
      plans: { count: plans.length, live: agentPlan.some((s) => s.status === 'in_progress'), attention: agentPlan.some((s) => s.status === 'blocked') },
      artifacts: { count: artifacts.length, live: false, attention: false },
      spec: { count: specs.length, live: false, attention: false },
      audit: { count: 0, live: false, attention: errors.length > 0 },
    };
  }, [
    terminals, watchers, pendingDiffs.length, artifacts.length, plans.length,
    specs.length, filePreview, previewUrl, lastValidation, taskProgress, agentPlan,
  ]);

  /** Flat, numbered list in the order the menu renders — 1..9 map to these. */
  const numbered = React.useMemo(
    () => GROUPS.flatMap((g) => g.ids).filter((id) => RIGHT_PANEL_META[id]),
    [],
  );

  const summary = React.useMemo(() => {
    let count = 0;
    let live = false;
    let attention = false;
    for (const s of Object.values(signals)) {
      count += s.count;
      live = live || s.live;
      attention = attention || s.attention;
    }
    return { count, live, attention };
  }, [signals]);

  React.useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  /**
   * Number shortcuts.
   *
   * Bound only while the menu is OPEN. A global 1–9 binding would steal digits
   * from every other part of the app, and a shortcut that fires when you did not
   * mean it is worse than no shortcut.
   */
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsOpen(false); return; }

      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!/^[1-9]$/.test(e.key)) return;

      const id = numbered[Number(e.key) - 1];
      if (!id) return;
      e.preventDefault();
      toggleRightContext(id);
      setIsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, numbered, toggleRightContext]);

  const openCount = rightStack.length;
  let index = 0;

  return (
    <div ref={dropdownRef} className="relative">
      <motion.button
        whileTap={{ scale: 0.94 }}
        onClick={() => setIsOpen((v) => !v)}
        className={`relative p-2 rounded-lg transition-colors ${
          isOpen || openCount > 0
            ? 'bg-accent/20 text-accent-bright'
            : 'text-text-dim hover:text-text hover:bg-surface-3'
        }`}
        title={
          summary.attention ? 'Panels — something needs attention'
          : summary.live ? 'Panels — something is running'
          : 'Panels'
        }
        aria-label="Panels"
        aria-expanded={isOpen}
      >
        <MoreVertical size={16} />

        {/*
          One indicator, chosen by importance rather than three stacked on top of
          each other. Attention beats a count beats a pulse: if something is
          wrong, that is the only thing worth drawing.
        */}
        {summary.attention ? (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-agent ring-2 ring-surface-1" />
        ) : summary.count > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 rounded-full bg-accent text-surface-1 text-[9px] font-bold flex items-center justify-center tabular-nums shadow-sm">
            {summary.count > 99 ? '99+' : summary.count}
          </span>
        ) : summary.live ? (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent animate-pulse" />
        ) : null}
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute top-full right-0 mt-2 w-72 card bg-surface-1 shadow-2xl overflow-hidden z-50"
          >
            <div className="py-1">
              {GROUPS.map((group, gi) => (
                <React.Fragment key={group.name}>
                  {gi > 0 && <div className="h-px bg-border my-1" />}
                  <div className="px-3 py-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-dim">
                      {group.name}
                    </span>
                  </div>

                  {group.ids.map((id) => {
                    const meta = RIGHT_PANEL_META[id];
                    if (!meta) return null;
                    const Icon = meta.icon;
                    const open = rightStack.includes(id);
                    const signal = signals[id] ?? { count: 0, live: false, attention: false };
                    index += 1;
                    const shortcut = index <= 9 ? index : null;

                    return (
                      <button
                        key={id}
                        onClick={() => { toggleRightContext(id); setIsOpen(false); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 transition-colors ${
                          open ? 'bg-accent/10 text-accent-bright' : 'text-text hover:bg-surface-3'
                        }`}
                      >
                        <span className="relative shrink-0">
                          <Icon size={14} />
                          {/* The pulse sits on the ICON, so it reads as "this
                              thing is active" rather than as a generic badge. */}
                          {signal.live && !signal.attention && (
                            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                          )}
                          {signal.attention && (
                            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-agent" />
                          )}
                        </span>

                        <span className="flex-1 text-left text-[13px]">{meta.label}</span>

                        {signal.count > 0 && (
                          <span
                            className={`min-w-[17px] h-[17px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center tabular-nums ${
                              signal.attention
                                ? 'bg-red-agent/15 text-red-agent'
                                : open
                                ? 'bg-accent/25 text-accent-bright'
                                : 'bg-surface-3 text-text-muted'
                            }`}
                          >
                            {signal.count > 99 ? '99+' : signal.count}
                          </span>
                        )}

                        {shortcut && (
                          <kbd className="shrink-0 text-[9px] font-mono text-text-dim/70 border border-border rounded px-1 py-px">
                            {shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>

            <div className="border-t border-border px-3 py-1.5">
              <span className="text-[10px] text-text-dim">
                Press 1–9 to open · Esc to close
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
