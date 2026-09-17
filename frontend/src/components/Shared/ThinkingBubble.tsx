import React, { useState, useRef, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { Brain } from './icons';

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
    <div className="mb-3 motion-rise">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 text-xs text-text-dim hover:text-text-muted transition-all duration-200 mb-1 group"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand thinking' : 'Collapse thinking'}
      >
        {/* Brain icon with subtle animation */}
        <Brain
          size={14}
          className={`shrink-0 transition-colors duration-150 ${
            streaming
              ? 'text-accent motion-breathe'
              : 'text-text-dim/60 group-hover:text-text-dim'
          }`}
        />
        
        <span className="tracking-tight font-normal">
          {streaming ? (
            <span className="inline-flex items-baseline gap-1.5">
              {/* The sheen crosses the word itself, so the sentence carries the
                  liveness — no second animation is needed beside it. */}
              <span className="sheen-text">Thinking</span>
              {longThought && (
                <span className="motion-appear text-text-dim/70 tabular-nums">
                  {Math.floor(elapsedMs / 1000)}s
                </span>
              )}
            </span>
          ) : (
            'Thought process'
          )}
        </span>
        
        {content && (
          <span className="text-text-dim/50 font-normal tabular-nums">
            {content.split('\n').length} lines
          </span>
        )}
        
        {/* Collapse indicator with smooth rotation */}
        <span className={`text-text-dim/50 transition-transform duration-300 ${collapsed ? '' : 'rotate-90'}`}>
          ▸
        </span>
      </button>

      {/* Content with fluid collapse/expand animation - NO LEFT BORDER */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[32rem] opacity-100'
        }`}
      >
        <div className="pl-6">
          <div
            ref={scrollRef}
            className={`text-sm leading-relaxed max-h-64 overflow-y-auto pr-1 font-normal transition-opacity duration-200 ${
              streaming ? 'text-text-dim/70' : 'text-text-dim/60'
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
