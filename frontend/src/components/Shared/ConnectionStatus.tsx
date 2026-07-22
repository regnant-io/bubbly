import React from 'react';

interface ConnectionStatusProps {
  status: 'connected' | 'disconnected' | 'reconnecting';
  reconnectDelay?: number;
}

export function ConnectionStatus({ status, reconnectDelay }: ConnectionStatusProps) {
  if (status === 'connected') {
    return null; // Don't show anything when connected
  }

  return (
    <div className="fixed top-4 right-4 z-50 animate-slideInDown">
      <div
        className={`
          px-4 py-2 rounded-lg shadow-lg border
          ${status === 'reconnecting' 
            ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600 dark:text-yellow-400' 
            : 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400'
          }
        `}
      >
        <div className="flex items-center gap-2">
          {status === 'reconnecting' && (
            <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          )}
          {status === 'disconnected' && (
            <div className="w-2 h-2 rounded-full bg-red-500" />
          )}
          <span className="text-sm font-medium">
            {status === 'reconnecting' 
              ? `Reconnecting${reconnectDelay ? ` in ${Math.ceil(reconnectDelay / 1000)}s` : '...'}` 
              : 'Connection lost'
            }
          </span>
        </div>
      </div>
    </div>
  );
}
