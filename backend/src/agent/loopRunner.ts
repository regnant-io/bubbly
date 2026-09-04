/**
 * Running the agent repeatedly towards a goal.
 *
 * WHY THIS IS NOT JUST "SEND THE PROMPT AGAIN"
 *
 * The naive loop — call the agent, wait, call it again — fails in three ways
 * that all look the same from outside (nothing useful happens for an hour):
 *
 *  1. IT NEVER STOPS. The model says "done" and the loop asks again, so the
 *     agent invents work. A loop needs a stop condition that is CHECKED, and an
 *     agent able to end it.
 *  2. IT GOES IN CIRCLES. Round 4 undoes round 3 because neither round knew
 *     what the other did. Each round has to start from observed state, and the
 *     loop has to notice when rounds stop producing progress.
 *  3. IT RUNS FOREVER ON A BROKEN PREMISE. A goal that cannot be met — a
 *     missing credential, a decision only the user can make — burns the whole
 *     budget re-discovering the same blocker.
 *
 * So a loop here has: two independent budgets (rounds and wall-clock), a
 * stop condition the agent reports against explicitly, stall detection, and a
 * hard stop the user controls. Every round is a normal agent run, which means
 * everything else — approvals, watchers, compaction, the Stop button — works
 * unchanged.
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { runAgentLoop } from './orchestrator';
import { loadPlan, summarizePlan } from './planManager';
import type { ThreadType, WSServerEvent } from '../types';

export interface LoopSpec {
  goal: string;
  /** A checkable condition. Reported back to the agent each round. */
  stopWhen?: string;
  maxIterations: number;
  maxMinutes: number;
}

export interface LoopState {
  id: string;
  sessionId: string;
  spec: LoopSpec;
  iteration: number;
  startedAt: number;
  status: 'running' | 'met' | 'exhausted' | 'stalled' | 'stopped' | 'failed';
  /** The agent's closing summary from each round, newest last. */
  reports: string[];
  stopRequested: boolean;
}

const loops = new Map<string, LoopState>();

/** Loops keyed by the session they drive, so Stop can find one. */
const loopsBySession = new Map<string, string>();

export function activeLoopFor(sessionId: string): LoopState | undefined {
  const id = loopsBySession.get(sessionId);
  return id ? loops.get(id) : undefined;
}

export function stopLoop(sessionId: string): boolean {
  const loop = activeLoopFor(sessionId);
  if (!loop) return false;
  loop.stopRequested = true;
  logger.info('Loop stop requested', { loopId: loop.id, sessionId });
  return true;
}

/**
 * Phrases an agent uses when it believes the goal is met.
 *
 * Deliberately narrow. A loose match ("done" anywhere in the text) ends the loop
 * the first time the agent writes "I'm done reading the file", which is the most
 * annoying possible failure — it looks like the loop simply gave up.
 */
const COMPLETION_PATTERNS = [
  /\bgoal (?:is )?(?:now )?met\b/i,
  /\bthe goal is complete\b/i,
  /\bnothing (?:left|more) to do\b/i,
  /\bstopping (?:here|now)\b.*\b(?:met|complete|done|passing)\b/i,
  /\ball tests? (?:now )?pass(?:ing|es)?\b/i,
  /\bloop can stop\b/i,
];

const BLOCKED_PATTERNS = [
  /\bblocked (?:on|by)\b/i,
  /\bcannot (?:proceed|continue)\b/i,
  /\bneed(?:s)? (?:a )?(?:decision|access|credential|permission) from (?:you|the user)\b/i,
  /\bwaiting (?:on|for) (?:you|the user)\b/i,
];

export function looksComplete(text: string): boolean {
  return COMPLETION_PATTERNS.some((p) => p.test(text));
}

export function looksBlocked(text: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(text));
}

/**
 * Has this round made progress?
 *
 * Compared on the PLAN, not on the prose. An agent's summary always sounds like
 * progress — that is what summaries do — whereas the plan is a structured
 * statement of what is actually finished. Two rounds with an unchanged plan and
 * no file changes is a stall.
 */
function progressSignature(sessionId: string, diffCount: number): string {
  const plan = loadPlan(sessionId);
  return `${summarizePlan(plan)}::${diffCount}`;
}

export interface RunLoopParams {
  sessionId: string;
  workspacePath: string;
  threadType?: ThreadType;
  specId?: string;
  spec: LoopSpec;
  /** The first round's prompt — the workflow's full instructions. */
  initialPrompt: string;
  onEvent: (event: WSServerEvent) => void;
}

/**
 * Drive a loop to completion.
 *
 * Resolves when the loop ends for any reason. Never throws for an ordinary
 * failure — a round that errors is reported and the loop decides whether to
 * continue, because one bad round is not a reason to abandon an hour of budget.
 */
