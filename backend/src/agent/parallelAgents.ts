/**
 * Parallel delegation — run up to N worker agents at the same time, safely.
 *
 * Parallelism is powerful but dangerous: two agents editing the same file at
 * once corrupt each other's work, and interleaved output is unreadable. This
 * module makes parallel delegation SAFE by construction:
 *
 *   1. Hard cap on concurrency (default 4).
 *   2. File-disjointness: a batch may only run in parallel if every assignment
 *      declares target_files and NO file is claimed by two assignments. If that
 *      can't be guaranteed, we refuse and the caller runs the work serially.
 *   3. Lane isolation: every worker gets its own lane id; all of its streaming
 *      output is tagged with that lane so the UI can show each agent separately
 *      instead of one garbled stream.
 *   4. Approval serialization: only one human-approval prompt is shown at a
 *      time (a mutex), so concurrent workers don't race the approval UI.
 *
 * The actual file writes are atomic (temp-file + rename in filesystem.ts) and
 * the code index rebuilds synchronously, so once file-disjointness holds there
 * is no torn-write or mid-rebuild interleaving hazard.
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { runDelegatedAgent, DelegatedAgentResult } from './taskAgent';
import type { AgentConfig, WSServerEvent } from '../types';

export const MAX_PARALLEL_AGENTS = 4;

export interface ParallelAssignment {
  instruction: string;
  targetFiles?: string[];
  acceptance?: string;
}

export interface ParallelPlan {
  ok: boolean;
  reason?: string;
  /** Files claimed by more than one assignment (when ok === false). */
  conflicts?: string[];
}

/** Normalize a path for conflict comparison (slashes, case on Windows, trim). */
function normPath(p: string): string {
  let s = String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/**
 * Decide whether a batch of assignments may run in parallel. Pure + testable.
 * Requires 1..MAX assignments, each with a non-empty target_files set, and no
 * file claimed by two assignments.
 */
export function planParallelBatch(
  assignments: ParallelAssignment[],
  maxParallel: number = MAX_PARALLEL_AGENTS
): ParallelPlan {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return { ok: false, reason: 'No assignments provided.' };
  }
  if (assignments.length > maxParallel) {
    return { ok: false, reason: `Too many parallel assignments (${assignments.length}); the max is ${maxParallel}. Split into smaller batches.` };
  }
  for (const a of assignments) {
    if (!a || typeof a.instruction !== 'string' || a.instruction.trim() === '') {
      return { ok: false, reason: 'Every assignment needs a non-empty instruction.' };
    }
    if (!Array.isArray(a.targetFiles) || a.targetFiles.length === 0) {
      return {
        ok: false,
        reason:
          'Parallel delegation requires every assignment to declare target_files (so the agents can be proven not to touch the same files). ' +
          'Add target_files to each, or delegate them one at a time.',
      };
    }
  }

  // Detect files claimed by more than one assignment.
  const owner = new Map<string, number>();
  const conflicts = new Set<string>();
  assignments.forEach((a, idx) => {
    for (const f of a.targetFiles ?? []) {
      const key = normPath(f);
      if (owner.has(key) && owner.get(key) !== idx) conflicts.add(key);
      else owner.set(key, idx);
    }
  });
  if (conflicts.size > 0) {
    return {
      ok: false,
      reason: `These files are claimed by more than one assignment, which is unsafe to run in parallel: ${[...conflicts].join(', ')}. Make the assignments touch disjoint files, or run them sequentially.`,
      conflicts: [...conflicts],
    };
  }

  return { ok: true };
}

/** A simple async mutex so concurrent workers serialize their approval prompts. */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    // Keep the chain alive but swallow errors so one failure doesn't poison it.
    chain = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  };
}

export interface ParallelLaneResult extends DelegatedAgentResult {
  lane: string;
  instruction: string;
}

export interface RunParallelParams {
  config: AgentConfig;
  workspacePath: string;
  assignments: ParallelAssignment[];
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  maxParallel?: number;
  onEvent: (event: WSServerEvent) => void;
  requestApproval: (toolName: string, args: Record<string, unknown>, preview?: string) => Promise<boolean>;
  isStopped: () => boolean;
}

/**
 * Run a validated batch of assignments concurrently, each in its own lane.
 * The caller MUST have checked planParallelBatch().ok first.
 */
export async function runParallelDelegation(params: RunParallelParams): Promise<ParallelLaneResult[]> {
  const { config, workspacePath, assignments, onEvent, requestApproval, isStopped } = params;
  const maxParallel = Math.min(params.maxParallel ?? MAX_PARALLEL_AGENTS, MAX_PARALLEL_AGENTS);
  const batch = assignments.slice(0, maxParallel);
  const batchId = uuidv4();

  const approvalMutex = createMutex();

  logger.info('Starting parallel delegation', { batchId, count: batch.length });

  const runs = batch.map((assignment, index) => {
    const lane = uuidv4();
    onEvent({
      type: 'delegation_started',
      delegationId: lane,
      instruction: assignment.instruction,
      targetFiles: assignment.targetFiles,
      acceptance: assignment.acceptance,
      lane,
      laneIndex: index,
      parallel: true,
      batch: batchId,
    });

    // Tag every streaming event from this worker with its lane so the UI keeps
    // each agent's output in its own pane.
    const lanedOnEvent = (event: WSServerEvent): void => {
      const tagged = { ...event } as WSServerEvent & { lane?: string; laneIndex?: number };
      // Only tag the per-turn streaming/tool events; lifecycle events already
      // carry their own ids.
      tagged.lane = lane;
      tagged.laneIndex = index;
      onEvent(tagged);
    };

    return runDelegatedAgent({
      config,
      workspacePath,
      instruction: assignment.instruction,
      targetFiles: assignment.targetFiles,
      acceptance: assignment.acceptance,
      requireApprovalForWrites: params.requireApprovalForWrites,
      requireApprovalForShell: params.requireApprovalForShell,
      onEvent: lanedOnEvent,
      onProgress: (phase, detail) =>
        onEvent({ type: 'delegation_progress', delegationId: lane, phase, detail, lane, laneIndex: index }),
      // Serialize approvals across lanes so prompts don't race each other.
      requestApproval: (toolName, args, preview) => approvalMutex(() => requestApproval(toolName, args, preview)),
      isStopped,
    })
      .then((result): ParallelLaneResult => {
        onEvent({
          type: 'delegation_completed',
          delegationId: lane,
          report: result.report,
          filesTouched: result.filesTouched,
          validationOk: result.validationOk,
          lane,
          laneIndex: index,
        });
        return { ...result, lane, instruction: assignment.instruction };
      })
      .catch((err): ParallelLaneResult => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Parallel lane failed', { lane, error: message });
        onEvent({
          type: 'delegation_completed',
          delegationId: lane,
          report: `Worker failed: ${message}`,
          filesTouched: [],
          validationOk: false,
          lane,
          laneIndex: index,
        });
        return { lane, instruction: assignment.instruction, report: `Worker failed: ${message}`, filesTouched: [], diffs: [], validationOk: false };
      });
  });

  // One lane failing must not abort the others — each run already catches.
  return Promise.all(runs);
}
