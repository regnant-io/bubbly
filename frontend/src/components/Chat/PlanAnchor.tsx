import React from 'react';
import { useStore, type PlanRecord } from '../../store';
import { ListChecks, ArrowRight } from '../Shared/icons';

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

  const title = active ? active.title : plan.steps.find((s) => s.status !== 'done')?.title ?? plan.steps[plan.steps.length - 1]?.title ?? '';
  const allDone = plan.steps.length > 0 && done === plan.steps.length;

  // A step of the trail, not a badge: the plan is part of the work's story.
  return (
    <div className="tl tl--single">
      <div
        className="tl-row is-interactive plan-anchor"
        role="button"
        tabIndex={0}
        onClick={() => openRightContext('plans')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRightContext('plans'); } }}
        title="Open in the Plans panel"
      >
        <span className="tl-glyph" aria-hidden="true"><ListChecks size={13} strokeWidth={1.75} /></span>
        <span className="tl-line">
          <span className="tl-verb">{isMain ? 'Plan' : 'Worker plan'}</span>
          <span className="tl-target">{allDone ? 'All steps done' : title}</span>
          {plan.steps.length <= 12 && <span className="plan-progress" aria-label={`${done} of ${plan.steps.length} steps done`}>
            {plan.steps.map((st, i) => (
              <i key={i} className={st.status === 'done' ? 'is-done' : st.status === 'in_progress' ? 'is-active' : ''} />
            ))}
          </span>}
          <span className="tl-meta tabular-nums">{done}/{plan.steps.length}</span>
        </span>
        <span className="tl-aside"><ArrowRight size={12} /></span>
      </div>
    </div>
  );
}
