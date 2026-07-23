import React, { useState, useRef, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent';

interface ThinkingBubbleProps {
  content: string;
  streaming?: boolean;
}

/**
 * Reasoning block, Ollama-style.
 *
 * Reasoning models (deepseek-r1, qwen3, gpt-oss, minimax, …) emit a separate
 * "thinking" stream. Instead of a boxy collapsible, we render it the way the
 * Ollama app does: a soft, curved vertical line on the left with dimmed,
 * italic-feeling prose flowing beside it. Every token is captured. While the
 * model is actively reasoning the text streams live and the curve gently
 * pulses; once the answer starts the block stays in place (quietly readable),
 * and the user can collapse it to a single summary line if they want.
 */
export const ThinkingBubble = React.memo(function ThinkingBubble({ content, streaming }: ThinkingBubbleProps) {
  // Collapsed shows just the header line; expanded shows the full reasoning.
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="mb-3 animate-fade-in">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 text-xs text-text-dim hover:text-text-muted transition-colors mb-1"
      >
        <span className={`relative flex h-1.5 w-1.5 ${streaming ? '' : 'opacity-60'}`}>
          {streaming && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          )}
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${streaming ? 'bg-accent' : 'bg-text-dim'}`} />
        </span>
        <span className="italic tracking-tight">{streaming ? 'Thinking…' : 'Thought process'}</span>
        {content && (
          <span className="text-text-dim/50 not-italic">· {content.length.toLocaleString()} chars</span>
        )}
        <span className="text-text-dim/50">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="relative pl-4">
          {/* The Ollama-style curved line: a rounded, gradient vertical rail */}
          <span
            aria-hidden
            className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-gradient-to-b from-accent/50 via-border to-transparent ${
              streaming ? 'animate-pulse' : ''
            }`}
          />
          <div
            ref={scrollRef}
            className={`text-xs text-text-dim leading-relaxed max-h-64 overflow-y-auto pr-1 ${
              streaming ? 'opacity-90' : 'opacity-70'
            }`}
          >
            {/* While streaming, render reasoning as PLAIN TEXT. Markdown parses
                the whole block on every chunk (O(n²) over a turn), and thinking
                is skimmed dim prose where formatting earns nothing mid-flight.
                The finished block gets the full markdown pass. */}
            {streaming ? (
              <div className="whitespace-pre-wrap break-words">{content}</div>
            ) : (
              <MarkdownContent content={content} />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
