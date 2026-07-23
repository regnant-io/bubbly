import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store';

/** Compact token count: 58.9K, 1.2M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Where the model's window is described in plain terms. */
function sourceLabel(source: string): string {
  switch (source) {
    case 'resolved': return 'reported by the model';
    case 'configured': return 'from your num_ctx setting';
    case 'known': return 'known for this model';
    default: return source;
  }
}

/**
 * Context gauge — a filling ring showing how much of the model's context window
 * the conversation currently occupies.
 *
 * This replaces the static "Enter to send" hint, which taught the user something
 * once and then occupied the corner forever. Context pressure is the opposite:
 * it changes constantly, it decides when a thread gets summarized and migrated,
 * and until now it was invisible — a conversation would suddenly compact itself
 * with no warning. The ring turns amber as the migration threshold approaches so
 * that moment stops being a surprise.
 *
 * Clicking opens the detail: exact tokens, the window, the model it belongs to,
 * and where that window figure came from (a model-reported window and a guessed
 * one are very different levels of confidence).
 */
export function ContextGauge() {
  const usage = useStore((s) => s.contextUsage);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on outside click / Escape, like every other transient popover.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to show until the agent has run at least once this session.
  if (!usage || usage.usableTokens <= 0) return null;

  const ratio = Math.min(usage.usedTokens / usage.usableTokens, 1);
  const pct = Math.round(ratio * 100);
  // 85% is the migration threshold — the point where the thread summarizes and
  // moves. Amber before it, red at it, so the colour means something specific.
  const tone = ratio >= 0.85 ? 'text-red-agent' : ratio >= 0.6 ? 'text-amber-agent' : 'text-accent-bright';

  const R = 7;
  const C = 2 * Math.PI * R;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Context: ${pct}% of ${fmtTokens(usage.usableTokens)} usable tokens`}
        aria-label={`Context usage ${pct} percent`}
        className="flex items-center gap-1.5 px-1.5 py-1 rounded-full hover:bg-surface-2 transition-colors group"
      >
        <span className="relative flex items-center justify-center">
          <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
            <circle cx="9" cy="9" r={R} fill="none" strokeWidth="2" className="stroke-surface-3" />
            <motion.circle
              cx="9" cy="9" r={R} fill="none" strokeWidth="2" strokeLinecap="round"
              className={`${tone} stroke-current`}
              strokeDasharray={C}
              initial={false}
              animate={{ strokeDashoffset: C * (1 - ratio) }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
          </svg>
        </span>
        <span className={`text-[10px] tabular-nums ${ratio >= 0.85 ? 'text-red-agent' : 'text-text-dim'} group-hover:text-text-muted transition-colors`}>
          {pct}%
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="absolute bottom-full right-0 mb-2 w-64 z-50 rounded-xl border border-border-bright bg-surface-1 shadow-2xl p-3"
          >
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs font-semibold text-text">Context window</span>
              <span className={`text-xs tabular-nums font-medium ${tone}`}>{pct}%</span>
            </div>

            <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden mb-2">
              <motion.div
                className={`h-full rounded-full ${ratio >= 0.85 ? 'bg-red-agent' : ratio >= 0.6 ? 'bg-amber-agent' : 'bg-accent'}`}
                initial={false}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>

            <dl className="space-y-1 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="text-text-dim">Used</dt>
                <dd className="text-text-muted tabular-nums">{usage.usedTokens.toLocaleString()} tokens</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-text-dim">Usable</dt>
                <dd className="text-text-muted tabular-nums">{usage.usableTokens.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-text-dim">Window</dt>
                <dd className="text-text-muted tabular-nums">{usage.windowTokens.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-2 min-w-0">
                <dt className="text-text-dim shrink-0">Model</dt>
                <dd className="text-text-muted truncate" title={usage.model}>{usage.model}</dd>
              </div>
            </dl>

            <p className="mt-2 pt-2 border-t border-border text-[10px] text-text-dim leading-snug">
              {ratio >= 0.85
                ? 'At this level Bubbly summarizes the thread and continues in a fresh one, so nothing is lost but older detail gets condensed.'
                : `Window ${sourceLabel(usage.source)}. Older turns are condensed automatically near 85%.`}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
