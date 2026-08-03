import React from 'react';
import { useStore, type PlanRecord } from '../../store';
import { Check, Loader2, Circle, ClipboardList, ChevronRight } from '../Shared/icons';

/**
 * MAIN / AGENT — who authored a plan.
 *
 * The lead agent and a delegated worker both produce plans, and in a transcript
 * they used to be indistinguishable, which made a worker's three-step mini-plan
 * look like the lead had abandoned its own. The tag is the fix: it is always
 * present, always in the same place, and colour follows it rather than the
 * other way round.
 */
function OwnerTag({ owner }: { owner: PlanRecord['owner'] }) {
  const isMain = owner === 'main';
  return (
    <span
      className={`shrink-0 px-1.5 py-px rounded text-[9px] font-bold tracking-wider ${
        isMain ? 'bg-accent/20 text-accent-bright' : 'bg-violet-agent/20 text-violet-agent'
      }`}
    >
      {isMain ? 'MAIN' : 'AGENT'}
    </span>
  );
}

function StepIcon({ status }: { status: PlanRecord['steps'][number]['status'] }) {
  if (status === 'done') return <Check size={12} className="text-green-agent shrink-0" />;
  if (status === 'in_progress') return <Loader2 size={12} className="text-amber-agent animate-spin shrink-0" />;
  return <Circle size={12} className="text-text-dim shrink-0" />;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function PlanCard({ plan, index }: { plan: PlanRecord; index: number }) {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const active = plan.steps.find((s) => s.status === 'in_progress');
  const complete = done === plan.steps.length;
  // Finished plans start folded; the one still being worked stays open. Older
  // plans are history — you want to see THAT they happened, not re-read them.
  const [collapsed, setCollapsed] = React.useState(complete);
  React.useEffect(() => { setCollapsed(complete); }, [complete]);

  const jumpToAnchor = () => {
    if (!plan.anchorMessageId) return;
    document.getElementById(`msg-${plan.anchorMessageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className={`rounded-xl border ${plan.owner === 'agent' ? 'border-violet-agent/25 bg-violet-agent/[0.04]' : 'border-border bg-surface-2/50'}`}>
      <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-2 w-full px-2.5 py-2 text-left">
        <ChevronRight size={12} className={`shrink-0 text-text-dim transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        <OwnerTag owner={plan.owner} />
        <span className="text-xs text-text-muted truncate flex-1">
          {active ? active.title : plan.steps[0]?.title ?? 'Plan'}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-text-dim">{done}/{plan.steps.length}</span>
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2 space-y-1">
          {plan.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="mt-px"><StepIcon status={step.status} /></span>
              <span className={step.status === 'done' ? 'text-text-dim line-through' : 'text-text'}>
                {step.title}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1 text-[10px] text-text-dim">
            <span>plan {index + 1} · {timeLabel(plan.createdAt)}</span>
            {plan.anchorMessageId && (
              <button onClick={jumpToAnchor} className="text-accent-bright hover:underline">
                show in chat
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every plan this thread has produced, in the order it appeared.
 *
 * Plans used to live in a strip pinned above the input, which could only ever
 * show the newest one — so the moment a worker published its own plan, or the
 * lead revised its, the previous plan was simply gone. In a long run that is
 * most of the record of what the agent decided to do and why it changed course.
 * Here they accumulate: tagged by author, ordered, each linked back to the
 * point in the transcript where it appeared.
 */
export function PlansPanel() {
  const plans = useStore((s) => s.plans);

  if (plans.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-text-dim">
        <ClipboardList size={22} className="text-text-dim/60" />
        <p className="text-xs">No plans yet.</p>
        <p className="text-[11px] leading-relaxed max-w-[220px]">
          When the agent lays out steps for a task, each plan appears here — tagged MAIN or AGENT — so you can follow how the work was scoped.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2 space-y-2">
      {plans.map((plan, i) => <PlanCard key={plan.id} plan={plan} index={i} />)}
    </div>
  );
}
