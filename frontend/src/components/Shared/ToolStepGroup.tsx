import React from 'react';
import { ChevronRight } from './icons';
import { activeStepLabel, describeBurst, segmentByPhase } from '../../utils/toolDisplay';
import { formatDuration } from './ToolIndicator';

export interface ToolStepSummary {
  /** Tool name, e.g. "edit_file". */
  tool: string;
  args?: Record<string, unknown>;
  done: boolean;
  isError: boolean;
  additions: number;
  deletions: number;
  /** What the agent said it was doing when it made this call, if it said. */
  phase?: { label: string; detail?: string; source: 'agent' | 'plan' };
  /** The rendered step line. Held here so the group can lay the steps out
   *  under their phase headings instead of receiving one opaque blob. */
  node?: React.ReactNode;
}

interface ToolStepGroupProps {
  steps: ToolStepSummary[];
  /** Total wall time across the run of steps, when all of them have finished. */
  durationMs?: number;
  /**
   * Is this the burst the agent is working in RIGHT NOW?
   *
   * Decided by the transcript (the run is going and nothing but steps has come
   * after this burst), never from the steps themselves: between two tool calls
   * every step IS done while the model thinks about the next one, and a burst
   * that folded on "all done" flapped shut and open on every call.
   */
  live?: boolean;
  /** Anything that belongs inside the group but is not a step — a context
   *  migration notice, say. Rendered after the last phase. */
  trailing?: React.ReactNode;
  /** Fallback for callers that have not moved to per-step nodes yet. */
  children?: React.ReactNode;
}

/**
 * A disclosure that follows the work until the user takes it over.
 *
 * `auto` is what the transcript wants right now; the first click hands the
 * state to the user permanently, so nothing they opened to read snaps shut
 * under them when the run moves on.
 */
function useFollowingDisclosure(auto: boolean) {
  const [open, setOpen] = React.useState(auto);
  const userControlled = React.useRef(false);
  React.useEffect(() => {
    if (!userControlled.current) setOpen(auto);
  }, [auto]);
  const toggle = React.useCallback(() => {
    userControlled.current = true;
    setOpen((o) => !o);
  }, []);
  return [open, toggle] as const;
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="tl-diffstat">
      {additions > 0 && <span className="is-add">+{additions}</span>}
      {deletions > 0 && <span className="is-del">−{deletions}</span>}
    </span>
  );
}

/**
 * ONE PHASE OF A BURST: what this stretch of work WAS, with its steps under it.
 *
 * Twenty steps are unreadable as twenty steps and perfectly readable as four
 * phases. The agent names them (set_phase, or a plan step going in progress);
 * where it did not, a label is inferred from the shape of the steps and drawn
 * more quietly, because a guess should read as one.
 */
function PhaseSection({
  label, detail, inferred, steps, current, showHeading,
}: {
  label: string;
  detail?: string;
  inferred: boolean;
  steps: ToolStepSummary[];
  /** The phase the live burst is in. Older phases fold themselves away. */
  current: boolean;
  showHeading: boolean;
}) {
  const failed = steps.filter((s) => s.isError).length;
  const [open, toggle] = useFollowingDisclosure(current);
  const additions = steps.reduce((n, s) => n + s.additions, 0);
  const deletions = steps.reduce((n, s) => n + s.deletions, 0);

  // Same tree with or without a heading, and closed means hidden, not
  // unmounted — so a phase gaining its heading (a second step arrived) or being
  // folded never throws away a step the reader had opened.
  return (
    <div className={`tl-phase ${open ? 'is-open' : ''} ${inferred ? 'is-inferred' : ''}`}>
      {showHeading && (
        <button className="tl-phase-row" onClick={toggle} aria-expanded={open} title={detail}>
          <span className="tl-phase-node" aria-hidden="true" />
          <span className="tl-phase-label">{label}</span>
          <span className="tl-count tabular-nums">{steps.length}</span>
          {failed > 0 && <span className="tl-failed">{failed} failed</span>}
          {!open && <DiffStat additions={additions} deletions={deletions} />}
          <ChevronRight size={12} className="tl-caret" />
        </button>
      )}
      <div className="tl-phase-steps" hidden={showHeading && !open}>
        {steps.map((s, i) => <React.Fragment key={i}>{s.node}</React.Fragment>)}
      </div>
    </div>
  );
}

