import React from 'react';
import { BubblyMark } from '../Shared/BubblyMark';

/**
 * The first thing you ever see.
 *
 * WHAT THIS REPLACED, AND WHY
 *
 * A pulsing PNG inside a pinging ring, above a wordmark, above three bouncing
 * dots, above a caption. Four separate animations competing for attention on a
 * screen that is usually gone in under a second — which reads as busy rather
 * than fast, and which was the only place in the app not using the real
 * animated mark.
 *
 * A splash has exactly one job: cover the gap before the UI is wired without
 * making the gap feel longer. So there is ONE animation (the mark's own
 * cascade, which is the brand), one word, and a hairline that only appears if
 * the wait turns out to be a real wait. Everything is CSS and inline SVG, with
 * no image to fetch and no font to swap, so it paints on the first frame.
 *
 * THE DELAYED PROGRESS LINE IS THE POINT.
 *
 * Showing a progress indicator immediately makes a 200ms boot look like a
 * loading screen. Showing one only after 900ms means the fast path is a blink
 * and the slow path — a cold backend, a first-run migration — gets an honest
 * "still going" signal rather than an apparently frozen logo.
 */
export function BootScreen({ message = 'Starting Bubbly' }: { message?: string }) {
  // "Is this taking a while?" — the only state a splash needs.
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setSlow(true), 900);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-surface-0 text-text"
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <BubblyMark size={40} animation="cascade" />

      <div className="flex flex-col items-center gap-2">
        <span className="text-[13px] font-medium tracking-tight text-text-muted">Bubbly</span>

        {/* A 1px indeterminate rail. Reserved height either way, so its arrival
            cannot nudge the mark upward. */}
        <div className="h-px w-24 overflow-hidden rounded-full bg-hairline/15">
          {slow && <span className="boot-rail block h-full w-1/3 rounded-full bg-accent/70" />}
        </div>

        <span className={`text-[11px] text-text-dim transition-opacity duration-300 ${slow ? 'opacity-100' : 'opacity-0'}`}>
          {message}
        </span>
      </div>
    </div>
  );
}
