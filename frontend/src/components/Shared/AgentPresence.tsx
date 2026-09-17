import React from 'react';
import { useStore } from '../../store';
import { BubblyMark } from './BubblyMark';

/**
 * How long a run has to go on before the UI starts admitting it is long.
 *
 * Three bands, because a wait has three quite different meanings and pretending
 * otherwise is what makes waiting feel bad:
 *
 *   under 25s   ordinary. Say what is happening and nothing else.
 *   25s–2min    long, but normal for an agent. Offer the elapsed time, so the
 *               user can calibrate rather than guess.
 *   over 2min   worth reassuring about. Say plainly that it is still going and
 *               that stopping is available — the fear at three minutes is not
 *               "this is slow", it is "has this hung, and am I stuck?".
 */
const LONG_MS = 25_000;
const VERY_LONG_MS = 120_000;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * THE AGENT IS WORKING AND HAS NOT SAID ANYTHING YET.
 *
 * The transcript is very good at showing work that has PRODUCED something —
 * prose streams, tool steps group themselves under phase headings, diffs land
 * in Changes. The hole it had was the gap: the model has been handed the
 * conversation and is thinking, nothing has come back, and the last thing on
 * screen is whatever finished a moment ago. In that gap the app looked idle,
 * which during a long turn is indistinguishable from broken.
 *
 * WHAT THIS SAYS, IN ORDER OF HOW MUCH IT IS TRUSTED
 *
 *   1. What the agent itself said it is doing (`set_phase`, or a plan step
 *      going in progress). This is the real answer and it is used whenever it
 *      exists — no invented verb can beat "Working out why the tests fail".
 *   2. Failing that, one honest generic: "Thinking". Not a rotating carousel of
 *      synonyms. A label that changes every few seconds implies the underlying
 *      state changed, and when it did not, the user learns to ignore the line —
 *      which costs you the one moment it does carry news.
 *
 * WHAT IT REFUSES TO DO
 *
 * No percentage, no ETA, no determinate bar. Nothing here knows how long a
 * model turn will take, and a progress bar that is wrong is worse than no bar:
 * it is a promise the app cannot keep, and the user remembers the broken
 * promise long after they have forgotten the wait.
 *
 * MOVEMENT BUDGET: exactly one thing moves per state. The mark breathes; the
 * sentence takes a sheen only while there is no phase label to read; the rail
 * only exists once the wait is long enough to be worth a rail. Two competing
 * animations read as "busy", which is precisely the feeling to avoid in the
 * moment the user is already waiting.
 */
export function AgentPresence() {
  const isRunning = useStore((s) => s.isRunning);
  const runStartedAt = useStore((s) => s.runStartedAt);
  const currentPhase = useStore((s) => s.currentPhase);

  // One tick a second is enough for a seconds-resolution readout, and is two
  // orders of magnitude cheaper than the animation frame budget it replaces.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  if (!isRunning) return null;

  const elapsed = runStartedAt ? now - runStartedAt : 0;
  const isLong = elapsed >= LONG_MS;
  const isVeryLong = elapsed >= VERY_LONG_MS;

  const label = currentPhase?.label ?? 'Thinking';
  const detail = currentPhase?.detail;
  // The sheen is the substitute for having something to say. Once the agent has
  // named its phase, the words carry the information and the effect would just
  // be decoration on top of content.
  const useSheen = !currentPhase;

  return (
    <div
      className="motion-rise flex items-start gap-2.5 px-1 py-2"
      role="status"
      aria-live="polite"
      aria-label={`${label}${isLong ? `, ${formatElapsed(elapsed)} elapsed` : ''}`}
    >
      {/* The mark, with a halo pulsing out of it. Same object as the boot
          screen's and the title bar's, so "Bubbly is doing something" always
          looks like Bubbly. */}
      <span className="relative shrink-0 mt-px flex h-4 w-4 items-center justify-center">
        <span className="motion-halo absolute inset-0 rounded-full bg-accent/25" aria-hidden="true" />
        <BubblyMark size={14} animation="breathe" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={`text-[13px] leading-snug text-text-muted ${useSheen ? 'sheen-text' : ''}`}
          >
            {label}
          </span>

          {detail && (
            <span className="text-[12px] text-text-dim truncate max-w-[38ch]" title={detail}>
              {detail}
            </span>
          )}

          {/* The clock appears only once the wait is long enough for a number to
              be information rather than pressure. Watching a timer tick through
              the first four seconds of every turn is its own small stress. */}
          {isLong && (
            <span className="motion-appear text-[11px] tabular-nums text-text-dim/70">
              {formatElapsed(elapsed)}
            </span>
          )}
        </div>

        {/* The rail: an honest indeterminate, and only for long waits. Reserved
            height is not needed because it appears below the line rather than
            beside it, so its arrival pushes nothing the user is reading. */}
        {isLong && (
          <div className="motion-appear mt-1.5 h-px w-28 overflow-hidden rounded-full bg-hairline/15">
            <span className="motion-rail block h-full w-1/3 rounded-full bg-accent/60" />
          </div>
        )}

        {isVeryLong && (
          <p className="motion-appear mt-1.5 text-[11px] leading-snug text-text-dim/80">
            Still going. Long turns are normal — you can keep typing to add an
            instruction, or stop the run below.
          </p>
        )}
      </div>
    </div>
  );
}
