import React, { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store';
import type { Spec, SpecTask } from '../../types';
import { CheckCircle, AlertCircle, Clock, Loader2, Check } from '../Shared/icons';

interface TaskQueueProps {
  specId?: string;
}

function getStatusColor(status: SpecTask['status']): string {
  switch (status) {
    case 'done':
      return 'text-green-agent';
    case 'in_progress':
      return 'text-blue-agent';
    case 'todo':
    default:
      return 'text-text-dim';
  }
}

function getStatusIcon(status: SpecTask['status']) {
  switch (status) {
    case 'done':
      return <CheckCircle size={16} className="text-green-agent" />;
    case 'in_progress':
      // A spinner should ALWAYS spin while in progress. Rendering a static
      // Loader2 (the old isActive-gated behavior) looked like a stuck spinner.
      return <Loader2 size={16} className="text-blue-agent animate-spin" />;
    case 'todo':
    default:
      return <AlertCircle size={16} className="text-text-dim" />;
  }
}

function phaseLabel(phase?: string): string | null {
  if (!phase) return null;
  switch (phase) {
    case 'dispatched': return 'Agent dispatched';
    case 'gathering_context': return 'Gathering context';
    case 'working': return 'Implementing';
    case 'validating': return 'Validating';
    case 'repairing': return 'Repairing';
    case 'verifying': return 'Verifying';
    case 'done': return 'Verified';
    case 'retry': return 'Needs another pass';
    default: return phase;
  }
}

function TaskItem({ task, isActive, phase, detail }: { task: SpecTask; isActive: boolean; phase?: string; detail?: string }) {
  const label = phaseLabel(phase);
  return (
    <div
      className={`
        flex items-start gap-3 p-3 rounded-lg border transition-all
        ${isActive ? 'border-blue-agent bg-blue-agent/5 shadow-sm' : 'border-border bg-surface-2'}
        ${task.status === 'done' ? 'opacity-60' : ''}
      `}
    >
      <div className="shrink-0 mt-0.5">
        {getStatusIcon(task.status)}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${getStatusColor(task.status)}`}>
          {task.title}
        </div>
        {task.targetFiles && task.targetFiles.length > 0 && (
          <div className="text-xs text-text-dim font-mono mt-0.5 truncate">
            {task.targetFiles.join(', ')}
          </div>
        )}
        {task.subTasks && task.subTasks.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {task.subTasks.map((st) => (
              <div key={st.id} className="flex items-center gap-1.5 text-xs text-text-dim">
                <span className={
                  st.status === 'done' ? 'text-green-agent' :
                  st.status === 'in_progress' ? 'text-blue-agent' : ''
                }>
                  {st.status === 'done' ? '✓' : st.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span>{st.title}</span>
              </div>
            ))}
          </div>
        )}
        {task.status === 'in_progress' && label && (
          <div className="text-xs text-blue-agent mt-1 flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" />
            <span>{label}{detail ? `: ${detail}` : '…'}</span>
          </div>
        )}
        {task.status === 'done' && task.verificationNote && (
          <div className="text-xs text-green-agent/70 mt-0.5 truncate"><Check size={11} className="inline" /> {task.verificationNote}</div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-muted">Progress</span>
        <span className="text-text font-medium">
          {completed}/{total} tasks ({percentage}%)
        </span>
      </div>
      <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function EstimatedTime({ completed, total, avgTimePerTask }: { completed: number; total: number; avgTimePerTask: number }) {
  const remaining = total - completed;
  const estimatedMs = remaining * avgTimePerTask;
  
  if (remaining === 0 || avgTimePerTask === 0) {
    return null;
  }

  const minutes = Math.ceil(estimatedMs / 60000);
  const timeText = minutes < 60 
    ? `~${minutes} min remaining`
    : `~${Math.ceil(minutes / 60)} hr remaining`;

  return (
    <div className="text-xs text-text-dim flex items-center gap-1">
      <Clock size={12} />
      <span>{timeText}</span>
    </div>
  );
}

export function TaskQueue({ specId: propSpecId }: TaskQueueProps) {
  const { specs, sessions, currentSessionId, taskProgress } = useStore();
  const [currentTaskIndex, setCurrentTaskIndex] = useState<number>(-1);
  const [avgTimePerTask] = useState<number>(120000); // Default: 2 minutes per task

  // Determine which spec to display
  const currentSession = sessions.find(s => s.id === currentSessionId);
  const specId = propSpecId || currentSession?.specId;
  // Fall back to the most recently updated spec if no session mapping exists yet
  const spec = specs.find(s => s.id === specId)
    || (specs.length > 0 ? [...specs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined);

  // Find the currently executing task
  useEffect(() => {
    if (!spec) return;
    
    const inProgressIndex = spec.tasks.findIndex(t => t.status === 'in_progress');
    setCurrentTaskIndex(inProgressIndex);
  }, [spec]);

  if (!spec) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-accent-bright" />
            <span className="text-sm font-medium text-text">Task Queue</span>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-text-dim text-sm">
            <CheckCircle size={24} className="mx-auto mb-2 opacity-30" />
            <p>No active spec</p>
            <p className="text-xs mt-1">
              Start a Spec Session to see tasks
            </p>
          </div>
        </div>
      </div>
    );
  }

  const completedTasks = spec.tasks.filter(t => t.status === 'done').length;
  const totalTasks = spec.tasks.length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <CheckCircle size={14} className="text-accent-bright" />
          <span className="text-sm font-medium text-text">Task Queue</span>
          <span className="tag bg-accent/15 text-accent-bright text-xs">
            {completedTasks}/{totalTasks}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Spec Title */}
        <div className="pb-3 border-b border-border">
          <h3 className="text-sm font-medium text-text mb-1">{spec.title}</h3>
          <div className="flex items-center gap-2 text-xs">
            <span className={`tag ${
              spec.type === 'feature' ? 'text-accent-bright' :
              spec.type === 'bugfix' ? 'text-red-agent' :
              spec.type === 'refactor' ? 'text-amber-agent' :
              'text-blue-agent'
            }`}>
              {spec.type}
            </span>
            <span className={`tag ${
              spec.status === 'done' ? 'text-green-agent bg-success-bg' :
              spec.status === 'in_progress' ? 'text-blue-agent bg-info-bg' :
              'text-text-dim bg-surface-3'
            }`}>
              {spec.status}
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <ProgressBar completed={completedTasks} total={totalTasks} />

        {/* Estimated Time */}
        {spec.status === 'in_progress' && (
          <EstimatedTime 
            completed={completedTasks} 
            total={totalTasks} 
            avgTimePerTask={avgTimePerTask}
          />
        )}

        {/* Task List */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide">
            Tasks
          </h4>
          {spec.tasks.map((task, index) => (
            <TaskItem
              key={task.id}
              task={task}
              isActive={index === currentTaskIndex}
              phase={taskProgress[task.id]?.phase}
              detail={taskProgress[task.id]?.detail}
            />
          ))}
        </div>

        {/* Completion Message */}
        {completedTasks === totalTasks && totalTasks > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-success-bg border border-green-agent/40">
            <div className="flex items-center gap-2 text-sm text-green-agent">
              <CheckCircle size={16} />
              <span className="font-medium">All tasks completed!</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
