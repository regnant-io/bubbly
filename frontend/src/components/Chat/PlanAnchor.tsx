import React from 'react';
import { useStore, type PlanRecord } from '../../store';
import { ClipboardList, ArrowRight } from '../Shared/icons';

/**
 * A one-line marker in the transcript saying "a plan appeared here".
 *
 * The plans themselves live in the Plans panel, but moving them there entirely
 * would lose something the panel can't express: WHEN, in the flow of the
 * conversation, the agent decided on them. A plan drawn up before any code was
 * read means something different from one drawn up after three files came back
 * unexpectedly. So the timeline keeps a marker — the tag, the first step, the
 * progress count — and clicking it opens the full plan in the panel.
 */
export function PlanAnchor({ plan }: { plan: PlanRecord }) {
  const openRightContext = useStore((s) => s.openRightContext);
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const active = plan.steps.find((s) => s.status === 'in_progress');
  const isMain = plan.owner === 'main';

  return (
    <button
      onClick={() => openRightContext('plans')}
      title="Open in the Plans panel"
      className="group flex items-center gap-2 my-1.5 py-0.5 text-xs text-left w-full animate-fade-in"
    >
      <ClipboardList size={11} className={`shrink-0 ${isMain ? 'text-accent-bright/70' : 'text-violet-agent/70'}`} />
      <span
        className={`shrink-0 px-1.5 py-px rounded text-[9px] font-bold tracking-wider ${
          isMain ? 'bg-accent/15 text-accent-bright' : 'bg-violet-agent/15 text-violet-agent'
        }`}
      >
        {isMain ? 'MAIN' : 'AGENT'}
      </span>
      <span className="text-text-dim shrink-0">Plan</span>
      <span className="text-text-muted truncate">
        · {active ? active.title : plan.steps[0]?.title ?? ''}
      </span>
      <span className="shrink-0 text-text-dim tabular-nums">{done}/{plan.steps.length}</span>
      <ArrowRight
        size={11}
        className="shrink-0 text-text-dim/50 opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </button>
  );
}
