import React from 'react';

interface ConnectionStatusProps {
  status: 'connected' | 'disconnected' | 'reconnecting';
  reconnectDelay?: number;
}

/** Inline connection feedback keeps navigation accessible at every width. */
export function ConnectionStatus({ status, reconnectDelay }: ConnectionStatusProps) {
  if (status === 'connected') return null;

  const reconnecting = status === 'reconnecting';
  const seconds = reconnectDelay ? Math.ceil(reconnectDelay / 1000) : 0;

  return (
    <div className="connection-notice shrink-0 px-4 pt-2">
      <div
        role="status"
        aria-live="polite"
        className={`motion-pop rounded-md border px-3 py-2 ${
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
            Check that the local backend is running. Your conversation will reconnect automatically.
          </p>
        )}
      </div>
    </div>
  );
}
