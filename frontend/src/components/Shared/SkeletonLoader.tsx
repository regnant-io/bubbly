import React from 'react';

interface SkeletonLoaderProps {
  width?: string | number;
  height?: string | number;
  count?: number;
  className?: string;
  variant?: 'text' | 'rectangular' | 'circular';
}

/**
 * The widths a paragraph of placeholder text uses, in order.
 *
 * A ragged right edge is what makes a stack of bars read as PROSE rather than
 * as a table — every line the same length looks like data, and data that never
 * arrives looks broken. These used to come from `Math.random()`, which is worse
 * than it sounds: React re-runs the render on every parent update, so the
 * placeholder silently re-flowed to different widths while the user was looking
 * at it, and no two renders of the same screen ever agreed. A fixed cycle gives
 * the same irregularity, deterministically.
 */
const LINE_WIDTHS = ['96%', '88%', '93%', '72%', '90%', '81%'];

/**
 * A single loading placeholder, or a stack of them.
 *
 * The visual texture lives in the `.skeleton` class (styles/animations.css),
 * which is shared with every other loading affordance in the app so that "not
 * ready yet" always looks like one thing.
 *
 * @param width - Width of the skeleton (default: '100%')
 * @param height - Height of the skeleton (default: '20px')
 * @param count - Number of skeleton lines to render (default: 1)
 * @param className - Optional additional CSS classes
 * @param variant - Shape variant: 'text', 'rectangular', or 'circular' (default: 'text')
 */
export function SkeletonLoader({
  width = '100%',
  height = '20px',
  count = 1,
  className = '',
  variant = 'text',
}: SkeletonLoaderProps) {
  // Convert numeric values to px strings
  const widthStyle = typeof width === 'number' ? `${width}px` : width;
  const heightStyle = typeof height === 'number' ? `${height}px` : height;

  // Variant-specific styles
  const variantClasses = {
    text: 'rounded',
    rectangular: 'rounded-md',
    circular: 'rounded-full',
  };

  const skeletons = Array.from({ length: count }, (_, index) => {
    const isLast = index === count - 1;
    // Multi-line text gets the ragged edge; a single line, and every non-text
    // variant, is exactly the size it was asked for.
    const lineWidth =
      count > 1 && variant === 'text'
        ? isLast
          ? LINE_WIDTHS[LINE_WIDTHS.length - 1]
          : LINE_WIDTHS[index % (LINE_WIDTHS.length - 1)]
        : widthStyle;

    return (
      <div
        key={index}
        className={`skeleton ${variantClasses[variant]} ${className}`}
        style={{
          width: lineWidth,
          height: heightStyle,
          marginBottom: count > 1 && !isLast ? '8px' : '0',
          // Offset each line's highlight so a paragraph reads as one wave
          // travelling down it rather than every bar flashing on the same frame.
          animationDelay: `${-index * 0.13}s`,
        }}
        role="status"
        aria-label="Loading..."
      />
    );
  });

  return <div className="skeleton-container">{skeletons}</div>;
}

/**
 * SkeletonApprovalBlock Component
 *
 * Specialized skeleton loader for approval blocks with predefined layout.
 * Shows a skeleton that matches the typical approval block structure.
 */
export function SkeletonApprovalBlock() {
  return (
    <div className="skeleton-approval-block bg-surface-2 border border-border rounded-lg p-4 space-y-3 motion-rise">
      {/* Header skeleton */}
      <div className="flex items-center gap-3">
        <SkeletonLoader variant="circular" width={32} height={32} />
        <SkeletonLoader width="40%" height={16} />
      </div>

      {/* Content skeleton */}
      <div className="space-y-2">
        <SkeletonLoader width="100%" height={14} />
        <SkeletonLoader width="90%" height={14} />
        <SkeletonLoader width="70%" height={14} />
      </div>

      {/* Action buttons skeleton */}
      <div className="flex gap-2 pt-2">
        <SkeletonLoader variant="rectangular" width={80} height={32} />
        <SkeletonLoader variant="rectangular" width={80} height={32} />
      </div>
    </div>
  );
}

