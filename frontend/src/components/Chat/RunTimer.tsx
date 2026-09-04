import React, { useEffect, useState } from 'react';
import { Circle } from '../Shared/icons';
import { useStore } from '../../store';

/**
 * Animated timer that shows elapsed time during agent runs.
 * Displays on the right side of the input, stays visible throughout tool calls.
 */
export function RunTimer() {
  const runStartedAt = useStore((s) => s.runStartedAt);
  const lastRunDurationMs = useStore((s) => s.lastRunDurationMs);
  const isRunning = useStore((s) => s.isRunning);
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every 100ms while running
  useEffect(() => {
    if (!runStartedAt) {
      setElapsed(lastRunDurationMs || 0);
      return;
    }

    const updateElapsed = () => {
      setElapsed(Date.now() - runStartedAt);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 100);
    return () => clearInterval(interval);
  }, [runStartedAt, lastRunDurationMs]);

  // Don't show if never run
  if (!isRunning && !lastRunDurationMs) return null;

  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const displaySeconds = seconds % 60;
  const displayMinutes = minutes % 60;
  const displayHours = Math.floor(minutes / 60);

  const timeString = displayHours > 0
    ? `${displayHours}:${String(displayMinutes).padStart(2, '0')}:${String(displaySeconds).padStart(2, '0')}`
    : `${displayMinutes}:${String(displaySeconds).padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-2/60 border border-border text-xs text-text-dim animate-fade-in">
      <Circle 
        size={12} 
        className={isRunning ? 'text-accent animate-pulse' : 'text-text-dim'} 
      />
      <span className="font-mono tabular-nums">
        {timeString}
      </span>
    </div>
  );
}
