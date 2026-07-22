/**
 * Spec Orchestrator — drives a spec to completion by DISPATCHING task agents.
 *
 * This is the "spec mode never just chats" behaviour. Once a spec exists, the
 * orchestrator walks its tasks in dependency order and, for each one, spins up a
 * focused Task Agent (see taskAgent.ts). It tracks structured progress, runs the
 * independent verifier after each task, and only advances when a task is
 * genuinely complete. The model is never asked to "decide what to do next" in
 * free-form prose — the orchestrator owns the plan.
 */

import { logger } from '../utils/logger';
import { runTaskAgent } from './taskAgent';
import { verifyTaskCompletion } from './verifier';
import {
  readSpec,
  getNextTask,
  updateTaskStatus,
  updateSpec,
  areAllTasksComplete,
} from './tools/specs';
import { readFile as readWorkspaceFile } from './tools/filesystem';
import type { AgentConfig, WSServerEvent, Spec } from '../types';

export interface SpecOrchestratorParams {
  config: AgentConfig;
  workspacePath: string;
  specId: string;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  onEvent: (event: WSServerEvent) => void;
  requestApproval: (toolName: string, args: Record<string, unknown>, preview?: string) => Promise<boolean>;
  isStopped: () => boolean;
  logAudit: (event: { eventType: string; resultSummary?: string }) => void;
}

export interface SpecRunResult {
  completed: boolean;
  tasksDone: number;
  tasksTotal: number;
}

/**
 * Execute every remaining task in a spec via dispatched task agents.
 * Returns when all tasks are done, the run is stopped, or progress stalls.
 */
export async function runSpecToCompletion(params: SpecOrchestratorParams): Promise<SpecRunResult> {
  const { config, workspacePath, specId, onEvent, isStopped, logAudit } = params;

  let spec = readSpec(workspacePath, specId);
  if (!spec) {
    onEvent({ type: 'error', message: `Spec ${specId} not found.`, recoverable: false });
    return { completed: false, tasksDone: 0, tasksTotal: 0 };
  }

  const total = spec.tasks.length;
  let guardrail = 0;
  const maxTaskRuns = total * 3 + 5; // allow some retries without infinite loops

  while (!isStopped() && guardrail < maxTaskRuns) {
    guardrail++;
    spec = readSpec(workspacePath, specId)!;
    const task = getNextTask(workspacePath, specId);
    if (!task) break; // nothing left to do

    const doneCount = spec.tasks.filter((t) => t.status === 'done').length;
    const taskIndex = spec.tasks.findIndex((t) => t.id === task.id);

    updateTaskStatus(workspacePath, specId, task.id, 'in_progress');
    emitSpec(params, readSpec(workspacePath, specId));

    logger.info('Dispatching task agent', { specId, taskId: task.id, title: task.title, index: taskIndex });
    logAudit({ eventType: 'task_dispatched', resultSummary: `${task.title}` });

    const result = await runTaskAgent({
      config,
      workspacePath,
      spec,
      task,
      taskIndex: taskIndex >= 0 ? taskIndex : doneCount,
      totalTasks: total,
      requireApprovalForWrites: params.requireApprovalForWrites,
      requireApprovalForShell: params.requireApprovalForShell,
      onEvent,
      requestApproval: params.requestApproval,
      isStopped,
    });

    if (isStopped()) break;

    // Independent semantic verification (in addition to the task agent's own
    // deterministic validation) — the dream's skeptical QA layer.
    onEvent({ type: 'task_progress', specId, taskId: task.id, phase: 'verifying' });
    const verification = await verifyTaskCompletion({
      config,
      workspacePath,
      task,
      specTitle: spec.title,
      filesTouched: result.filesTouched,
      readFileContent: async (p: string) => {
        try { return await readWorkspaceFile(workspacePath, p); } catch { return null; }
      },
    });

    const passed = result.validationOk && verification.verified;

    if (passed) {
      updateTaskStatus(workspacePath, specId, task.id, 'done');
      const updated = readSpec(workspacePath, specId);
      // Record a short verification note on the task for the UI.
      if (updated) {
        const t = updated.tasks.find((x) => x.id === task.id);
        if (t) {
          t.verificationNote = verification.reason;
          updateSpec(workspacePath, specId, { tasks: updated.tasks });
        }
      }
      emitSpec(params, readSpec(workspacePath, specId));
      onEvent({ type: 'task_completed', specId, taskId: task.id, verified: true, summary: result.summary });
      logAudit({ eventType: 'task_completed', resultSummary: `${task.title}: ${result.summary}` });
    } else {
      // Leave as in_progress; the next dispatch will retry with fresh context.
      const reason = !result.validationOk ? 'validation failed' : verification.reason;
      onEvent({ type: 'task_completed', specId, taskId: task.id, verified: false, summary: reason });
      onEvent({ type: 'status', content: `↻ Task "${task.title}" needs another pass: ${reason}` });
      logAudit({ eventType: 'task_verification_failed', resultSummary: `${task.title}: ${reason}` });

      // If this task has failed repeatedly, mark it done-with-warning to avoid a
      // hard stall, but surface it clearly.
      const attemptsKey = task.id;
      taskAttempts.set(attemptsKey, (taskAttempts.get(attemptsKey) ?? 0) + 1);
      if ((taskAttempts.get(attemptsKey) ?? 0) >= 3) {
        onEvent({ type: 'status', content: `Task "${task.title}" did not fully verify after 3 attempts. Moving on so the run can continue — review it manually.` });
        updateTaskStatus(workspacePath, specId, task.id, 'done');
        emitSpec(params, readSpec(workspacePath, specId));
        logAudit({ eventType: 'task_forced_done', resultSummary: `${task.title}: forced after 3 attempts` });
      }
    }
  }

  // Finalize spec status.
  const allDone = areAllTasksComplete(workspacePath, specId);
  if (allDone) {
    const updated = updateSpec(workspacePath, specId, { status: 'done' });
    emitSpec(params, updated);
    onEvent({ type: 'status', content: `All tasks complete. Spec "${updated?.title}" is done.` });
    logAudit({ eventType: 'spec_completed', resultSummary: `Spec ${specId} completed` });
  }

  const finalSpec = readSpec(workspacePath, specId)!;
  const done = finalSpec.tasks.filter((t) => t.status === 'done').length;

  // Clear this spec's retry counters so the module-scoped map can't grow without
  // bound across many spec runs in a long-lived process.
  for (const t of finalSpec.tasks) taskAttempts.delete(t.id);

  return { completed: allDone, tasksDone: done, tasksTotal: total };
}

// Per-task retry counter (module-scoped; cleared lazily as specs complete).
const taskAttempts = new Map<string, number>();

function emitSpec(params: SpecOrchestratorParams, spec: Spec | null): void {
  if (spec) params.onEvent({ type: 'spec_updated', spec });
}
