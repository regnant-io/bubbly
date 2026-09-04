/**
 * One turn of conversation, rendered to a terminal.
 *
 * Shared by the interactive REPL and the headless runner so the two cannot
 * disagree about what an event means. The difference between them is what
 * happens around a turn — a prompt and a loop, or a single exit code — not what
 * happens inside one.
 *
 * APPROVALS ARE THE INTERESTING PART
 *
 * The agent can pause mid-turn to ask permission, and what to do about that is
 * exactly where an interactive session and an automated one diverge. Interactive
 * asks the human. Headless CANNOT ask, so it must decide in advance and say what
 * it decided: auto-approving silently would make `bubbly run` in CI able to
 * delete things nobody agreed to, and auto-rejecting silently would make it fail
 * for reasons the log never explains.
 */

import chalk from 'chalk';
import type { BubblyClient, ServerEvent } from './client';
import { Renderer, summariseResult, looksLikeError } from './ui/render';

export type ApprovalPolicy = 'ask' | 'auto' | 'deny';

export interface TurnOptions {
  client: BubblyClient;
  renderer: Renderer;
  workspacePath: string;
  sessionId?: string;
  threadType?: string;
  message: string;
  workflow?: { command: string; args: Record<string, string> };
  approvalPolicy: ApprovalPolicy;
  /** Asked when the policy is 'ask'. Returns true to approve. */
  onApprovalNeeded?: (tool: string, args: Record<string, unknown>, preview?: string) => Promise<boolean>;
  /** Asked when the agent uses ask_user. */
  onQuestion?: (question: string, options?: string[]) => Promise<string>;
  /** Collect the machine-readable record, for --json. */
  collect?: boolean;
  /**
   * Print the user's own message back before the turn.
   *
   * FALSE in an interactive session: readline already echoed the line after the
   * prompt, so echoing it again showed every message twice. TRUE everywhere the
   * input is not visible on its own — a pipe, `bubbly run`, a CI log — where a
   * transcript with no questions in it is unreadable.
   */
  echoUser?: boolean;
  /** Called with the id of the thread as soon as the server assigns one. */
  onSessionId?: (sessionId: string) => void;
}

export interface TurnResult {
  sessionId: string;
  /** Everything the agent said, concatenated. */
  text: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result?: string; isError?: boolean }>;
  changedFiles: Array<{ path: string; type: string; additions: number; deletions: number }>;
  plan: Array<{ title: string; status: string }>;
  errors: string[];
  /** Set when a loop ran, so the caller can report why it stopped. */
  loop?: { status: string; iterations: number; summary: string };
  stopped: boolean;
}

/**
 * Run one turn and resolve when it ends.
 *
 * "Ends" means the backend emitted `done` — which for a loop is after every
 * round, not after the first. That is deliberate: to the caller a loop IS one
 * turn, and treating each round as a separate turn would print a prompt in the
 * middle of an hour of autonomous work.
 */
