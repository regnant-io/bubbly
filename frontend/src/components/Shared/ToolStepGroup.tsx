import React from 'react';
import { ChevronRight, Loader2, Check } from './icons';
import { getToolDisplay } from '../../utils/toolDisplay';

export interface ToolStepSummary {
  /** Tool name, e.g. "edit_file". */
  tool: string;
  args?: Record<string, unknown>;
  done: boolean;
  isError: boolean;
  additions: number;
  deletions: number;
}

interface ToolStepGroupProps {
  steps: ToolStepSummary[];
  /** Total wall time across the run of steps, when all of them have finished. */
  durationMs?: number;
  children: React.ReactNode;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/**
 * Collapse a run of steps into the shortest phrase that still says what
 * happened: "3 read · 2 edited" rather than a list of five filenames nobody
 * reads. Verbs come from the same table the individual step lines use, so the
 * summary and the expanded detail never disagree about what a tool is called.
 */
function summarise(steps: ToolStepSummary[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) {
    const verb = getToolDisplay(s.tool, s.args).past.toLowerCase();
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([verb, n]) => (n > 1 ? `${n} ${verb}` : verb));
  const shown = parts.join(' · ');
  return counts.size > 3 ? `${shown} · …` : shown;
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
 * The one exception is failure. A burst containing an error opens itself,
 * because hiding an error behind a tidy summary costs the reader the single
 * thing they most need to see.
 */
export function ToolStepGroup({ steps, durationMs, children }: ToolStepGroupProps) {
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

  const toggle = () => { userControlled.current = true; setExpanded((e) => !e); };

  /*
   * EVERY run gets a header, including a run of one.
   *
   * Hiding it for a single step used to be the tidier choice, because the step's
   * own line said the same thing. It stops being tidy the moment the default is
   * collapsed: a lone step would render its full detail, and then the instant a
   * second step arrived the header would appear and both would fold away — the
   * line you were reading vanishing as a direct result of the agent making
   * progress. Showing the header from the first step means growing a run only
   * ever increments a counter and slides a label. Nothing appears in order to
   * be taken away again.
   */
  const showHeader = true;

  const additions = steps.reduce((n, s) => n + s.additions, 0);
  const deletions = steps.reduce((n, s) => n + s.deletions, 0);
  // While running, the header tracks the step actually in flight.
  const active = steps.find((s) => !s.done);
  const headline = active
    ? getToolDisplay(active.tool, active.args).gerund
    : summarise(steps);

  /*
   * The element tree here is CONSTANT — the header is a sibling that appears,
   * and the steps always live in the same wrapper div whose classes change.
   *
   * That is deliberate and load-bearing. Returning `<>{children}</>` for a run
   * of one and a nested structure for a run of two moves the steps to a
   * different position in the tree, so React unmounts and remounts them: the
   * step you were reading blinks, and any step you had manually expanded snaps
   * shut. Keeping one shape means growing a run only ever adds a line.
   *
   * Collapsing hides the wrapper with CSS instead of unmounting it, for the
   * same reason — reopening a group should show it exactly as you left it.
   */
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
        className={`group flex items-center gap-1.5 w-full text-left h-5 text-xs ${showHeader ? '' : 'hidden'}`}
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-text-dim/60 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0 w-[11px] h-[11px] flex items-center justify-center">
          {running ? (
            <Loader2 size={11} className="animate-spin text-text-dim" />
          ) : errored ? (
            <span className="text-red-agent font-bold leading-none">!</span>
          ) : (
            <Check size={11} className="text-text-dim/50 group-hover:text-green-agent transition-colors" />
          )}
        </span>

        <span className="text-text-dim tabular-nums shrink-0 min-w-[3.5rem]">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>

        <SlidingLabel
          text={`· ${headline}${running ? '…' : ''}`}
          className={`${errored ? 'text-red-agent/90' : 'text-text-muted'} ${running ? 'shimmer-text' : ''}`}
        />

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

      <div
        className={
          showHeader
            ? `ml-[5px] pl-3 border-l border-border ${expanded ? '' : 'hidden'}`
            : ''
        }
      >
        {children}
      </div>
    </div>
  );
}