/**
 * A RUN OF CONSECUTIVE TOOL CALLS, AS ONE QUIET TRAIL.
 *
 * Folded, it is one sentence of what happened —
 *
 *   ›  Explored 6 files, edited 3 files, ran 2 commands   +48 −12   1m 04s
 *
 * — and open, a timeline: each step a single line hanging off a hairline rail,
 * grouped under the phases the agent named. No card, no nested card, no
 * per-tool colour. The transcript's prose stays the loudest thing on screen.
 *
 * While the agent is working IN this burst it stays open and follows along,
 * with finished phases folding behind their headings so the live one is always
 * in view. When the burst ends (prose follows, or the run stops) it folds back
 * to its sentence. A single step is shown as its own line with no header: a
 * summary of one thing is just that thing again.
 */
export function ToolStepGroup({ steps, durationMs, live = false, trailing, children }: ToolStepGroupProps) {
  const [open, toggle] = useFollowingDisclosure(live);
  const phases = React.useMemo(() => segmentByPhase(steps), [steps]);

  const failed = steps.filter((s) => s.isError).length;
  const additions = steps.reduce((n, s) => n + s.additions, 0);
  const deletions = steps.reduce((n, s) => n + s.deletions, 0);
  const summary = React.useMemo(() => describeBurst(steps), [steps]);

  const lastPhase = phases[phases.length - 1];
  const active = steps.find((s) => !s.done);
  const agentNamed = phases.some((p) => p.phase.source !== 'inferred');

  const body = (
    <div className="tl-list">
      {children ?? phases.map((p, i) => (
        <PhaseSection
          key={`${p.phase.label}-${i}`}
          label={p.phase.label}
          detail={p.phase.detail}
          inferred={p.phase.source === 'inferred'}
          steps={p.steps}
          current={i === phases.length - 1}
          // One inferred phase is pure chrome — the head already says it; and a
          // lone step is shown as itself, heading-free.
          showHeading={steps.length > 1 && (phases.length > 1 || agentNamed)}
        />
      ))}
      {trailing}
    </div>
  );

  // A lone step is shown as itself. The tree below is the SAME shape either
  // way (the head is a slot that may be empty), so when a second step arrives
  // the first is not remounted — it does not flash or lose its disclosure.
  const single = steps.length === 1 && !trailing;

  return (
    <section className={`tl ${single ? 'tl--single' : ''} ${open ? 'is-open' : ''} ${live ? 'is-live' : ''}`}>
      {!single && (
      <button
        className="tl-head"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`${steps.length} steps: ${summary}`}
      >
        <ChevronRight size={13} className="tl-caret" />
        {live ? (
          <span className="tl-head-text">
            <span className="tl-head-title">{lastPhase?.phase.label ?? 'Working'}</span>
            <span className="tl-head-now sheen-text">
              {active ? activeStepLabel(active.tool, active.args) : 'Thinking about the next step'}
            </span>
          </span>
        ) : (
          <span className="tl-head-text">
            <span className="tl-head-title">{summary}</span>
          </span>
        )}
        {!live && failed > 0 && (
          <span className="tl-failed" title={`${failed} of ${steps.length} steps returned an error`}>
            {failed} failed
          </span>
        )}
        {!live && <DiffStat additions={additions} deletions={deletions} />}
        <span className="tl-aside">
          <span className="tabular-nums">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          {!live && durationMs !== undefined && durationMs >= 0 && (
            <span className="tabular-nums">{formatDuration(durationMs)}</span>
          )}
        </span>
      </button>
      )}
      {/* Hidden rather than unmounted: reopening shows the trail exactly as it
          was left, including any step opened by hand. */}
      <div className="tl-drawer" hidden={!single && !open}>{body}</div>
    </section>
  );
}
