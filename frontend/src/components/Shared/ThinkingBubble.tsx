import React, { useState, useRef, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { ChevronRight } from './icons';

interface ThinkingBubbleProps {
  content: string;
  streaming?: boolean;
}

/**
 * NO CAROUSEL OF SYNONYMS.
 *
 * This label used to cycle every nine seconds through twenty words —
 * "Crystallizing", "ideating", "daydreaming", "plotting". It reads as
 * personality for about the first two turns and as noise forever after, and it
 * is actively misleading: the word changed, so something must have changed, and
 * nothing had. A label that moves without meaning anything is a label people
 * learn to stop reading, which costs you the moments it DOES carry news.
 *
 * One honest word, and a real number beside it once the wait is long enough for
 * the number to be information. See components/Shared/AgentPresence.tsx, which
 * makes the same argument about the same problem.
 */
const STILL_THINKING_MS = 12_000;

/**
 * Reasoning block with dynamic loader and smooth streaming.
 *
 * COLLAPSED BY DEFAULT with fluid animation. No left border. Same font as generation.
 * Dynamic loader cycles through thinking verbs, shows "still thinking" after 10s.
 * Brain icon on the left. Collapses/expands with smooth fluid animation.
 */
export const ThinkingBubble = React.memo(function ThinkingBubble({ content, streaming }: ThinkingBubbleProps) {
  // COLLAPSED BY DEFAULT - user must explicitly expand
  const [collapsed, setCollapsed] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef(Date.now());

  // One tick a second, only while reasoning is actually streaming. Enough for a
  // seconds readout, and it stops dead the moment the block settles — a
  // finished thought does not need a running clock.
  useEffect(() => {
    if (!streaming) return;
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - startTimeRef.current), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  // While streaming, keep the latest reasoning in view. The scroll is deferred
  // to the next frame: writing scrollTop during render/commit forces a
  // synchronous reflow, and doing that on every chunk is a per-frame layout
  // stall that reads exactly like "thinking streams less smoothly than text".
  useEffect(() => {
    if (!streaming || collapsed) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [content, streaming, collapsed]);

  if (!content && !streaming) return null;

  const longThought = elapsedMs >= STILL_THINKING_MS;

  return (
    <div className="tl thinking motion-rise">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="tl-head thinking-head"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand thinking' : 'Collapse thinking'}
      >
        <ChevronRight size={13} className={`tl-caret ${collapsed ? '' : 'rotate-90'}`} />
        <span className="tl-head-text">
          {streaming ? (
            <span className="inline-flex items-baseline gap-1.5">
              {/* The sheen crosses the word itself, so the sentence carries the
                  liveness; no second animation is needed beside it. */}
              <span className="sheen-text">Thinking</span>
              {longThought && (
                <span className="motion-appear text-text-dim tabular-nums">
                  {Math.floor(elapsedMs / 1000)}s
                </span>
              )}
            </span>
          ) : (
            <span className="tl-head-title">Thought process</span>
          )}
        </span>
        {content && (
          <span className="tl-aside tabular-nums">
            {content.split('\n').length} lines
          </span>
        )}
      </button>

      {/* Content with fluid collapse/expand animation - NO LEFT BORDER */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[32rem] opacity-100'
        }`}
      >
        <div className="thinking-body">
          <div
            ref={scrollRef}
            className={`leading-relaxed max-h-64 overflow-y-auto pr-1 font-normal transition-opacity duration-200 ${
              streaming ? 'text-text-dim' : 'text-text-dim'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            {/* While streaming, render reasoning as PLAIN TEXT. Markdown parses
                the whole block on every chunk (O(n²) over a turn), and thinking
                is skimmed dim prose where formatting earns nothing mid-flight.
                The finished block gets the full markdown pass. */}
            {streaming ? (
              <div className="whitespace-pre-wrap break-words">{content}</div>
            ) : (
              <div className="markdown-thinking">
                <MarkdownContent content={content} highlight={false} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
