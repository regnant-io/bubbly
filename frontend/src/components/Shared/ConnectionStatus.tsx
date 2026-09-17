import React from 'react';

interface ConnectionStatusProps {
  status: 'connected' | 'disconnected' | 'reconnecting';
  reconnectDelay?: number;
}

/**
 * The socket is down.
 *
 * WHAT THIS HAS TO GET RIGHT, AND WHAT IT USED TO GET WRONG
 *
 * COLOUR. It was painted with `bg-yellow-500` / `bg-red-500` and a `dark:`
 * variant — raw Tailwind ramp colours, so on the eight non-default palettes it
 * was the one element on screen from a different product, and its contrast was
 * whatever those two fixed hues happened to give against that theme's surface.
 * Everything here now goes through the status tokens, which every palette
 * defines.
 *
 * POSITION. `top-4 right-4` put it exactly on top of the chat panel's overflow
 * menu, so the banner that appears when things go wrong covered a control. It
 * now sits centred under the title strip, over nothing.
 *
 * WORDS. "Connection lost" is a statement with no next step, and the question
 * it leaves unanswered is the only one the user actually has: *is my work
 * gone?* It is not — a turn keeps running on the backend with no window
 * attached, which is the whole point of the tray — so the banner says so. A
 * reconnect countdown gets a number, because a number is the difference between
 * waiting and being stuck.
 *
 * SIZE. Reconnecting is routine (a dev-server restart, a laptop lid); it gets
 * one quiet line. Actually disconnected is not; it gets the explanation. The
 * banner scales with the seriousness of the state rather than being one shape
 * that shouts either way.
 */
export function ConnectionStatus({ status, reconnectDelay }: ConnectionStatusProps) {
  if (status === 'connected') return null;

  const reconnecting = status === 'reconnecting';
  const seconds = reconnectDelay ? Math.ceil(reconnectDelay / 1000) : 0;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={`motion-pop pointer-events-auto max-w-md rounded-xl border px-3.5 py-2 shadow-lg backdrop-blur-sm ${
          reconnecting
            ? 'border-amber-agent/40 bg-warning-bg'
            : 'border-red-agent/40 bg-error-bg'
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              reconnecting ? 'motion-breathe bg-amber-agent' : 'bg-red-agent'
            }`}
            aria-hidden="true"
          />
          <span className={`text-[13px] font-medium ${reconnecting ? 'text-amber-agent' : 'text-red-agent'}`}>
            {reconnecting
              ? seconds > 0 ? `Reconnecting in ${seconds}s` : 'Reconnecting…'
              : 'Disconnected from the backend'}
          </span>
        </div>

        {/* Only the serious state earns the second line. */}
        {!reconnecting && (
          <p className="mt-1 text-[11px] leading-snug text-text-muted">
            Any run already in flight keeps going on the backend — nothing is lost.
            This window will pick it back up as soon as the connection returns.
          </p>
        )}
      </div>
    </div>
  );
}
