/**
 * `bubbly run` — one task, no prompt, an exit code that means something.
 *
 * This is the mode a script or a CI job uses, and it is held to a different
 * standard from the interactive one: everything it does must be decidable in
 * advance, and everything it decides must be visible afterwards.
 *
 * THE EXIT CODE IS PART OF THE INTERFACE
 *
 *   0  the agent finished and reported no error
 *   1  the agent reported an error
 *   2  bad usage — no workspace, unknown workflow, backend unreachable
 *   3  the run needed a human: an approval under `--approve deny`, or a
 *      question with nobody to answer it
 *
 * Distinguishing 3 from 1 matters more than it looks. "The agent failed" and
 * "the agent needed permission it was not given" call for completely different
 * responses from whoever is reading the CI log, and collapsing them into one
 * code guarantees the wrong one is taken about half the time.
 */

import chalk from 'chalk';
import path from 'path';
import { BubblyClient } from '../client';
import { Renderer } from '../ui/render';
import { runTurn, type ApprovalPolicy } from '../session';

export interface HeadlessOptions {
  client: BubblyClient;
  workspacePath: string;
  message: string;
  workflow?: { command: string; args: Record<string, string> };
  sessionId?: string;
  threadType?: string;
  approvalPolicy: ApprovalPolicy;
  /** Emit one JSON object instead of prose. */
  json: boolean;
  /** Print tool calls and diffs. */
  verbose: boolean;
  /** Give up after this many seconds. 0 means no limit. */
  timeoutSeconds: number;
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const { client } = options;

  // In JSON mode the transcript must not pollute stdout — the caller is parsing
  // it. Progress still goes to stderr, which is where progress belongs.
  const renderer = new Renderer({
    plain: options.json || !process.stdout.isTTY,
    verbose: options.verbose && !options.json,
  });

  let neededHuman = false;

  const timeout = options.timeoutSeconds > 0
    ? setTimeout(() => {
        process.stderr.write(
          chalk.yellow(`\nTimed out after ${options.timeoutSeconds}s — stopping the agent.\n`),
        );
        // Stop cleanly rather than killing the process: the backend should not
        // be left running a turn nobody will read.
        if (lastSessionId) client.stop(lastSessionId);
      }, options.timeoutSeconds * 1000)
    : null;
  if (timeout && typeof timeout.unref === 'function') timeout.unref();

  let lastSessionId = options.sessionId;

  try {
    const result = await runTurn({
      client,
      renderer,
      workspacePath: options.workspacePath,
      sessionId: options.sessionId,
      threadType: options.threadType,
      message: options.message,
      workflow: options.workflow,
      approvalPolicy: options.approvalPolicy,
      // No onApprovalNeeded and no onQuestion: in headless mode the policy has
      // already decided, and a question with nobody to answer it is a result,
      // not something to guess at.
      onQuestion: async (question) => {
        neededHuman = true;
        process.stderr.write(chalk.yellow(`\nThe agent asked: ${question}\n`));
        return '[no interactive user is available — proceed with your best judgement, or stop and explain what you need]';
      },
      collect: options.json,
    });
    lastSessionId = result.sessionId;

    if (timeout) clearTimeout(timeout);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: result.errors.length === 0,
        sessionId: result.sessionId,
        workspace: path.resolve(options.workspacePath),
        text: result.text,
        plan: result.plan,
        changedFiles: result.changedFiles,
        toolCalls: result.toolCalls.map((t) => ({
          tool: t.tool,
          args: t.args,
          isError: t.isError ?? false,
        })),
        loop: result.loop,
        errors: result.errors,
        neededHuman,
      }, null, 2)}\n`);
    } else {
      renderer.blank();
      if (result.changedFiles.length > 0) {
        process.stdout.write(`  ${chalk.bold('Changed')}\n`);
        for (const f of result.changedFiles) {
          process.stdout.write(
            `    ${f.path} ${chalk.green(`+${f.additions}`)} ${chalk.red(`−${f.deletions}`)}\n`,
          );
        }
        process.stdout.write('\n');
      }
      if (result.sessionId) {
        process.stdout.write(`  ${chalk.dim(`Thread ${result.sessionId} — resume with: bubbly chat --thread ${result.sessionId}`)}\n`);
      }
    }

    if (result.errors.length > 0) return 1;
    // A denied approval means the run did not do what was asked, even if the
    // agent then finished gracefully around it.
    if (neededHuman || (options.approvalPolicy === 'deny' && result.toolCalls.some((t) => t.isError))) return 3;
    return 0;
  } catch (err) {
    if (timeout) clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(chalk.red(`\n  ${message}\n`));
    }
    return 1;
  }
}
