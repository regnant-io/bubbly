import React from 'react';
import { ChevronRight, Loader2, Check } from './icons';
import { getToolDisplay, summariseSteps, activeStepLabel, segmentByPhase } from '../../utils/toolDisplay';

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
  /** Anything that belongs inside the group but is not a step — a context
   *  migration notice, say. Rendered after the last phase. */
  trailing?: React.ReactNode;
  /** Fallback for callers that have not moved to per-step nodes yet. */
  children?: React.ReactNode;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/**
 * One line of text that changes over time without the row moving.
 *
 * Keeps the previous label mounted for the length of the transition so the two
 * can cross: outgoing slides up and out, incoming slides up and in. See
 * `.slide-label` in animations.css for why this is a stacked, fixed-height box
 * rather than a simple text swap.
 */
function SlidingLabel({ text, className }: { text: string; className?: string }) {
  const [current, setCurrent] = React.useState(text);
  const [previous, setPrevious] = React.useState<string | null>(null);
  // A key that changes on every swap, so React restarts the CSS animation
  // instead of reusing an element whose animation has already finished.
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    if (text === current) return;
    setPrevious(current);
    setCurrent(text);
    setGeneration((g) => g + 1);
  }, [text, current]);

  React.useEffect(() => {
    if (previous === null) return;
    const t = setTimeout(() => setPrevious(null), 280);
    return () => clearTimeout(t);
  }, [previous, generation]);

  return (
    <span className="slide-label flex-1 min-w-0">
      {previous !== null && (
        <span key={`out-${generation}`} className={`slide-label__layer slide-label__layer--out ${className ?? ''}`}>
          {previous}
        </span>
      )}
      <span
        key={`in-${generation}`}
        className={`slide-label__layer ${previous !== null ? 'slide-label__layer--in' : ''} ${className ?? ''}`}
      >
        {current}
      </span>
    </span>
  );
}

/**
 * ONE PHASE OF A BURST.
 *
 * The heading says what this stretch of work WAS — "Building the backend",
 * "Working out what went wrong", "Fixing it" — and the steps that made it up
 * sit under it. That is the whole point of the redesign: a run of twenty steps
 * is unreadable as twenty steps and perfectly readable as four phases.
 *
 * A finished phase folds itself away; the one still running stays open, because
 * that is the only one anybody is watching. Clicking takes permanent control,
 * for the same reason it does everywhere else in the transcript.
 */
