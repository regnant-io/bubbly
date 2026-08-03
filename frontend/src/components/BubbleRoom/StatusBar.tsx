import React, { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { Zap, Cpu, GitBranch, Folder, AlertCircle } from '../Shared/icons';

// The panel launchers that used to live here now have their own grouped dock
// bar above this pill (see DockBar). A status bar reports what is true; putting
// the app's most-used controls in it made them hard to find and made the pill
// impossible to read at a glance.

/** "12.3s" under a minute, "1m 04s" beyond — keeps a running timer readable either way. */
function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function StatusBar() {
  const { settings, workspacePath, isRunning, runStartedAt, lastRunDurationMs, pendingDiffs, ollamaRetryStatus, editorStatus } = useStore();

  const provider = settings?.defaultProvider ?? 'claude';
  const model = provider === 'claude' ? settings?.claudeModel : settings?.ollamaModel;
  const wsName = workspacePath ? workspacePath.split('/').pop() ?? workspacePath : null;

  // Ticks once a second while a run is active so the "Agent running" pill
  // shows a live elapsed time instead of a static label.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <div className="h-10 flex items-center px-4 gap-4 text-xs text-text-dim">
      {/* Left */}
      <div className="flex items-center gap-1.5">
        {isRunning ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-green-agent animate-pulse" />
            <span className="text-green-agent font-medium">
              Agent running{runStartedAt ? ` · ${formatDuration(Date.now() - runStartedAt)}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-surface-3" />
            <span>Idle{lastRunDurationMs ? ` · last run ${formatDuration(lastRunDurationMs)}` : ''}</span>
          </>
        )}
      </div>

      {/* Ollama retry status */}
      {ollamaRetryStatus && ollamaRetryStatus.isRetrying && (
        <div className="flex items-center gap-1.5 text-amber-agent">
          <AlertCircle size={13} className="animate-pulse" />
          <span>
            Ollama retry {ollamaRetryStatus.attempt}/{ollamaRetryStatus.maxAttempts} 
            {' '}(retrying in {(ollamaRetryStatus.delayMs / 1000).toFixed(1)}s)
          </span>
        </div>
      )}

      <div className="flex items-center gap-1">
        {provider === 'claude' ? (
          <Zap size={11} className="text-accent-bright" />
        ) : (
          <Cpu size={11} className="text-green-agent" />
        )}
        <span>{model ?? '—'}</span>
      </div>

      {wsName && (
        <div className="flex items-center gap-1">
          <Folder size={11} />
          <span className="truncate max-w-48">{wsName}</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Editor status (VS Code-style) — only when a file is open. */}
      {editorStatus && (
        <div className="flex items-center gap-3">
          <span title="Cursor position">Ln {editorStatus.line}, Col {editorStatus.col}</span>
          <span title="Indentation">Spaces: {editorStatus.indent}</span>
          <span>UTF-8</span>
          <span title="End of line sequence">{editorStatus.eol}</span>
          <span className="capitalize">{editorStatus.language}</span>
        </div>
      )}

      {/* Uncommitted changes — a fact about the workspace, so it belongs here
          rather than on the launcher that opens the Changes panel. */}
      {pendingDiffs.length > 0 && (
        <div className="flex items-center gap-1 pl-2 border-l border-border" title="Files changed this session">
          <GitBranch size={11} className="text-accent-bright" />
          <span className="tabular-nums">{pendingDiffs.length} changed</span>
        </div>
      )}
    </div>
  );
}
