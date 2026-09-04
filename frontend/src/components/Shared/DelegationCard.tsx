import React, { useState } from 'react';
import { Bot, Loader2, CheckCircle, AlertCircle, FileCode, ChevronRight } from './icons';

interface DelegationCardProps {
  instruction: string;
  targetFiles?: string[];
  acceptance?: string;
  phase: string; // dispatched | gathering_context | working | validating | done | error
  detail?: string;
  report?: string;
  filesTouched?: string[];
  validationOk?: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  dispatched: 'Dispatched',
  gathering_context: 'Gathering context',
  working: 'Implementing',
  validating: 'Validating',
  repairing: 'Repairing',
  done: 'Completed',
  error: 'Failed',
};

/**
 * A live card for a delegated worker agent. Shows the assignment, the worker's
 * current phase while it runs, and its final report + changed files when done.
 * Distinct from generic tool bubbles so delegation is visible and traceable.
 */
export function DelegationCard({
  instruction,
  targetFiles,
  acceptance,
  phase,
  detail,
  report,
  filesTouched,
  validationOk,
}: DelegationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isDone = phase === 'done';
  const isError = phase === 'error' || (isDone && validationOk === false);
  const isRunning = !isDone && phase !== 'error';

  const phaseLabel = PHASE_LABEL[phase] ?? phase;

  return (
    <div className="my-3 animate-fade-in">
      <div
        className={`rounded-xl border bg-surface-1 overflow-hidden ${
          isError ? 'border-red-agent/40' : isDone ? 'border-green-agent/40' : 'border-accent/40'
        }`}
      >
        {/* Header */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/50 transition-colors"
        >
          <span
            className={`shrink-0 ${
              isError ? 'text-red-agent' : isDone ? 'text-green-agent' : 'text-accent-bright'
            }`}
          >
            {isRunning ? (
              <Loader2 size={15} className="animate-spin" />
            ) : isError ? (
              <AlertCircle size={15} />
            ) : (
              <CheckCircle size={15} />
            )}
          </span>
          <Bot size={14} className="text-text-dim shrink-0" />
          <span className="text-xs font-medium text-text truncate flex-1">
            {instruction || 'Delegated task'}
          </span>
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${
              isError
                ? 'text-red-agent bg-error-bg'
                : isDone
                ? 'text-green-agent bg-success-bg'
                : 'text-accent-bright bg-accent/10'
            }`}
          >
            {phaseLabel}
          </span>
          <ChevronRight
            size={13}
            className={`text-text-dim shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>

        {/* Live detail line while running */}
        {isRunning && detail && (
          <div className="px-3 pb-2 -mt-1 text-[11px] text-text-dim truncate">{detail}</div>
        )}

        {/* Expanded body */}
        {expanded && (
          <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
            {acceptance && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-dim mb-0.5">Done when</p>
                <p className="text-xs text-text-muted">{acceptance}</p>
              </div>
            )}
            {targetFiles && targetFiles.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-dim mb-0.5">Target files</p>
                <div className="flex flex-wrap gap-1">
                  {targetFiles.map((f) => (
                    <span key={f} className="flex items-center gap-1 text-[11px] text-text-muted bg-surface-2 rounded px-1.5 py-0.5">
                      <FileCode size={10} /> {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {report && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-dim mb-0.5">Report</p>
                <p className="text-xs text-text">{report}</p>
              </div>
            )}
            {filesTouched && filesTouched.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-text-dim mb-0.5">
                  Changed {filesTouched.length} file{filesTouched.length === 1 ? '' : 's'}
                </p>
                <div className="flex flex-wrap gap-1">
                  {filesTouched.map((f) => (
                    <span key={f} className="flex items-center gap-1 text-[11px] text-text-muted bg-surface-2 rounded px-1.5 py-0.5">
                      <FileCode size={10} /> {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
