/**
 * The interactive terminal client.
 *
 * WHY THIS IS NOT A FULL-SCREEN TUI
 *
 * The obvious design is to take over the terminal with an alternate screen
 * buffer and draw panes. It looks impressive in a screenshot and it costs the
 * user everything their terminal already does: scrollback, search, selection,
 * copy-paste, piping the output somewhere, resizing without redraw artefacts,
 * and tmux behaving normally.
 *
 * A coding agent's output is a TRANSCRIPT — append-only, read after the fact,
 * frequently copied out. So this renders into ordinary scrollback and reserves
 * in-place updating for the single current line, which terminals do natively.
 * The result is a session you can scroll back through a week later, and pipe
 * into a file, and that behaves the same over SSH.
 *
 * WHAT IT DOES TAKE OVER
 *
 * Ctrl-C, so it stops the AGENT rather than killing the CLI. Killing the
 * process mid-turn leaves the backend running a turn nobody is watching, which
 * is the single most confusing thing a terminal client can do.
 *
 * INPUT IS NEVER BLOCKED
 *
 * The loop used to be `for await (const line of rl)`, which cannot deliver the
 * next line until the current turn resolves — so anything typed during a run
 * sat invisible in a buffer and was all sent at once, minutes later, when the
 * agent had already finished. Now lines are handled by an event listener and a
 * line typed mid-run is QUEUED against the running thread, which the agent
 * reads at its next step. That is the same mechanism the desktop composer uses,
 * so the two behave identically.
 */

import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import { BubblyClient } from '../client';
import { Renderer } from '../ui/render';
import { runTurn, type ApprovalPolicy } from '../session';
import { renderBanner } from '../ui/banner';
import { loadCommandCatalogue, printHelp, runLocalCommand, type CommandContext } from './localCommands';

export interface ReplOptions {
  client: BubblyClient;
  workspacePath: string;
  sessionId?: string;
  threadType?: string;
  approvalPolicy: ApprovalPolicy;
  verbose: boolean;
}

interface WorkflowInfo {
  command: string;
  name: string;
  description: string;
  params: Array<{ name: string; label: string; required?: boolean; options?: string[]; default?: string; placeholder?: string }>;
}

/** How many messages may wait for a running turn. Matches the server's cap. */
const MAX_QUEUED = 3;

