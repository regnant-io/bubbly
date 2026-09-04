import React from 'react';
import { useStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Eye, CheckCircle, AlertCircle, Clock, Loader2, SkipForward } from '../Shared/icons';

/**
 * What the agent is waiting for, and how long it has left.
 *
 * A watcher is the one piece of agent state with no visible trace anywhere else.
 * The agent starts a build, registers a wait, ends its turn — and from the
 * outside that is indistinguishable from the agent having simply stopped. People
 * assumed Bubbly had hung and pressed Stop, which cancelled the very wait that
 * was about to wake it up.
 *
 * So: every wait, what it is waiting on, how long it has been waiting, and when
 * it will give up. A DETACHED wait says plainly that the thread will start
 * itself again — because that is the part nobody can guess.
 */

function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const OUTCOME_STYLE: Record<string, { label: string; className: string; Icon: typeof CheckCircle }> = {
  met: { label: 'finished', className: 'text-green-agent', Icon: CheckCircle },
  failed: { label: 'failed', className: 'text-red-agent', Icon: AlertCircle },
  timeout: { label: 'gave up', className: 'text-amber-agent', Icon: Clock },
  cancelled: { label: 'cancelled', className: 'text-text-dim', Icon: Clock },
};

export function WatchersPanel() {
  const watchers = useStore((s) => s.watchers);
  const { sendSkipWatch } = useWebSocket();

  // The countdown has to tick locally: the server pushes on change and once a
  // minute, which would otherwise make "gives up in 4m" sit still for a minute
  // at a time and look frozen.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    if (!watchers.some((w) => !w.settled)) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [watchers]);

  const live = watchers.filter((w) => !w.settled);
  const settled = watchers.filter((w) => w.settled).slice(-8).reverse();

  if (watchers.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Eye size={18} className="text-text-dim/50" />
        <p className="text-sm text-text-dim">Nothing is being waited on.</p>
        <p className="text-[11px] text-text-dim/70 max-w-[240px] leading-relaxed">
          When the agent starts something slow — an install, a build, a test run — the wait it
          registers appears here with a countdown.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2 space-y-3">
      {live.length > 0 && (
        <section>
          <h3 className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
            Waiting — {live.length}
          </h3>
          <ul className="space-y-1.5">
            {live.map((w) => (
              <li key={w.id} className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <Loader2 size={12} className="animate-spin text-accent-bright mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text leading-snug break-words">{w.label}</p>
                    <p className="mt-0.5 text-[10px] text-text-dim tabular-nums">
                      {humanMs(w.ageMs)} elapsed · gives up in {humanMs(w.remainingMs)}
                      <span className="text-text-dim/60"> · {w.kind.replace(/_/g, ' ')}</span>
                    </p>
                    {w.detached && (
                      <p className="mt-1 text-[10px] text-accent-bright/90 leading-snug">
                        Running in the background — this thread starts itself again when it settles.
                      </p>
                    )}
                  </div>
                  {/*
                    SKIP, NOT STOP.
                    A watcher's deadline is set hours out on purpose: guessing
                    how long a real build takes is what made the old five-minute
                    ceiling report healthy work as a failure. That is right for
                    the agent and useless for the person watching, who can
                    plainly see the thing is never going to happen and whose only
                    lever was Stop — which kills the whole turn. Skipping settles
                    just this wait and tells the agent a human made that call, so
                    it moves on rather than reading it as a failure.
                  */}
                  <button
                    onClick={() => sendSkipWatch(w.id)}
                    title="Stop waiting for this and let the agent carry on"
                    aria-label={`Skip waiting for ${w.label}`}
                    className="shrink-0 flex items-center gap-1 rounded-md border border-border px-1.5 py-1
                               text-[10px] text-text-dim hover:text-text hover:border-accent/50 hover:bg-surface-3
                               transition-colors"
                  >
                    <SkipForward size={10} />
                    Skip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section>
          <h3 className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
            Finished
          </h3>
          <ul className="space-y-1">
            {settled.map((w) => {
              const style = OUTCOME_STYLE[w.outcome ?? 'cancelled'] ?? OUTCOME_STYLE.cancelled;
              const Icon = style.Icon;
              return (
                <li key={w.id} className="flex items-start gap-2 px-1 py-1">
                  <Icon size={11} className={`${style.className} mt-0.5 shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-text-muted leading-snug break-words">{w.label}</p>
                    <p className="text-[10px] text-text-dim tabular-nums">
                      {style.label} after {humanMs(w.ageMs)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
