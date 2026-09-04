import React from 'react';
import { useStore } from '../../store';
import { RefreshCw, Square } from '../Shared/icons';

/**
 * The state of a running loop, above the composer.
 *
 * A loop is indistinguishable from a very long ordinary run unless something
 * says otherwise — and that ambiguity is genuinely unsettling when the agent
 * has been working for twenty minutes. Three facts remove it: what it is
 * working towards, which round it is on, and how much budget is left. The last
 * one matters most, because it is the answer to "is this ever going to stop".
 */
export function LoopBanner({ onStop }: { onStop: () => void }) {
  const loop = useStore((s) => s.activeLoop);

  // The remaining budget is pushed once per round, which on a long round means
  // a number that sits still for minutes and looks frozen. Counting down
  // locally between pushes keeps it honest without a chattier protocol.
  const [drift, setDrift] = React.useState(0);
  React.useEffect(() => {
    setDrift(0);
    if (!loop) return;
    const t = setInterval(() => setDrift((d) => d + 1), 60_000);
    return () => clearInterval(t);
  }, [loop?.iteration, loop?.loopId]);

  if (!loop) return null;

  const remaining = Math.max(0, loop.remainingMinutes - drift);
  const progress = loop.maxIterations > 0
    ? Math.min(loop.iteration / loop.maxIterations, 1)
    : 0;

  return (
    <div className="mb-2 rounded-xl border border-accent/30 bg-accent/8 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <RefreshCw size={13} className="shrink-0 text-accent-bright animate-spin" style={{ animationDuration: '3s' }} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium text-accent-bright shrink-0">
              Round {loop.iteration || 1} of {loop.maxIterations}
            </span>
            <span className="text-[11px] text-text-muted truncate">{loop.goal}</span>
          </div>
          <div className="text-[10px] text-text-dim tabular-nums">
            {remaining > 0
              ? `about ${remaining} minute${remaining === 1 ? '' : 's'} of budget left`
              : 'budget spent — finishing this round'}
          </div>
        </div>

        <button
          onClick={onStop}
          className="shrink-0 flex items-center gap-1 rounded-lg border border-border px-2 py-1
                     text-[10px] text-text-muted hover:text-text hover:border-border-bright transition-colors"
          title="Stop the loop after this round"
        >
          <Square size={9} />
          Stop
        </button>
      </div>

      {/* Progress is by ROUND, not by time: rounds are the unit the user chose. */}
      <div className="h-0.5 bg-hairline/25">
        <div
          className="h-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  );
}
