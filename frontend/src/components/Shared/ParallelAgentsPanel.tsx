import React from 'react';
import type { ParallelLane } from '../../types';
import { Bot, Loader2, CheckCircle, AlertCircle, FileCode } from './icons';

/**
 * Live view of a batch of parallel worker agents. Each lane runs independently
 * and is shown in its own card. The whole group lives in a single FIXED-HEIGHT,
 * scrollable container so any number of busy agents can never blow out the
 * chat layout — it scrolls internally instead.
 */
export function ParallelAgentsPanel({ lanes }: { lanes: ParallelLane[] }) {
  const doneCount = lanes.filter((l) => l.phase === 'done').length;
  const allDone = doneCount === lanes.length && lanes.length > 0;

  return (
    <div className="my-4 rounded-xl border border-accent/25 bg-accent/5 overflow-hidden animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/20 bg-accent/8">
        <Bot size={14} className="text-accent-bright shrink-0" />
        <span className="text-sm font-medium text-text">
          {allDone ? 'Parallel agents finished' : 'Agents working in parallel'}
        </span>
        <span className="text-xs text-text-dim ml-auto tabular-nums">{doneCount}/{lanes.length} done</span>
      </div>

      {/* Fixed-height, internally scrollable — keeps the layout stable no matter
          how much each lane streams. */}
      <div className="max-h-80 overflow-y-auto p-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {lanes.map((lane) => (
            <LaneCard key={lane.lane} lane={lane} />
          ))}
        </div>
      </div>
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'gathering_context': return 'Gathering context';
    case 'working': return 'Working';
    case 'validating': return 'Validating';
    case 'repairing': return 'Repairing';
    case 'done': return 'Done';
    case 'error': return 'Failed';
    default: return phase;
  }
}

function LaneCard({ lane }: { lane: ParallelLane }) {
  const isDone = lane.phase === 'done';
  const failed = isDone && lane.validationOk === false;

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-2.5 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="flex items-center justify-center w-5 h-5 rounded bg-surface-3 text-[10px] font-semibold text-text-dim shrink-0">
          {lane.laneIndex + 1}
        </span>
        {isDone
          ? (failed
              ? <AlertCircle size={13} className="text-amber-agent shrink-0" />
              : <CheckCircle size={13} className="text-green-agent shrink-0" />)
          : <Loader2 size={13} className="text-accent-bright animate-spin shrink-0" />}
        <span className={`text-[11px] font-medium shrink-0 ${isDone ? (failed ? 'text-amber-agent' : 'text-green-agent') : 'text-accent-bright'}`}>
          {phaseLabel(lane.phase)}
        </span>
      </div>

      <p className="text-xs text-text leading-snug line-clamp-2" title={lane.instruction}>
        {lane.instruction}
      </p>

      {lane.targetFiles && lane.targetFiles.length > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-text-dim min-w-0">
          <FileCode size={10} className="shrink-0" />
          <span className="truncate">{lane.targetFiles.join(', ')}</span>
        </div>
      )}

      {!isDone && lane.activity && (
        <p className="text-[10px] text-text-dim font-mono truncate" title={lane.activity}>
          {lane.lastTool ? `› ${lane.lastTool}` : lane.activity}
        </p>
      )}

      {isDone && lane.report && (
        <p className="text-[10px] text-text-muted leading-snug line-clamp-3">{lane.report}</p>
      )}
    </div>
  );
}
