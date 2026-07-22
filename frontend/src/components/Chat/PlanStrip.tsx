import React, { useState } from 'react';
import { ChevronRight, Check, Loader2, Circle, Bot, ClipboardList } from '../Shared/icons';

export interface PlanStep {
  title: string;
  status: 'todo' | 'in_progress' | 'done';
}

interface PlanStripProps {
  label: string;
  owner: 'main' | 'worker';
  steps: PlanStep[];
  /** Controlled collapse (optional). When omitted the strip manages its own. */
  collapsed?: boolean;
  onToggle?: () => void;
}

/**
 * Collapsible plan/todo strip shown above the input. Tagged by owner so the
 * lead's plan ("Plan") and a worker sub-agent's mini-plan ("Worker plan") are
 * visually distinct and never confused. The worker strip uses a subtler accent
 * so the main plan stays primary.
 */
export function PlanStrip({ label, owner, steps, collapsed, onToggle }: PlanStripProps) {
  const [localCollapsed, setLocalCollapsed] = useState(owner === 'worker');
  const isCollapsed = collapsed ?? localCollapsed;
  const toggle = onToggle ?? (() => setLocalCollapsed((c) => !c));

  const done = steps.filter((s) => s.status === 'done').length;
  const active = steps.find((s) => s.status === 'in_progress');
  const isWorker = owner === 'worker';

  return (
    <div
      className={`mx-auto w-full max-w-3xl rounded-xl border px-3 py-2 ${
        isWorker ? 'border-violet-agent/30 bg-violet-agent/[0.05]' : 'border-border bg-surface-1'
      }`}
    >
      <button onClick={toggle} className="flex items-center gap-2 w-full text-left">
        <ChevronRight size={12} className={`text-text-dim transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
        {isWorker ? <Bot size={12} className="text-violet-agent shrink-0" /> : <ClipboardList size={12} className="text-text-dim shrink-0" />}
        <span className={`text-xs font-medium uppercase tracking-wide ${isWorker ? 'text-violet-agent' : 'text-text-dim'}`}>
          {label}
        </span>
        <span className="text-xs text-text-dim">{done}/{steps.length}</span>
        {isCollapsed && active && (
          <span className="text-xs text-text-muted truncate ml-1">· {active.title}</span>
        )}
      </button>

      {!isCollapsed && (
        <div className="space-y-1 mt-1.5 max-h-40 overflow-y-auto">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={
                step.status === 'done' ? 'text-green-agent' :
                step.status === 'in_progress' ? 'text-amber-agent' : 'text-text-dim'
              }>
                {step.status === 'done'
                  ? <Check size={12} />
                  : step.status === 'in_progress'
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Circle size={12} />}
              </span>
              <span className={step.status === 'done' ? 'text-text-dim line-through' : 'text-text'}>
                {step.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
