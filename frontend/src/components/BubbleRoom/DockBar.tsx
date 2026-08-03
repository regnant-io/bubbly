import React from 'react';
import { motion } from 'framer-motion';
import { useStore, type RightContextId } from '../../store';
import { RIGHT_PANEL_META } from './RightPanel';

/**
 * The dock, grouped by what each panel is FOR.
 *
 * These launchers used to be a flat row crammed into the right-hand end of the
 * status pill, next to the model name and the cursor position. Two problems
 * with that: a status bar reports, it doesn't take commands, so the most-used
 * controls in the app sat in the least likely place to look for them; and nine
 * equal-weight icons in a line have no structure, so finding "Background" meant
 * reading all of them every time.
 *
 * Three groups, separated by a hairline, in the order the work happens: what's
 * RUNNING, what the agent PRODUCED, and what you consult for REFERENCE. The
 * status pill goes back to reporting status.
 */
const GROUPS: Array<{ name: string; ids: RightContextId[] }> = [
  { name: 'Run', ids: ['preview', 'terminal', 'background'] },
  { name: 'Work', ids: ['diff', 'tasks', 'plans', 'artifacts'] },
  { name: 'Reference', ids: ['spec', 'audit'] },
];

export function DockBar() {
  const rightStack = useStore((s) => s.rightStack);
  const toggleRightContext = useStore((s) => s.toggleRightContext);
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  const artifacts = useStore((s) => s.artifacts);
  const plans = useStore((s) => s.plans);
  const terminals = useStore((s) => s.terminals);

  /** Counts that make a closed panel worth opening. Zero shows nothing. */
  const badgeFor = (id: RightContextId): number => {
    switch (id) {
      case 'diff': return pendingDiffs.length;
      case 'artifacts': return artifacts.length;
      case 'plans': return plans.length;
      case 'terminal': return terminals.filter((t) => t.alive).length;
      default: return 0;
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 h-9 overflow-x-auto">
      {GROUPS.map((group, gi) => (
        <React.Fragment key={group.name}>
          {gi > 0 && <div className="w-px h-4 bg-border mx-1.5 shrink-0" />}
          {group.ids.map((id) => {
            const meta = RIGHT_PANEL_META[id];
            if (!meta) return null;
            const Icon = meta.icon;
            const open = rightStack.includes(id);
            const badge = badgeFor(id);
            return (
              <motion.button
                key={id}
                whileTap={{ scale: 0.94 }}
                onClick={() => toggleRightContext(id)}
                title={`${open ? 'Close' : 'Open'} ${meta.label} · ${group.name}`}
                aria-pressed={open}
                className={`relative flex items-center gap-1.5 px-2 h-6.5 py-1 rounded-lg shrink-0 transition-colors ${
                  open
                    ? 'bg-accent/20 text-accent-bright'
                    : 'text-text-dim hover:text-text hover:bg-surface-3'
                }`}
              >
                <Icon size={13} />
                <span className="hidden md:inline text-[11px] font-medium whitespace-nowrap">{meta.label}</span>
                {badge > 0 && (
                  <span
                    className={`min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center ${
                      open ? 'bg-accent/30 text-accent-bright' : 'bg-surface-3 text-text-muted'
                    }`}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </motion.button>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
