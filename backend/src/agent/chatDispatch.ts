/**
 * What actually happens when a chat message arrives.
 *
 * Three shapes reach the same entry point and they are genuinely different:
 *
 *   an ordinary message   → one agent run
 *   a workflow            → one agent run with an expanded, structured prompt
 *   a loop workflow       → many agent runs under a budget
 *
 * Keeping that decision in one place, on the SERVER, is what stops the desktop
 * app and the CLI disagreeing about what `/fix` means. If workflow expansion
 * lived in the client, every client would carry its own copy of the prompts and
 * they would drift within a release.
 */

import { logger } from '../utils/logger';
import { runAgentLoop } from './orchestrator';
import { runLoop } from './loopRunner';
import { buildWorkflowPrompt } from './workflows';
import { saveSessionPlan } from '../session/manager';
import type { ThreadType, WSServerEvent } from '../types';
import type { WorkspaceSource } from '../workspace/types';

export interface DispatchParams {
  sessionId?: string;
  message: string;
  workspacePath: string;
  threadType?: ThreadType;
  specId?: string;
  source?: WorkspaceSource;
  workflow?: { command: string; args: Record<string, string>; openFiles?: string[] };
  onEvent: (event: WSServerEvent) => void;
}

export async function dispatchChat(params: DispatchParams): Promise<void> {
  const { workflow } = params;

  // --- Plain message -------------------------------------------------------
  if (!workflow) {
    await runAgentLoop({
      sessionId: params.sessionId,
      userMessage: params.message,
      workspacePath: params.workspacePath,
      threadType: params.threadType,
      specId: params.specId,
      source: params.source,
      onEvent: params.onEvent,
    });
    return;
  }

  const built = buildWorkflowPrompt(workflow.command, workflow.args, {
    openFiles: workflow.openFiles,
    workspacePath: params.workspacePath,
  });

  // An unknown workflow is a typo, not an error. Send what the user typed.
  if (!built) {
    logger.warn('Unknown workflow; treating it as an ordinary message', { command: workflow.command });
    await runAgentLoop({
      sessionId: params.sessionId,
      userMessage: params.message,
      workspacePath: params.workspacePath,
      threadType: params.threadType,
      specId: params.specId,
      source: params.source,
      onEvent: params.onEvent,
    });
    return;
  }

  const threadType = built.threadType ?? params.threadType;

  // --- Loop ----------------------------------------------------------------
  if (built.loop) {
    // A loop needs a session to drive, and the first round is what creates one
    // for a brand-new thread. Run round one through the normal path so the
    // session id exists, then hand the rest to the loop runner.
    let sessionId = params.sessionId;

    if (!sessionId) {
      await runAgentLoop({
        sessionId: undefined,
        userMessage: built.prompt,
        workspacePath: params.workspacePath,
        threadType,
        specId: params.specId,
        source: params.source,
        trigger: 'loop',
        onEvent: (event) => {
          if (event.type === 'session_created') sessionId = event.sessionId;
          // The loop reports its own completion; a per-round `done` would make
          // the composer flicker back to idle between rounds.
          if (event.type === 'done') return;
          params.onEvent(event);
        },
      });

      if (!sessionId) {
        params.onEvent({ type: 'done', sessionId: '' });
        return;
      }

      seedPlan(sessionId, built.plan);

      // Round one is already spent.
      const remaining = Math.max(built.loop.maxIterations - 1, 0);
      if (remaining === 0) {
        params.onEvent({ type: 'done', sessionId });
        return;
      }

      await runLoop({
        sessionId,
        workspacePath: params.workspacePath,
        threadType,
        specId: params.specId,
        spec: { ...built.loop, maxIterations: remaining },
        initialPrompt: built.prompt,
        onEvent: params.onEvent,
      });
      return;
    }

    seedPlan(sessionId, built.plan);
    await runLoop({
      sessionId,
      workspacePath: params.workspacePath,
      threadType,
      specId: params.specId,
      spec: built.loop,
      initialPrompt: built.prompt,
      onEvent: params.onEvent,
    });
    return;
  }

  // --- One-shot workflow ---------------------------------------------------
  let createdSessionId = params.sessionId;
  await runAgentLoop({
    sessionId: params.sessionId,
    userMessage: built.prompt,
    workspacePath: params.workspacePath,
    threadType,
    specId: params.specId,
    source: params.source,
    onEvent: (event) => {
      if (event.type === 'session_created') {
        createdSessionId = event.sessionId;
        seedPlan(event.sessionId, built.plan);
      }
      params.onEvent(event);
    },
  });

  if (createdSessionId && params.sessionId) seedPlan(params.sessionId, built.plan);
}

/**
 * Give the thread the workflow's starting plan.
 *
 * Seeding it means the plan widget is populated from the first second rather
 * than after the agent gets round to calling update_plan — which it often does
 * several tool calls in, by which point the user has been watching an empty
 * plan wondering whether the feature works. The agent is free to change it
 * immediately; these are a starting point, not a contract.
 */
function seedPlan(sessionId: string, titles?: string[]): void {
  if (!titles || titles.length === 0) return;
  try {
    const now = Date.now();
    saveSessionPlan(
      sessionId,
      titles.map((title, i) => ({
        id: `w${now.toString(36)}${i}`,
        title,
        status: i === 0 ? 'in_progress' : 'todo',
        createdAt: now,
        updatedAt: now,
      })) as never,
    );
  } catch (err) {
    logger.debug('Could not seed the workflow plan', { sessionId, error: String(err) });
  }
}