export async function runLoop(params: RunLoopParams): Promise<LoopState> {
  const { sessionId, workspacePath, spec } = params;

  const state: LoopState = {
    id: `loop_${uuidv4().slice(0, 8)}`,
    sessionId,
    spec,
    iteration: 0,
    startedAt: Date.now(),
    status: 'running',
    reports: [],
    stopRequested: false,
  };
  loops.set(state.id, state);
  loopsBySession.set(sessionId, state.id);

  const deadline = state.startedAt + spec.maxMinutes * 60_000;
  let lastSignature = '';
  let stallCount = 0;
  let consecutiveErrors = 0;

  const announce = (event: WSServerEvent) => params.onEvent(event);

  announce({
    type: 'loop_started',
    loopId: state.id,
    goal: spec.goal,
    maxIterations: spec.maxIterations,
    maxMinutes: spec.maxMinutes,
  } as WSServerEvent);

  logger.info('Loop started', {
    loopId: state.id,
    sessionId,
    goal: spec.goal,
    maxIterations: spec.maxIterations,
    maxMinutes: spec.maxMinutes,
  });

  try {
    while (state.iteration < spec.maxIterations) {
      if (state.stopRequested) { state.status = 'stopped'; break; }
      if (Date.now() > deadline) { state.status = 'exhausted'; break; }

      state.iteration += 1;
      const remainingMinutes = Math.max(0, Math.round((deadline - Date.now()) / 60_000));

      announce({
        type: 'loop_iteration',
        loopId: state.id,
        iteration: state.iteration,
        maxIterations: spec.maxIterations,
        remainingMinutes,
      } as WSServerEvent);

      // The first round carries the workflow's full instructions; later rounds
      // carry a short continuation that re-states the goal, the budget and what
      // the previous round reported. Re-sending the full brief every round would
      // cost thousands of tokens to say what the agent has already internalised.
      const prompt = state.iteration === 1
        ? params.initialPrompt
        : buildContinuation(state, remainingMinutes);

      let roundText = '';
      let diffCount = 0;
      let errored = false;

      try {
        await runAgentLoop({
          sessionId,
          userMessage: prompt,
          workspacePath,
          threadType: params.threadType,
          specId: params.specId,
          trigger: 'loop',
          onEvent: (event) => {
            // Collect the round's own signals while forwarding everything, so
            // the client sees a loop round exactly as it sees a normal turn.
            if (event.type === 'message' && event.content) roundText += `\n${event.content}`;
            if (event.type === 'diff') diffCount += event.files.length;
            if (event.type === 'error') errored = true;
            // A loop's rounds are not separate runs to the user — swallow the
            // per-round `done` so the composer does not flicker back to idle
            // between rounds. The loop emits its own completion at the end.
            if (event.type === 'done') return;
            announce(event);
          },
        });
      } catch (err) {
        errored = true;
        roundText += `\n[round failed: ${err instanceof Error ? err.message : String(err)}]`;
        logger.warn('Loop round threw', { loopId: state.id, iteration: state.iteration, error: String(err) });
      }

      state.reports.push(roundText.trim().slice(-2000));

      if (state.stopRequested) { state.status = 'stopped'; break; }

      // --- Decide whether to keep going ---------------------------------

      if (looksComplete(roundText)) {
        state.status = 'met';
        break;
      }
      if (looksBlocked(roundText)) {
        // Blocked is not failure — it is the loop correctly declining to burn
        // its budget on something it cannot resolve without the user.
        state.status = 'stalled';
        break;
      }

      if (errored) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          state.status = 'failed';
          break;
        }
      } else {
        consecutiveErrors = 0;
      }

      const signature = progressSignature(sessionId, diffCount);
      if (signature === lastSignature && diffCount === 0) {
        stallCount += 1;
        // Two rounds that changed neither the plan nor a file means the approach
        // is not working. Continuing spends the remaining budget re-learning
        // that, and the user would rather have the time back.
        if (stallCount >= 2) {
          state.status = 'stalled';
          break;
        }
      } else {
        stallCount = 0;
      }
      lastSignature = signature;
    }

    if (state.status === 'running') state.status = 'exhausted';
  } finally {
    loopsBySession.delete(sessionId);
  }

  const elapsedMinutes = Math.round((Date.now() - state.startedAt) / 60_000);
  logger.info('Loop finished', {
    loopId: state.id, status: state.status, iterations: state.iteration, elapsedMinutes,
  });

  announce({
    type: 'loop_finished',
    loopId: state.id,
    status: state.status,
    iterations: state.iteration,
    elapsedMinutes,
    summary: describeOutcome(state, elapsedMinutes),
  } as WSServerEvent);

  // The loop as a whole is one unit of work to the client, so `done` is emitted
  // once, here — not once per round.
  announce({ type: 'done', sessionId });

  return state;
}

/** The short brief that starts every round after the first. */
function buildContinuation(state: LoopState, remainingMinutes: number): string {
  const previous = state.reports[state.reports.length - 1] ?? '';
  return `[loop round ${state.iteration} of ${state.spec.maxIterations} · about ${remainingMinutes} minute(s) of budget left]

Goal: ${state.spec.goal}
${state.spec.stopWhen ? `Done means: ${state.spec.stopWhen}\n` : ''}
What the previous round reported:
${previous || '(nothing)'}

Start by CHECKING the current state rather than trusting that summary — run the check, read the file, look at what is actually there. Then do the next most valuable thing and verify it.

If the goal is met, say so explicitly and stop. If you are blocked on something only the user can resolve, say what and stop. Do not repeat an action that already failed.`;
}

function describeOutcome(state: LoopState, elapsedMinutes: number): string {
  const rounds = `${state.iteration} round${state.iteration === 1 ? '' : 's'} over ${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'}`;
  switch (state.status) {
    case 'met':
      return `Goal reached after ${rounds}.`;
    case 'stopped':
      return `Stopped by you after ${rounds}.`;
    case 'stalled':
      return `Stopped after ${rounds}: the last rounds made no measurable progress, or the agent reported being blocked. Continuing would have spent the remaining budget without moving the goal.`;
    case 'failed':
      return `Stopped after ${rounds}: three rounds in a row failed. The error from the last round is above.`;
    case 'exhausted':
    default:
      return `Budget spent after ${rounds} without meeting the goal. The work done so far is kept — start another loop to continue.`;
  }
}

/** Every loop this process has run, newest first. For diagnostics. */
export function listLoops(): LoopState[] {
  return [...loops.values()].sort((a, b) => b.startedAt - a.startedAt);
}
