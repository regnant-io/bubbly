import React from 'react';

/**
 * First-paint boot splash. Shown while initial settings + sessions load so the
 * window never flashes an empty/half-wired IDE. Intentionally tiny and
 * dependency-free so it renders instantly.
 */
export function BootScreen({ message = 'Starting Bubbly…' }: { message?: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-0 text-text">
      <div className="relative">
        <img src="/bubble.svg" alt="Bubbly" className="w-16 h-16 animate-pulse" />
        <span className="absolute -inset-3 rounded-full border border-accent/30 animate-ping" />
      </div>
      <h1 className="mt-5 text-lg font-semibold tracking-tight">Bubbly</h1>
      <div className="mt-3 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <p className="mt-3 text-xs text-text-dim">{message}</p>
    </div>
  );
}
