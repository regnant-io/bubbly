import React, { useEffect, useState } from 'react';
import { useStore } from '../../store';

/** "12.3s" under a minute, "1m 04s" beyond — keeps a running timer readable either way. */
function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Two-bubble "typing" indicator shown during generation gaps. Now fixed
 * positioned at the bottom center of the chat UI so it doesn't move with
 * message flow. Includes the agent running timer inline.
 */
export function TwoBubbleLoader() {
  const { isRunning, runStartedAt } = useStore();
  
  // Ticks once a second while a run is active so the timer shows live elapsed time
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <div 
      className="flex items-center gap-3 px-4 py-2.5 bg-surface-2 border border-border rounded-full shadow-lg animate-fade-in" 
      aria-live="polite" 
      aria-label="Bubbly is responding"
    >
      <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
        <img src="/bubble.svg" alt="" className="w-4 h-4" />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-accent-bright animate-bounce" style={{ animationDelay: '180ms' }} />
      </div>
      {isRunning && runStartedAt && (
        <span className="text-xs text-text-dim tabular-nums">
          {formatDuration(Date.now() - runStartedAt)}
        </span>
      )}
    </div>
  );
}
