import React from 'react';

/**
 * The Bubbly mark, animated.
 *
 * THE CONSTRAINT THAT SHAPES THIS
 *
 * The logo is four bubbles in a 2×2 grid. Every animation here uses THOSE FOUR
 * and nothing else — no extra elements appear, none disappear, nothing morphs
 * into a different shape. A loading indicator that stops being the logo is a
 * different graphic that happens to start where the logo was, and the brand
 * stops being recognisable at exactly the moment people are staring at it.
 *
 * So the four bubbles move, breathe, orbit and cascade, and at every frame of
 * every animation the thing on screen is still the mark.
 *
 * FOUR ANIMATIONS, CYCLED
 *
 *   breathe  — all four scale together. Idle, calm, "here but not working".
 *   cascade  — a wave through them in reading order. Progress with direction.
 *   orbit    — the grid rotates as a body. Sustained work, no implied progress.
 *   pulse    — one bubble at a time brightens. Discrete steps, thinking.
 *
 * They cycle rather than being chosen, so a long wait never becomes a single
 * hypnotic loop — the change of rhythm is what keeps it feeling alive across
 * minutes rather than seconds.
 *
 * PREFERS-REDUCED-MOTION IS HONOURED, and not by freezing: a still logo during
 * a long operation says "hung". The reduced form is a slow, low-amplitude
 * opacity breath, which conveys "working" without motion.
 */

export type BubblyAnimation = 'breathe' | 'cascade' | 'orbit' | 'pulse' | 'none';

interface BubblyMarkProps {
  size?: number;
  /** Fixed animation, or 'cycle' to rotate through all four. */
  animation?: BubblyAnimation | 'cycle';
  /** How long each animation runs before the next, in ms. */
  cycleMs?: number;
  className?: string;
  title?: string;
}

const ORDER: BubblyAnimation[] = ['breathe', 'cascade', 'orbit', 'pulse'];

export function BubblyMark({
  size = 28,
  animation = 'none',
  cycleMs = 4200,
  className = '',
  title,
}: BubblyMarkProps) {
  const [phase, setPhase] = React.useState(0);

  React.useEffect(() => {
    if (animation !== 'cycle') return;
    const t = setInterval(() => setPhase((p) => (p + 1) % ORDER.length), cycleMs);
    return () => clearInterval(t);
  }, [animation, cycleMs]);

  const active: BubblyAnimation = animation === 'cycle' ? ORDER[phase] : animation;
  // A stable id per instance: two marks on one page must not share gradient ids,
  // or the second one silently adopts the first one's fill.
  const gradientId = React.useId().replace(/:/g, '');

  const bubbles = [
    { cx: 16, cy: 16, delay: 0 },
    { cx: 32, cy: 16, delay: 1 },
    { cx: 16, cy: 32, delay: 3 },   // reading order for the cascade: ↘ then ↙
    { cx: 32, cy: 32, delay: 2 },
  ];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={`bubbly-mark bubbly-mark--${active} ${className}`}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <radialGradient id={gradientId} cx="35%" cy="35%" r="65%">
          {/*
            The mark takes its colour from the ACTIVE THEME rather than from a
            fixed orange. A logo that stays orange in a green theme is the one
            element on screen that belongs to a different product.
          */}
          <stop offset="0%" stopColor="var(--primary-hover)" />
          <stop offset="100%" stopColor="var(--primary)" />
        </radialGradient>
      </defs>

      {/* The grid rotates as a body for `orbit`; individual bubbles animate inside. */}
      <g className="bubbly-mark__grid" style={{ transformOrigin: '24px 24px' }}>
        {bubbles.map((b, i) => (
          <g
            key={i}
            className="bubbly-mark__bubble"
            style={{
              transformOrigin: `${b.cx}px ${b.cy}px`,
              animationDelay: `${b.delay * 0.14}s`,
            }}
          >
            <circle cx={b.cx} cy={b.cy} r="8" fill={`url(#${gradientId})`} />
            {/* The highlight is what makes it read as a bubble rather than a dot. */}
            <circle cx={b.cx - 2.5} cy={b.cy - 2.5} r="2.5" fill="white" fillOpacity="0.4" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * The mark with a label, for loading states.
 *
 * The label matters more than the animation: "Starting the backend" and
 * "Indexing your project" are different waits, and a spinner that cannot tell
 * you which one you are in is the reason long startups feel broken.
 */
export function BubblyLoader({
  label,
  detail,
  size = 44,
}: { label: string; detail?: string; size?: number }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <BubblyMark size={size} animation="cycle" />
      <div>
        <p className="text-sm text-text">{label}</p>
        {detail && <p className="mt-0.5 text-[11px] text-text-dim">{detail}</p>}
      </div>
    </div>
  );
}