/* ==========================================================================
   SHAPED SKELETONS

   A generic grey box is a worse loading state than nothing: it says "wait"
   without saying what for, and when the real content lands it lands in a
   completely different shape, so the screen jumps.

   Each of these is drawn to the geometry of the thing it stands in for — same
   row heights, same indents, same column widths — so the arrival is a change of
   CONTENT, not a change of LAYOUT. That is the whole reason skeletons beat
   spinners: the page is already built, it is just not filled in yet.
   ========================================================================== */

/** One placeholder bar. The primitive the shaped skeletons are drawn from. */
export function Bar({ w, h = 9, className = '' }: { w: string | number; h?: number; className?: string }) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px`, borderRadius: 999 }}
    />
  );
}

/**
 * A thread in the sidebar list: title, then a dimmer meta line.
 *
 * `opacity` falls off down the list rather than every row being equally
 * present. Real lists fade under the fold, and a skeleton that does the same
 * keeps the eye at the top of the panel where the content will first appear —
 * instead of spreading attention evenly over rows that are about to be replaced.
 */
export function ThreadListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-wave px-2 py-1.5 space-y-1" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="rounded-lg px-2.5 py-2 space-y-1.5"
          style={{ opacity: Math.max(0.25, 1 - i * 0.13) }}
        >
          <Bar w={i % 3 === 0 ? '58%' : i % 3 === 1 ? '78%' : '66%'} h={10} />
          <Bar w="34%" h={7} />
        </div>
      ))}
    </div>
  );
}

/**
 * A file tree: rows at varying indent depths, each with an icon square.
 *
 * The indents are hand-chosen rather than random so it looks like a directory
 * someone actually has — a couple of folders, files nested under them — which
 * is the point of a shaped skeleton over a stack of identical bars.
 */
export function FileTreeSkeleton({ rows = 9 }: { rows?: number }) {
  const depths = [0, 1, 1, 2, 1, 0, 1, 1, 2, 1, 0, 1];
  const widths = ['62%', '48%', '55%', '40%', '58%', '68%', '44%', '52%', '38%', '50%', '60%', '46%'];
  return (
    <div className="skeleton-wave px-2 py-1.5 space-y-1.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-2"
          style={{ paddingLeft: depths[i % depths.length] * 12, opacity: Math.max(0.3, 1 - i * 0.075) }}
        >
          <div className="skeleton shrink-0" style={{ width: 11, height: 11, borderRadius: 3 }} />
          <Bar w={widths[i % widths.length]} h={8} />
        </div>
      ))}
    </div>
  );
}

/**
 * A conversation being reloaded: alternating user prompts and agent answers.
 *
 * A user prompt is short and right-ish; an answer is a paragraph with a couple
 * of tool lines under it. Reproducing that rhythm is what stops the transcript
 * from visibly rearranging itself the moment the real messages land.
 */
export function TranscriptSkeleton() {
  return (
    <div className="skeleton-wave mx-auto w-full max-w-3xl px-4 py-6 space-y-7" aria-hidden="true">
      {[0, 1].map((turn) => (
        <div key={turn} className="space-y-5" style={{ opacity: turn === 0 ? 1 : 0.55 }}>
          {/* The prompt: a short, self-contained block sitting to one side. */}
          <div className="flex justify-end">
            <div className="max-w-[70%] space-y-2 rounded-2xl bg-surface-2/60 px-4 py-3">
              <Bar w={turn === 0 ? 210 : 150} h={9} />
              <Bar w={turn === 0 ? 130 : 96} h={9} />
            </div>
          </div>

          {/* The answer: prose, then the quiet one-line tool calls under it. */}
          <div className="space-y-2.5">
            <Bar w="94%" h={9} />
            <Bar w="88%" h={9} />
            <Bar w="72%" h={9} />
            <div className="pt-1.5 space-y-2">
              <div className="flex items-center gap-2">
                <div className="skeleton shrink-0" style={{ width: 10, height: 10, borderRadius: 999 }} />
                <Bar w="42%" h={8} />
              </div>
              <div className="flex items-center gap-2">
                <div className="skeleton shrink-0" style={{ width: 10, height: 10, borderRadius: 999 }} />
                <Bar w="34%" h={8} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
