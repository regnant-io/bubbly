import React from 'react';
import { BubblyMark } from '../Shared/BubblyMark';
import { Bar, ThreadListSkeleton } from '../Shared/SkeletonLoader';

/**
 * The first thing you ever see.
 *
 * WHY THIS IS A SKELETON AND NOT A SPLASH
 *
 * A splash screen — a logo on an empty field — is a full-screen apology for not
 * being ready. It occupies the whole window, shares no geometry with the app,
 * and when it goes it takes every pixel with it, so the app does not so much
 * appear as replace something. In a packaged desktop build, where the backend
 * has to come up before the first request can be answered, that gap is long
 * enough to watch, and what you watch is a logo.
 *
 * So the boot state draws the APP instead: the title strip, the icon rail, the
 * thread list, the conversation column, the composer — the real layout, at the
 * real sizes, in the real colours, greyed. Three things follow from that, and
 * all three are the point:
 *
 *   1. It answers a different question. A splash says "wait". A skeleton says
 *      "here is the thing you are waiting for, and here is where each part of
 *      it will be." The first frame is already teaching the layout.
 *
 *   2. Nothing moves at the swap. The panels are already the right size in the
 *      right places, so becoming ready is content filling in, not furniture
 *      arriving. No reflow, no jump, no flash of an empty window.
 *
 *   3. It is honest about progress. There is no fake progress bar counting up
 *      to a number nobody knows. An indeterminate rail appears only if the wait
 *      turns out to BE a wait, and a plain sentence appears later still.
 *
 * The brand is not gone — the mark sits in the title strip exactly where it
 * sits in the real app, at the real size, breathing quietly. It is present
 * without being the event.
 *
 * Everything here is CSS and inline SVG: no image to fetch, no font to swap, no
 * measurement, so it paints on the first frame it possibly can.
 */
export function BootScreen({ message = 'Starting Bubbly' }: { message?: string }) {
  /**
   * How long has this been going?
   *
   * Two thresholds, because a boot has two failure modes and they deserve
   * different answers. Under ~700ms nothing extra is shown at all — a fast boot
   * that flashes a progress bar looks slower than the same boot without one.
   * Past that, an indeterminate rail says "still working, duration unknown".
   * Past ~4s the wait has stopped being ordinary, so it gets words: something
   * is genuinely slow (a cold backend, a first-run migration) and silence at
   * that point reads as a hang.
   */
  const [phase, setPhase] = React.useState<0 | 1 | 2>(0);
  React.useEffect(() => {
    const a = setTimeout(() => setPhase(1), 700);
    const b = setTimeout(() => setPhase(2), 4000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);

  return (
    <div
      className="ide-root flex flex-col h-screen bg-surface-0 text-text select-none"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={message}
    >
      {/* --- Title strip. The mark lives here in the real app, so it lives here. --- */}
      <div className="flex items-center h-9 shrink-0 px-3 gap-3">
        <BubblyMark size={15} animation="breathe" />
        <span className="text-[12px] font-medium tracking-tight text-text-muted">Bubbly</span>
        <div className="flex items-center gap-1.5 ml-1">
          <Bar w={46} h={7} />
          <Bar w={46} h={7} />
        </div>
        <div className="flex-1" />
        <Bar w={140} h={9} />
        <div className="flex-1" />
        <Bar w={16} h={7} />
      </div>

      {/* --- Body. Same gutters, same cards, same widths as BubbleRoom. --- */}
      <div className="flex flex-1 min-h-0 gap-2 p-2">
        {/* Icon rail */}
        <div className="skeleton-wave shrink-0 w-11 card bg-surface-1 flex flex-col items-center gap-2 py-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton" style={{ width: 17, height: 17, borderRadius: 5, opacity: Math.max(0.3, 1 - i * 0.14) }} />
          ))}
        </div>

        {/* Sidebar — matches ResizablePanel's 280px default so the real one
            slots straight in without the column changing width. */}
        <div className="shrink-0 card bg-surface-1 overflow-hidden flex flex-col" style={{ width: 280 }}>
          <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border">
            <Bar w={72} h={8} />
            <div className="flex-1" />
            <Bar w={14} h={8} />
          </div>
          <ThreadListSkeleton rows={7} />
        </div>

        {/* The conversation column */}
        <div className="flex flex-1 min-w-0 min-h-0">
          <div className="flex-1 min-h-0 overflow-hidden card bg-surface-1 flex flex-col">
            {/*
              The greeting block, bottom-aligned against the composer exactly as
              WelcomeScreen aligns it.

              Leaving this half of the window empty was the one place the
              skeleton stopped being a skeleton — a big void above a drawn
              composer reads as a panel that failed to load, not as one that is
              loading. Sketching the screen the user will actually land on
              (greeting, headline, a row of suggestion chips) keeps the promise
              the rest of the shell is making, and the real welcome screen then
              lands on top of its own outline.
            */}
            <div className="flex-1 min-h-0 flex flex-col justify-end">
              <div className="mx-auto w-full max-w-3xl px-4 pb-3">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="skeleton" style={{ width: 22, height: 22, borderRadius: 7 }} />
                  <Bar w={86} h={8} />
                </div>

                {/* The headline sits at the real 26px cap height, so the
                    question does not visibly jump when it replaces this. */}
                <div className="mb-4 h-[26px] flex items-center">
                  <Bar w={286} h={15} />
                </div>

                <div className="skeleton-wave flex flex-wrap items-center gap-2">
                  {[132, 108, 146, 120].map((w, i) => (
                    <div
                      key={i}
                      className="skeleton"
                      style={{ width: w, height: 32, borderRadius: 8, opacity: Math.max(0.35, 1 - i * 0.16) }}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/*
              The composer, drawn last and drawn accurately.
              It is the one control the user reaches for first, so having it
              already in place — right shape, right height, right position —
              is what makes the app feel present a moment before it is.
            */}
            <div className="shrink-0 px-4 pb-3 pt-2">
              <div className="mx-auto w-full max-w-2xl space-y-2">
                <div className="flex items-center justify-between">
                  <Bar w={128} h={9} />
                  <div className="flex items-center gap-2">
                    <Bar w={62} h={9} />
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-surface-1 px-3 py-3 flex items-center gap-3">
                  <div className="skeleton shrink-0" style={{ width: 16, height: 16, borderRadius: 5 }} />
                  <Bar w="46%" h={9} />
                  <div className="flex-1" />
                  <div className="skeleton shrink-0" style={{ width: 26, height: 26, borderRadius: 9 }} />
                </div>

                {/*
                  The one place anything is allowed to say "still going".

                  Reserved height in every phase, so its arrival cannot nudge the
                  composer above it — a loading screen whose layout shifts while
                  you look at it undoes the entire reason for drawing one.
                */}
                <div className="h-4 flex items-center justify-center gap-2">
                  <div className="h-px w-24 overflow-hidden rounded-full bg-hairline/15">
                    {phase >= 1 && <span className="motion-rail block h-full w-1/3 rounded-full bg-accent/70" />}
                  </div>
                  <span
                    className={`text-[11px] text-text-dim transition-opacity duration-300 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}
                  >
                    {message}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
