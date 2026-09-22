import React from 'react';

/** The Bubbly bloom: three orbiting bubbles around a luminous center. */
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
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none"
      className={`bubbly-mark bubbly-mark--${active} ${className}`}
      role={title ? 'img' : 'presentation'} aria-label={title} aria-hidden={title ? undefined : true}>
      <g className="bubbly-mark__grid" style={{ transformOrigin: '24px 24px' }}>
        <g className="bubbly-mark__bubble" style={{ transformOrigin: '24px 24px' }}>
          <circle cx="18" cy="18" r="12" fill="currentColor" opacity=".85" />
          <circle cx="31" cy="21" r="11" fill="currentColor" opacity=".65" />
          <circle cx="24" cy="32" r="11" fill="currentColor" opacity=".95" />
          <path d="M24 16C24 21 21 24 16 24C21 24 24 27 24 32C24 27 27 24 32 24C27 24 24 21 24 16Z" fill="var(--bg-page)" />
          <circle cx="38" cy="8" r="3" fill="currentColor" />
        </g>
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
