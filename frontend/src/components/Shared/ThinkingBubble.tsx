import React, { useState, useRef, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { Brain } from './icons';

interface ThinkingBubbleProps {
  content: string;
  streaming?: boolean;
}

const THINKING_VERBS = [
  'Crystallizing',
  'thinking',
  'brainstorming',
  'ideating',
  'conceptualizing',
  'theorizing',
  'strategizing',
  'contemplating',
  'reflecting',
  'pondering',
  'meditating',
  'analyzing',
  'evaluating',
  'envisioning',
  'daydreaming',
  'plotting',
  'designing',
  'innovating',
  'synthesizing',
  'organizing',
];

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
  const [verbIndex, setVerbIndex] = useState(0);
  const [showStillThinking, setShowStillThinking] = useState(false);
  const startTimeRef = useRef(Date.now());

  // Cycle through thinking verbs every 9 seconds while streaming
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => {
      setVerbIndex((i) => (i + 1) % THINKING_VERBS.length);
      // After 10 seconds, show "still thinking"
      if (Date.now() - startTimeRef.current > 10000) {
        setShowStillThinking(true);
      }
    }, 9000);
    return () => clearInterval(interval);
  }, [streaming]);

  // Reset timer when streaming starts
  useEffect(() => {
    if (streaming) {
      startTimeRef.current = Date.now();
      setShowStillThinking(false);
    }
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

  const currentVerb = THINKING_VERBS[verbIndex];

  return (
    <div className="mb-3 animate-fade-in">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 text-xs text-text-dim hover:text-text-muted transition-all duration-200 mb-1 group"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand thinking' : 'Collapse thinking'}
      >
        {/* Brain icon with subtle animation */}
        <Brain 
          size={14} 
          className={`shrink-0 transition-all duration-300 ${
            streaming 
              ? 'text-accent animate-pulse' 
              : 'text-text-dim/60 group-hover:text-text-dim'
          }`} 
        />
        
        {/* Dynamic loader with cycling verbs */}
        <span className="tracking-tight font-normal transition-all duration-300">
          {streaming ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="capitalize animate-fade-in">{currentVerb}</span>
              <span className="animate-pulse">…</span>
              {showStillThinking && (
                <span className="text-text-dim/70 ml-1 animate-fade-in">(still thinking)</span>
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