function PhaseSection({
  label,
  detail,
  inferred,
  steps,
  index,
  total,
}: {
  label: string;
  detail?: string;
  inferred: boolean;
  steps: ToolStepSummary[];
  index: number;
  total: number;
}) {
  const running = steps.some((s) => !s.done);
  const failed = steps.filter((s) => s.isError).length;
  const [open, setOpen] = React.useState(running);
  const userControlled = React.useRef(false);

  React.useEffect(() => {
    if (userControlled.current) return;
    // A phase that failed stays open even once it has finished: an error folded
    // away behind a tidy heading is the one thing the reader most needs.
    setOpen(running || failed > 0);
  }, [running, failed]);

  const additions = steps.reduce((n, s) => n + s.additions, 0);
  const deletions = steps.reduce((n, s) => n + s.deletions, 0);

  // With one phase and no label from the agent, the heading would be pure
  // chrome — the group header above already says the same thing.
  const headingWorthShowing = total > 1 || !inferred;

  return (
    <div className={index > 0 ? 'mt-1.5' : ''}>
      {headingWorthShowing && (
        <button
          onClick={() => { userControlled.current = true; setOpen((o) => !o); }}
          aria-expanded={open}
          className="group/phase flex items-center gap-1.5 w-full text-left h-5 text-[11px]"
        >
          <ChevronRight
            size={10}
            className={`shrink-0 text-text-dim/50 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="shrink-0 w-[10px] h-[10px] flex items-center justify-center">
            {running
              ? <Loader2 size={10} className="animate-spin text-accent-bright" />
              : failed > 0
              ? <span className="text-red-agent text-[10px] font-bold leading-none">!</span>
              : <Check size={10} className="text-text-dim/50" />}
          </span>
          <span
            className={`truncate ${
              running ? 'text-text font-medium' : inferred ? 'text-text-dim' : 'text-text-muted font-medium'
            }`}
            title={detail}
          >
            {label}
          </span>
          <span className="shrink-0 text-text-dim/60 tabular-nums">
            {steps.length}
          </span>
          {!running && (additions > 0 || deletions > 0) && (
            <span className="font-mono tabular-nums text-[10px] shrink-0">
              {additions > 0 && <span className="text-green-agent/70"> +{additions}</span>}
              {deletions > 0 && <span className="text-red-agent/70"> −{deletions}</span>}
            </span>
          )}
          {failed > 0 && (
            <span className="shrink-0 rounded px-1 text-[9px] font-medium bg-red-agent/12 text-red-agent tabular-nums">
              {failed} failed
            </span>
          )}
        </button>
      )}

      <div className={`${headingWorthShowing ? 'ml-[5px] pl-3 border-l border-hairline/20' : ''} ${open || !headingWorthShowing ? '' : 'hidden'}`}>
        {steps.map((s, i) => <React.Fragment key={i}>{s.node}</React.Fragment>)}
      </div>
    </div>
  );
}

/**
 * A run of consecutive tool calls, rendered as ONE collapsible block.
 *
 * Agentic work arrives in bursts — read three files, grep for a symbol, edit a
 * function, run the tests — and each of those steps can produce hundreds of
 * lines. Left expanded, a single burst pushes the question that prompted it and
 * the answer that follows it off opposite ends of the screen, and the
 * transcript stops being readable as a conversation.
 *
 * COLLAPSED IS THE DEFAULT, including while the burst is still running.
 *
 * Auto-expanding during a run was the wrong instinct. It meant the transcript
 * grew by hundreds of lines while the agent worked and then snapped shut when
 * it stopped — so the page you were reading was constantly being rewritten
 * underneath you, and the moment you scrolled up to read something it moved.
 * What the reader actually wants from a running burst is one line saying what
 * it is doing NOW, which is exactly what the collapsed header shows: a spinner,
 * a step count, and a headline that slides to the next step as it starts. The
 * detail has not gone anywhere — the header is a button, every step keeps its
 * full diff and output, and opening the group keeps it open.
 *
 * WHAT IS INSIDE, ONCE OPENED, IS PHASES — NOT A LIST OF STEPS.
 *
 * "18 steps" is an honest count and a useless summary. The same run described
 * as "Building the backend · 6 · Working out what went wrong · 3 · Fixing the
 * import · 5 · Verifying · 4" is the same information in the shape the reader
 * actually holds it in. The agent names the phases itself (set_phase, or a plan
 * step going in progress); where it did not, they are inferred from the shape
 * of the steps and rendered more quietly, because a guess should look like one.
 *
 * The one exception to collapsing is failure. A burst containing an error opens
 * itself, because hiding an error behind a tidy summary costs the reader the
 * single thing they most need to see.
 */
export function ToolStepGroup({ steps, durationMs, trailing, children }: ToolStepGroupProps) {
  const running = steps.some((s) => !s.done);
  const errored = steps.some((s) => s.isError);
  const [expanded, setExpanded] = React.useState(false);
  // Automatic disclosure yields permanently to the user the first time they
  // click — an opened group stays open even once it errors or finishes.
  const userControlled = React.useRef(false);

  React.useEffect(() => {
    if (userControlled.current) return;
    setExpanded(errored);
  }, [errored]);

  const failedCount = steps.filter((s) => s.isError).length;

  const toggle = () => { userControlled.current = true; setExpanded((e) => !e); };

  const additions = steps.reduce((n, s) => n + s.additions, 0);
  const deletions = steps.reduce((n, s) => n + s.deletions, 0);

  const phases = React.useMemo(() => segmentByPhase(steps), [steps]);

  /*
   * WHILE RUNNING, THE HEADER IS THE STEP IN FLIGHT — VERBATIM.
   *
   * The collapsed row used to compose its own sentence, "Implementing the
   * leaderboard — Using the browser", and the composition was the problem: the
   * phase half barely changes, so the line read as static while twenty steps
   * went past underneath it, and the half that WAS moving got the smaller share
   * of the row. The inner step lines already say the beautiful thing — "Pressed
   * ArrowRight", "Reading orchestrator.ts" — so the header simply shows that,
   * the same label the step will show when the group is opened. One title, in
   * both places, sliding to the next step as it starts.
   *
   * The phase has not been lost: it is the heading of the section the steps sit
   * under, which is where it belongs — it describes a stretch of work, not the
   * step happening right now.
   */
  const active = steps.find((s) => !s.done);
  const headline = active
    ? activeStepLabel(active.tool, active.args)
    : phases.length > 1
    ? phases.map((p) => p.phase.label).join(' → ')
    : summariseSteps(steps);

  /*
   * NOTHING IN THIS HEADER MAY CHANGE THE ROW'S GEOMETRY.
   *
   * A burst can add a step every few hundred milliseconds, and each addition
   * changes the count and the headline. If any of that resizes the row, the
   * whole transcript below it shifts — the "flinch". So:
   *   - the row has a fixed height (h-5) and the icon slot a fixed width, so a
   *     spinner becoming a tick cannot change either dimension;
   *   - the count is `tabular-nums` and reserves room for two digits, so 9 → 10
   *     does not widen it;
   *   - the headline lives in a fixed-height SlidingLabel that animates in
   *     place rather than reflowing;
   *   - the +/- and duration are only rendered when the burst has FINISHED,
   *     so they can never appear mid-run and push the headline sideways.
   */
  return (
    <div className="my-1.5">
      <button
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={`${steps.length} steps: ${headline}`}
        className="group flex items-center gap-1.5 w-full text-left h-5 text-xs"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-text-dim/60 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0 w-[11px] h-[11px] flex items-center justify-center">
          {running ? (
            <Loader2 size={11} className="animate-spin text-text-dim" />
          ) : (
            <Check size={11} className="text-text-dim/50 group-hover:text-green-agent transition-colors" />
          )}
        </span>

        <span className="text-text-dim tabular-nums shrink-0 min-w-[3.5rem]">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>

        {/*
          THE HEADER STAYS NEUTRAL WHEN A STEP FAILS.
          It used to turn the whole row red, which said "this burst went wrong"
          when what actually happened was that one call in eleven returned an
          error the agent then handled. Reading a red header, you go looking for
          a failure that isn't there. The count chip says exactly how much failed
          and the failing STEP is marked in its own line — the error is labelled
          where it happened, not where it is most visible.
        */}
        <SlidingLabel
          text={`· ${headline}${running ? '…' : ''}`}
          className={`text-text-muted ${running ? 'step-sweep' : ''}`}
        />


        {!running && failedCount > 0 && (
          <span
            className="shrink-0 rounded px-1 py-px text-[10px] font-medium bg-red-agent/12 text-red-agent tabular-nums"
            title={`${failedCount} of ${steps.length} steps returned an error`}
          >
            {failedCount} failed
          </span>
        )}

        {!running && (additions > 0 || deletions > 0) && (
          <span className="font-mono tabular-nums shrink-0">
            {additions > 0 && <span className="text-green-agent/80"> +{additions}</span>}
            {deletions > 0 && <span className="text-red-agent/80"> −{deletions}</span>}
          </span>
        )}
        {!running && durationMs !== undefined && durationMs >= 0 && (
          <span className="text-text-dim/50 tabular-nums shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            · {formatDuration(durationMs)}
          </span>
        )}
        <span className="text-text-dim/50 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {expanded ? 'hide' : 'show'}
        </span>
      </button>

      {/*
        Collapsing hides the body with CSS instead of unmounting it: reopening a
        group must show it exactly as you left it, including any step you had
        expanded by hand.
      */}
      <div className={`ml-[5px] pl-3 border-l border-border ${expanded ? '' : 'hidden'}`}>
        {children ?? phases.map((p, i) => (
          <PhaseSection
            key={`${p.phase.label}-${i}`}
            label={p.phase.label}
            detail={p.phase.detail}
            inferred={p.phase.source === 'inferred'}
            steps={p.steps}
            index={i}
            total={phases.length}
          />
        ))}
        {trailing}
      </div>
    </div>
  );
}