export function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { client, renderer } = options;

  return new Promise<TurnResult>((resolve, reject) => {
    const result: TurnResult = {
      sessionId: options.sessionId ?? '',
      text: '',
      toolCalls: [],
      changedFiles: [],
      plan: [],
      errors: [],
      stopped: false,
    };

    /** Args by tool-call id, so a result can be labelled with what it was for. */
    const argsByCall = new Map<string, { tool: string; args: Record<string, unknown> }>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      client.off('event', onEvent);
      renderer.finish();
      resolve(result);
    };

    const onEvent = (event: ServerEvent) => {
      switch (event.type) {
        case 'session_created':
          result.sessionId = String(event.sessionId);
          // Told immediately, not at the end: a Ctrl-C during the FIRST turn of
          // a new thread has to be able to stop it, and until the id is known
          // there is nothing to send a stop for.
          options.onSessionId?.(result.sessionId);
          break;

        case 'run_started':
          if (event.trigger === 'watcher') {
            renderer.note(`Resumed automatically: ${String(event.detail ?? 'a background wait finished')}`);
          }
          break;

        case 'text_delta':
          renderer.textDelta(String(event.content ?? ''));
          break;

        case 'thinking':
          renderer.thinking(String(event.content ?? ''));
          break;

        case 'message':
          // The full text also arrives as deltas; keep only one copy.
          if (typeof event.content === 'string' && !result.text.includes(event.content)) {
            result.text += (result.text ? '\n' : '') + event.content;
          }
          break;

        case 'tool_started':
          // Passing the id is what stops this leaving a stranded half-drawn
          // line above the real one — see Renderer.activeToolId.
          renderer.toolStarted(String(event.tool), undefined, String(event.id ?? ''));
          break;

        case 'tool_call': {
          const tool = String(event.tool);
          const args = (event.args ?? {}) as Record<string, unknown>;
          argsByCall.set(String(event.id), { tool, args });
          result.toolCalls.push({ tool, args });
          renderer.toolStarted(tool, args, String(event.id ?? ''));
          break;
        }

        case 'phase':
          // What the agent says it is doing now. One dim line, because it is a
          // heading for the steps under it rather than a step of its own.
          renderer.phase(String(event.label ?? ''));
          break;

        case 'queued_message_delivered':
          renderer.note(chalk.cyan(`↳ delivered: ${String(event.message ?? '').slice(0, 100)}`));
          break;

        case 'message_queued':
          renderer.note(chalk.dim(`queued — the agent reads it at its next step (${event.depth} waiting)`));
          break;

        case 'message_queue_rejected':
          renderer.note(chalk.yellow(`Not queued: ${String(event.reason ?? '')}`));
          break;

        case 'tool_result': {
          const call = argsByCall.get(String(event.id));
          const text = String(event.result ?? '');
          const isError = looksLikeError(text);
          renderer.toolResult(call?.tool ?? String(event.tool), call?.args, summariseResult(String(event.tool), text), isError);
          const record = result.toolCalls.find((t) => t.tool === (call?.tool ?? event.tool) && t.result === undefined);
          if (record) { record.result = text; record.isError = isError; }
          break;
        }

        case 'diff': {
          const files = (event.files ?? []) as TurnResult['changedFiles'] & Array<{ diff: string }>;
          renderer.diff(files as never);
          for (const f of files) {
            const existing = result.changedFiles.find((c) => c.path === f.path);
            if (existing) {
              existing.additions += f.additions;
              existing.deletions += f.deletions;
            } else {
              result.changedFiles.push({
                path: f.path, type: f.type, additions: f.additions, deletions: f.deletions,
              });
            }
          }
          break;
        }

        case 'plan_updated':
          result.plan = (event.steps ?? []) as TurnResult['plan'];
          renderer.plan(result.plan);
          break;

        case 'terminal_output':
          renderer.terminalOutput(String(event.content ?? ''), event.stream === 'stderr' ? 'stderr' : 'stdout');
          break;

        case 'status':
          renderer.status(String(event.content ?? ''));
          break;

        case 'loop_started':
          renderer.loop(`Loop started: ${String(event.goal)} — up to ${event.maxIterations} rounds or ${event.maxMinutes} minutes.`);
          break;

        case 'loop_iteration':
          renderer.loop(`Round ${event.iteration} of ${event.maxIterations} · about ${event.remainingMinutes} min of budget left`);
          break;

        case 'loop_finished':
          result.loop = {
            status: String(event.status),
            iterations: Number(event.iterations),
            summary: String(event.summary),
          };
          renderer.loop(String(event.summary));
          break;

        case 'approval_required': {
          const tool = String(event.tool);
          const args = (event.args ?? {}) as Record<string, unknown>;
          const approvalId = String(event.approvalId);
          void handleApproval(approvalId, tool, args, event.preview ? String(event.preview) : undefined);
          break;
        }

        case 'question_asked': {
          const questionId = String(event.questionId);
          const question = String(event.question);
          const opts = Array.isArray(event.options) ? (event.options as string[]) : undefined;
          void handleQuestion(questionId, question, opts);
          break;
        }

        case 'error':
          result.errors.push(String(event.message));
          renderer.error(String(event.message), event.suggestions as string[] | undefined);
          break;

        case 'context_migrated':
          result.sessionId = String(event.toSessionId);
          renderer.note('Context limit reached — continuing in a fresh thread with a handoff summary.');
          break;

        case 'done':
          if (event.sessionId) result.sessionId = String(event.sessionId);
          finish();
          break;
      }
    };

    const handleApproval = async (
      approvalId: string,
      tool: string,
      args: Record<string, unknown>,
      preview?: string,
    ) => {
      if (options.approvalPolicy === 'auto') {
        renderer.note(chalk.yellow(`Auto-approved: ${tool}`));
        client.approve(approvalId);
        return;
      }
      if (options.approvalPolicy === 'deny') {
        // Say so loudly. A run that fails because permission was denied by
        // policy must not look like the agent simply gave up.
        renderer.note(chalk.yellow(`Denied by policy (--approve deny): ${tool}. Re-run with --approve auto to allow it.`));
        client.reject(approvalId);
        return;
      }
      const approved = options.onApprovalNeeded
        ? await options.onApprovalNeeded(tool, args, preview)
        : false;
      if (approved) client.approve(approvalId);
      else client.reject(approvalId);
    };

    const handleQuestion = async (questionId: string, question: string, opts?: string[]) => {
      if (!options.onQuestion) {
        // Headless: answering on the user's behalf would be inventing a
        // decision. Say what was asked and let the run end.
        renderer.note(chalk.yellow(`The agent asked: ${question}`));
        renderer.note(chalk.yellow('No one is here to answer, so the run will stop. Re-run interactively, or make the request more specific.'));
        client.answer(questionId, '[no interactive user is available — proceed with your best judgement, or stop and explain what you need]');
        return;
      }
      const answer = await options.onQuestion(question, opts);
      client.answer(questionId, answer);
    };

    client.on('event', onEvent);

    client.once('disconnected', (reason: string) => {
      if (settled) return;
      settled = true;
      client.off('event', onEvent);
      reject(new Error(`Lost the connection to the backend: ${reason}`));
    });

    renderer.userMessage(options.message, { echo: options.echoUser !== false });

    client.chat({
      message: options.message,
      workspacePath: options.workspacePath,
      sessionId: options.sessionId,
      threadType: options.threadType,
      workflow: options.workflow ? { ...options.workflow, openFiles: [] } : undefined,
    });
  });
}
