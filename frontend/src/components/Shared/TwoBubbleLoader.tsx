import React from 'react';

/**
 * Two-bubble "typing" indicator shown right after the user's message, before
 * the agent's response (thinking/text/tool call) has started arriving. Kept
 * deliberately tiny and quiet — it's a placeholder for the beat between send
 * and first token, not a competing loading state with BubbleLoader (which is
 * the larger, labeled variant used elsewhere).
 */
export function TwoBubbleLoader() {
  return (
    <div className="flex items-center gap-3 px-4 py-2 animate-fade-in" aria-live="polite" aria-label="Bubbly is responding">
      <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
        <img src="/bubble.svg" alt="" className="w-4 h-4" />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-accent-bright animate-bounce" style={{ animationDelay: '180ms' }} />
      </div>
    </div>
  );
}