export async function startRepl(options: ReplOptions): Promise<void> {
  const { client } = options;
  const renderer = new Renderer({ verbose: options.verbose });

  let sessionId = options.sessionId;
  let workspacePath = options.workspacePath;
  let running = false;
  let queuedCount = 0;
  /** Set while a question or approval is being answered, so the line handler
   *  does not also try to interpret the answer as a command. */
  let awaitingAnswer = false;

  const [workflows, catalogue, settings] = await Promise.all([
    client.get<{ workflows: WorkflowInfo[] }>('/api/settings/workflows').then((d) => d.workflows).catch(() => [] as WorkflowInfo[]),
    loadCommandCatalogue(client),
    client.get<Record<string, string>>('/api/settings').catch(() => ({} as Record<string, string>)),
  ]);

  const provider = settings.defaultProvider || 'claude';
  const modelKey =
    provider === 'claude' ? 'claudeModel'
    : provider === 'gemini' ? 'geminiModel'
    : provider === 'openrouter' ? 'openrouterModel'
    : 'ollamaModel';

  process.stdout.write(renderBanner({
    version: require('../../package.json').version,
    workspace: path.resolve(workspacePath),
    backendUrl: client.baseUrl,
    model: settings[modelKey] ? `${provider} · ${settings[modelKey]}` : provider,
    approvals: options.approvalPolicy,
    threadId: sessionId ?? null,
  }));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
    // History gives the session the feel of a shell, which is what people
    // expect the moment there is a prompt.
    historySize: 200,
    terminal: process.stdin.isTTY === true,
    completer: (partial: string) => {
      // Tab completion over both command families. A slash menu you have to
      // remember is a slash menu people stop using.
      if (!partial.startsWith('/')) return [[], partial];
      const names = [
        ...catalogue.map((c) => `/${c.command}`),
        ...workflows.map((w) => `/${w.command}`),
      ];
      const hits = names.filter((n) => n.startsWith(partial));
      return [hits.length > 0 ? hits : names, partial];
    },
  });

  const interactive = process.stdin.isTTY === true;
  /** Set the moment readline closes, so nothing tries to draw a prompt after. */
  let closing = false;

  /**
   * Draw the prompt — unless the session is over.
   *
   * readline throws ERR_USE_AFTER_CLOSE on prompt() after close, and a piped
   * session closes on EOF while commands are still finishing. Every one of
   * those threw an "Error readline was closed" line into the output, which is
   * both alarming and completely uninformative.
   */
  const prompt = () => {
    if (closing) return;
    try { rl.prompt(); } catch { /* the session ended while a command was running */ }
  };

  /**
   * Ctrl-C means STOP THE AGENT, not exit.
   *
   * readline's default SIGINT would tear down the CLI and leave the backend
   * running a turn with nobody listening — which then streams into the next
   * session that opens the thread. Stopping the run and keeping the prompt is
   * both what the user meant and what leaves the system in a defined state.
   */
  rl.on('SIGINT', () => {
    if (running && sessionId) {
      client.stop(sessionId);
      renderer.note(chalk.yellow('Stopping…'));
      return;
    }
    process.stdout.write(`\n  ${chalk.dim('Ctrl-D to exit. Anything running in the background keeps running.')}\n`);
    prompt();
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      awaitingAnswer = true;
      rl.question(question, (answer) => { awaitingAnswer = false; resolve(answer.trim()); });
    });

  /** Approvals, asked plainly. */
  const onApprovalNeeded = async (tool: string, args: Record<string, unknown>, preview?: string): Promise<boolean> => {
    renderer.blank();
    process.stdout.write(`  ${chalk.yellow.bold('Permission needed')}  ${chalk.bold(tool)}\n`);
    const detail = args.command ?? args.path ?? args.url;
    if (typeof detail === 'string') process.stdout.write(`  ${chalk.dim(detail)}\n`);
    if (preview) {
      for (const previewLine of preview.split('\n').slice(0, 12)) process.stdout.write(`  ${chalk.dim(previewLine)}\n`);
    }
    const answer = await ask(`  ${chalk.bold('Allow?')} ${chalk.dim('[y/N] ')}`);
    return /^y(es)?$/i.test(answer);
  };

  const onQuestion = async (question: string, opts?: string[]): Promise<string> => {
    renderer.blank();
    process.stdout.write(`  ${chalk.cyan.bold('The agent asks')}  ${question}\n`);
    if (opts?.length) {
      opts.forEach((o, i) => process.stdout.write(`    ${chalk.dim(`${i + 1})`)} ${o}\n`));
      const answer = await ask(`  ${chalk.dim('Choose a number, or type an answer: ')}`);
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= opts.length) return opts[index - 1];
      return answer;
    }
    return ask(`  ${chalk.dim('› ')}`);
  };

  const send = async (message: string, workflow?: { command: string; args: Record<string, string> }) => {
    running = true;
    queuedCount = 0;
    try {
      const result = await runTurn({
        client,
        renderer,
        workspacePath,
        sessionId,
        threadType: options.threadType,
        message,
        workflow,
        approvalPolicy: options.approvalPolicy,
        onApprovalNeeded,
        onQuestion,
        // The prompt has already echoed the line in an interactive terminal;
        // printing it again is the "every message appears twice" bug.
        echoUser: !interactive,
        onSessionId: (id) => {
          // Known as soon as the server assigns it, so a Ctrl-C during the very
          // first turn of a new thread has something to stop.
          sessionId = id;
          client.focus(id);
        },
      });
      sessionId = result.sessionId || sessionId;

      if (result.changedFiles.length > 0) {
        const added = result.changedFiles.reduce((n, f) => n + f.additions, 0);
        const removed = result.changedFiles.reduce((n, f) => n + f.deletions, 0);
        renderer.note(
          `${result.changedFiles.length} file(s) changed · ${chalk.green(`+${added}`)} ${chalk.red(`−${removed}`)}`,
        );
      }
    } catch (err) {
      renderer.error(err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
      queuedCount = 0;
      renderer.blank();
    }
  };

  /** Collect a workflow's arguments interactively. */
  const configureWorkflow = async (
    workflow: WorkflowInfo,
    trailing: string,
  ): Promise<Record<string, string> | null> => {
    const args: Record<string, string> = {};
    let firstRequiredFilled = false;

    for (const p of workflow.params) {
      // The text after the command fills the first required field, so
      // `/fix the login is broken` does not throw the sentence away.
      if (!firstRequiredFilled && p.required && !p.options && trailing) {
        args[p.name] = trailing;
        firstRequiredFilled = true;
        continue;
      }

      if (p.options) {
        const choices = p.options.map((o, i) => `${i + 1}) ${o}`).join('  ');
        const answer = await ask(`  ${p.label} ${chalk.dim(`[${choices}]`)} ${chalk.dim(`(${p.default ?? p.options[0]}) `)}`);
        const index = Number(answer);
        args[p.name] = Number.isInteger(index) && p.options[index - 1]
          ? p.options[index - 1]
          : (answer || p.default || p.options[0]);
        continue;
      }

      const suffix = p.default ? chalk.dim(`(${p.default}) `) : p.required ? chalk.dim('(required) ') : chalk.dim('(optional) ');
      const answer = await ask(`  ${p.label} ${suffix}`);
      args[p.name] = answer || p.default || '';

      if (p.required && !args[p.name]) {
        renderer.note(chalk.yellow(`${p.label} is required — cancelled.`));
        return null;
      }
    }
    return args;
  };

  /** Everything a local command is allowed to touch. */
  const commandContext = (): CommandContext => ({
    client,
    renderer,
    workspacePath,
    sessionId,
    running,
    approvalPolicy: options.approvalPolicy,
    verbose: options.verbose,
    setWorkspace: (p) => { workspacePath = p; },
    setSessionId: (id) => { sessionId = id; client.focus(id ?? null); },
    setVerbose: (v) => { options.verbose = v; renderer.setVerbose(v); return v; },
    setApprovalPolicy: (p) => { options.approvalPolicy = p; },
    sendPrompt: (m) => send(m),
    ask,
    exit: () => rl.close(),
  });

  /**
   * One line of input.
   *
   * Runs on the 'line' event rather than inside an `await` loop, so input keeps
   * arriving while a turn is in flight — which is the whole reason mid-run
   * queueing can exist at all.
   */
  const handleLine = async (raw: string): Promise<void> => {
    const input = raw.trim();
    if (!input) { if (!running) prompt(); return; }

    // --- while the agent is working ---------------------------------------
    if (running) {
      // A slash command is a local action; it is safe and useful mid-run
      // (/stop, /status, /bg) and should not be queued as a prompt.
      if (input.startsWith('/')) {
        const outcome = await runLocalCommand(input, commandContext(), catalogue, workflows).catch((err: Error) => {
          renderer.error(err.message);
          return 'handled' as const;
        });
        if (outcome === 'unknown') {
          renderer.note(`"${input.split(/\s+/)[0]}" is not something I can do while the agent is working. Try /help.`);
        }
        return;
      }

      if (!sessionId) {
        renderer.note('The thread has not been created yet — try again in a moment.');
        return;
      }
      if (queuedCount >= MAX_QUEUED) {
        renderer.note(chalk.yellow(`${MAX_QUEUED} messages are already waiting. The agent reads them at its next step.`));
        return;
      }
      queuedCount++;
      client.queueMessage(sessionId, input);
      return;
    }

    // --- idle -------------------------------------------------------------
    if (input.startsWith('/')) {
      const outcome = await runLocalCommand(input, commandContext(), catalogue, workflows).catch((err: Error) => {
        renderer.error(err.message);
        return 'handled' as const;
      });
      if (outcome === 'handled') { prompt(); return; }

      const [word, ...rest] = input.slice(1).split(/\s+/);
      const workflow = workflows.find((w) => w.command === word);
      if (workflow) {
        process.stdout.write(`\n  ${chalk.bold(workflow.name)} ${chalk.dim(workflow.description)}\n`);
        const args = await configureWorkflow(workflow, rest.join(' ').trim());
        if (args) {
          const primary = workflow.params.find((p) => p.required && !p.options);
          const label = primary && args[primary.name]
            ? `/${workflow.command} ${args[primary.name]}`
            : `/${workflow.command}`;
          await send(label, { command: workflow.command, args });
        }
        prompt();
        return;
      }

      renderer.note(`Unknown command "/${word}". Try /help.`);
      prompt();
      return;
    }

    await send(input);
    prompt();
  };

  prompt();

  /**
   * ONE LINE AT A TIME, IN ORDER.
   *
   * `handleLine` is async — it may run a turn, fetch from the REST API, or ask
   * a follow-up question — and the 'line' event does not wait for it. Calling
   * it directly meant two lines typed quickly ran CONCURRENTLY: two commands
   * interleaving their output, and, when the input is a pipe rather than a
   * keyboard, every line firing at once so `/exit` closed the session while
   * `/status` was still fetching. (That last one is not hypothetical; it
   * crashed libuv on Windows.)
   *
   * A promise chain is the whole fix. Lines queue behind one another exactly as
   * a person would expect them to, and a pipe behaves the same as a keyboard —
   * which is what makes `printf '/status
/exit
' | bubbly chat` a usable way
   * to script the thing.
   */
  let chain: Promise<void> = Promise.resolve();

  rl.on('line', (raw) => {
    // A line typed in answer to a question belongs to rl.question, which has
    // already consumed it — this listener must not also act on it.
    if (awaitingAnswer || closing) return;
    chain = chain.then(() => handleLine(raw)).catch((err) => {
      renderer.error(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve) => rl.once('close', () => { closing = true; resolve(); }));
  // Let whatever was in flight finish before the connection is torn out from
  // under it — otherwise a command still awaiting a response resolves against a
  // closed socket, which surfaces as an unhandled rejection rather than output.
  await chain.catch(() => { /* already reported */ });

  process.stdout.write(`\n  ${chalk.dim('Bye. Anything running in the background is still running — /bg list from a new session.')}\n`);
  client.close();
}
