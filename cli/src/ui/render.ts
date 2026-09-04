/**
 * Turning the agent's event stream into something readable in a terminal.
 *
 * WHAT MAKES THIS HARD
 *
 * The event stream is designed for a UI that can update in place: a tool call
 * appears, then its arguments fill in, then its result replaces the spinner. A
 * terminal is append-only unless you take over the screen, and taking over the
 * screen costs you scrollback, copy-paste and every terminal feature the user
 * already knows.
 *
 * So this renders to the ordinary scrollback, and updates in place only on the
 * CURRENT line — which is the one thing a terminal does natively. A tool call
 * prints one line with a spinner and rewrites that same line when its result
 * arrives. Everything above it is finished text that will never move, so the
 * output can be piped, scrolled and copied like any other command's.
 *
 * The other rule: NOTHING IS HIDDEN BEHIND AN ANIMATION. A spinner that stops
 * updating must still say what it was doing, because a run that dies mid-tool
 * should leave evidence rather than a frozen frame.
 */

import chalk from 'chalk';
import { MarkdownLineStream, renderMarkdown, looksLikeMarkdown } from './markdown';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface RenderOptions {
  /** Suppress colour and in-place updates — for pipes, CI and `--json`. */
  plain?: boolean;
  /** Show tool calls and results. Off in quiet mode; toggled by /verbose. */
  verbose?: boolean;
}

/** Human-readable verbs for the tools, so the terminal is not full of snake_case. */
const TOOL_VERBS: Record<string, { doing: string; done: string }> = {
  read_file: { doing: 'Reading', done: 'Read' },
  read_files: { doing: 'Reading', done: 'Read' },
  write_file: { doing: 'Creating', done: 'Created' },
  edit_file: { doing: 'Editing', done: 'Edited' },
  append_file: { doing: 'Appending to', done: 'Appended to' },
  delete_file: { doing: 'Deleting', done: 'Deleted' },
  list_directory: { doing: 'Listing', done: 'Listed' },
  get_file_tree: { doing: 'Mapping', done: 'Mapped' },
  search: { doing: 'Searching for', done: 'Searched for' },
  run_command: { doing: 'Running', done: 'Ran' },
  run_background: { doing: 'Starting', done: 'Started' },
  get_process_output: { doing: 'Reading output of', done: 'Read output of' },
  watch: { doing: 'Waiting for', done: 'Waited for' },
  update_plan: { doing: 'Updating the plan', done: 'Updated the plan' },
  find_symbol: { doing: 'Finding', done: 'Found' },
  find_references: { doing: 'Finding references to', done: 'Found references to' },
  get_repo_map: { doing: 'Mapping the codebase', done: 'Mapped the codebase' },
  validate_changes: { doing: 'Validating', done: 'Validated' },
  git_status: { doing: 'Checking git', done: 'Checked git' },
  repo: { doing: 'Working with the repository', done: 'Used the repository' },
  forge: { doing: 'Talking to the forge', done: 'Talked to the forge' },
  delegate_task: { doing: 'Delegating', done: 'Delegated' },
  ask_user: { doing: 'Asking you', done: 'Asked you' },
  artifact: { doing: 'Writing a document', done: 'Wrote a document' },
  set_phase: { doing: 'Starting', done: 'Started' },
  write_config: { doing: 'Writing config', done: 'Wrote config' },
  read_config: { doing: 'Reading config', done: 'Read config' },
  preview_config: { doing: 'Setting up the preview', done: 'Set up the preview' },
  send_process_input: { doing: 'Answering', done: 'Answered' },
  list_processes: { doing: 'Listing processes', done: 'Listed processes' },
  stop_process: { doing: 'Stopping', done: 'Stopped' },
  delegate_parallel: { doing: 'Delegating in parallel', done: 'Delegated in parallel' },
  create_directory: { doing: 'Creating folder', done: 'Created folder' },
  get_file_outline: { doing: 'Outlining', done: 'Outlined' },
  gather_context: { doing: 'Gathering context', done: 'Gathered context' },
  git_diff: { doing: 'Reading the diff', done: 'Read the diff' },
  git_log: { doing: 'Reading history', done: 'Read history' },
  git_add_and_commit: { doing: 'Committing', done: 'Committed' },
  create_checkpoint: { doing: 'Checkpointing', done: 'Checkpointed' },
  revert_to_checkpoint: { doing: 'Reverting', done: 'Reverted' },
  rename_symbol: { doing: 'Renaming', done: 'Renamed' },
  browser_control: { doing: 'Using the browser', done: 'Used the browser' },
  computer_control: { doing: 'Controlling the screen', done: 'Controlled the screen' },
};

function target(tool: string, args: Record<string, unknown> = {}): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const raw = pick('path', 'command', 'query', 'pattern', 'name', 'url', 'instruction', 'action', 'question');
  if (!raw) {
    if (Array.isArray(args.paths)) return `${(args.paths as unknown[]).length} files`;
    return '';
  }
  return raw.length > 68 ? `${raw.slice(0, 67)}…` : raw;
}

export function describeTool(tool: string, args?: Record<string, unknown>, done = false): string {
  const clean = tool.replace(/^function:/, '');
  const verb = TOOL_VERBS[clean] ?? unknownVerb(clean);
  const t = target(clean, args);
  return t ? `${done ? verb.done : verb.doing} ${t}` : (done ? verb.done : verb.doing);
}

/**
 * A sentence for a tool nobody has written a verb for.
 *
 * The old fallback printed the tool's own name with the underscores taken out,
 * so an MCP call showed up as "mcp  linear  create issue" — worse than the raw
 * identifier, because it looks like prose and reads like nothing. Naming the
 * action keeps a third-party tool legible on the day it is added.
 */
function unknownVerb(tool: string): { doing: string; done: string } {
  if (tool.startsWith('mcp__')) {
    const leaf = (tool.split('__').pop() ?? tool).replace(/[_-]+/g, ' ');
    return { doing: `Using ${leaf}`, done: `Used ${leaf}` };
  }
  const words = tool.replace(/[_-]+/g, ' ');
  return { doing: `Running ${words}`, done: `Ran ${words}` };
}

/**
 * The renderer.
 *
 * Holds exactly one piece of mutable state: whether the cursor is sitting on a
 * line that may still be rewritten. Everything else is stateless printing, which
 * is what keeps the output correct when events arrive out of the order the UI
 * would have preferred.
 */
export class Renderer {
  private spinnerIndex = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  /** The text of the line currently being animated, if any. */
  private activeLine: string | null = null;
  /**
   * WHICH tool call the open line belongs to.
   *
   * THE GHOST-STEP BUG THIS KILLS
   *
   * Every tool call produces TWO events: `tool_started` the moment the model
   * begins emitting it (name known, arguments still streaming) and `tool_call`
   * once the arguments have parsed. Both called toolStarted(), and toolStarted
   * unconditionally closed whatever line was open — so the first event printed
   * "⠋ Running" and committed it to the scrollback, and the second printed
   * "⠋ Running npm test" underneath. Every single tool call left a stranded
   * half-written line above the real one. Twenty calls, twenty ghosts.
   *
   * Keeping the id means the second event REDRAWS the first line instead of
   * starting a new one, which is what it was always meant to do — the whole
   * point of the pair is that the label fills in as the arguments arrive.
   */
  private activeToolId: string | null = null;
  private streamingText = false;
  /** Renders streamed prose as markdown, one completed line at a time. */
  private markdown = new MarkdownLineStream();

  constructor(private readonly options: RenderOptions = {}) {}

  /** /verbose toggles this at runtime, so it cannot be readonly on the object. */
  setVerbose(on: boolean): void {
    this.options.verbose = on;
  }

  private get interactive(): boolean {
    return !this.options.plain && process.stdout.isTTY === true;
  }

  private write(text: string): void {
    process.stdout.write(text);
  }

  /** Finish whatever line is open, so the next thing starts cleanly. */
  private closeLine(): void {
    if (this.activeLine !== null) {
      this.stopSpinner();
      this.write('\n');
      this.activeLine = null;
      this.activeToolId = null;
    }
    if (this.streamingText) {
      // Anything still in the markdown buffer is a partial last line; it has to
      // be committed before the next thing prints over it.
      const tail = this.markdown.flush();
      if (tail) this.write(tail);
      this.write('\n');
      this.streamingText = false;
      this.markdown = new MarkdownLineStream();
    }
  }

  private startSpinner(): void {
    if (!this.interactive || this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      if (this.activeLine === null) return;
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER.length;
      this.redrawActive();
    }, 90);
    // Never hold the process open for a spinner.
    if (typeof this.spinnerTimer.unref === 'function') this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private redrawActive(): void {
    if (!this.interactive || this.activeLine === null) return;
    const frame = chalk.cyan(SPINNER[this.spinnerIndex]);
    process.stdout.write(`\r\x1b[2K  ${frame} ${chalk.dim(this.activeLine)}`);
  }

  // --- Public surface ------------------------------------------------------

  /**
   * A line the user typed, echoed back so a transcript reads as a conversation.
   *
   * SKIPPED IN AN INTERACTIVE SESSION, and that is not an oversight.
   *
   * readline has already echoed the line as it was typed, right after the `› `
   * prompt — printing it again produced every message twice, once as the user
   * typed it and once in bold underneath, which is the single most-reported
   * thing about the terminal client. In a pipe, a `bubbly run`, or a saved log
   * there IS no echo, and the transcript is unreadable without knowing what was
   * asked, so there it stays.
   */
  userMessage(text: string, opts: { echo?: boolean } = {}): void {
    this.closeLine();
    if (opts.echo === false) { this.write('\n'); return; }
    this.write(`\n${chalk.bold.cyan('› ')}${chalk.bold(text)}\n\n`);
  }

  /**
   * Streamed answer text, formatted as it arrives.
   *
   * A terminal cannot restyle a line it has already printed, so "render the
   * markdown at the end" is not available: the decision has to be made before
   * each line is committed. MarkdownLineStream holds the partial line and emits
   * each one styled the moment its newline lands, which keeps the stream live
   * AND formatted instead of making that a choice. Plain output (a pipe, --json)
   * gets the raw text, because a log file wants the model's actual words.
   */
  textDelta(text: string): void {
    if (this.activeLine !== null) this.closeLine();
    this.streamingText = true;
    if (this.options.plain) { this.write(text); return; }
    const painted = this.markdown.push(text);
    if (painted) this.write(painted);
  }

  /** The agent's reasoning, dimmed and only when asked for. */
  thinking(text: string): void {
    if (!this.options.verbose) return;
    if (this.activeLine !== null) this.closeLine();
    this.write(chalk.dim.italic(text));
  }

  /**
   * A tool has started, or the same tool's arguments have now parsed.
   *
   * `id` is what makes the second call an UPDATE rather than a new line — see
   * activeToolId. Callers that do not have an id (an older event, a replay) get
   * the old behaviour, which is correct for them because there is nothing to
   * match against.
   */
  toolStarted(tool: string, args?: Record<string, unknown>, id?: string): void {
    if (!this.options.verbose) return;

    const label = describeTool(tool, args, false);

    // The arguments for the line already on screen: redraw in place.
    if (id && this.activeToolId === id && this.activeLine !== null) {
      this.activeLine = label;
      if (this.interactive) this.redrawActive();
      return;
    }

    this.closeLine();
    this.activeLine = label;
    this.activeToolId = id ?? null;
    if (this.interactive) {
      this.redrawActive();
      this.startSpinner();
    } else {
      // Non-interactive: no line can be rewritten, so a bare `tool_started`
      // with no arguments yet is not worth a line of its own — it would be the
      // ghost, permanently. Wait for the arguments.
      if (!args && id) return;
      this.write(`  · ${this.activeLine}\n`);
      this.activeLine = null;
      this.activeToolId = null;
    }
  }

  /**
   * A tool has finished. Rewrites the open line with the outcome.
   *
   * `isError` is styled but never hidden — a failed tool call inside a long run
   * is exactly the thing someone scrolls back to find.
   */
  toolResult(tool: string, args: Record<string, unknown> | undefined, summary: string, isError: boolean): void {
    if (!this.options.verbose) return;
    this.stopSpinner();
    const label = describeTool(tool, args, true);
    const mark = isError ? chalk.red('✗') : chalk.green('✓');
    const detail = summary ? chalk.dim(` · ${summary}`) : '';

    if (this.interactive && this.activeLine !== null) {
      process.stdout.write(`\r\x1b[2K  ${mark} ${label}${detail}\n`);
    } else {
      this.write(`  ${isError ? '✗' : '✓'} ${label}${summary ? ` · ${summary}` : ''}\n`);
    }
    this.activeLine = null;
    this.activeToolId = null;
  }

  /** A unified diff, coloured. */
  diff(files: Array<{ path: string; diff: string; additions: number; deletions: number; type: string }>): void {
    this.closeLine();
    for (const file of files) {
      const stat = `${chalk.green(`+${file.additions}`)} ${chalk.red(`−${file.deletions}`)}`;
      this.write(`\n  ${chalk.bold(file.path)} ${chalk.dim(`(${file.type})`)} ${stat}\n`);
      if (!this.options.verbose) continue;

      for (const line of file.diff.split('\n')) {
        // Headers carry no information a human needs here — the filename is
        // already printed above, in a form they can click.
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:')) continue;
        if (line.startsWith('@@')) this.write(chalk.cyan(`    ${line}\n`));
        else if (line.startsWith('+')) this.write(chalk.green(`    ${line}\n`));
        else if (line.startsWith('-')) this.write(chalk.red(`    ${line}\n`));
        else this.write(chalk.dim(`    ${line}\n`));
      }
    }
    this.write('\n');
  }

  /** The working plan, as a checklist. */
  plan(steps: Array<{ title: string; status: string }>): void {
    if (steps.length === 0) return;
    this.closeLine();
    const done = steps.filter((s) => s.status === 'done').length;
    this.write(`\n  ${chalk.bold('Plan')} ${chalk.dim(`(${done}/${steps.length})`)}\n`);
    for (const step of steps) {
      const mark =
        step.status === 'done' ? chalk.green('✓')
        : step.status === 'in_progress' ? chalk.cyan('▸')
        : step.status === 'blocked' ? chalk.yellow('!')
        : chalk.dim('○');
      const text = step.status === 'done' ? chalk.dim(step.title) : step.title;
      this.write(`    ${mark} ${text}\n`);
    }
    this.write('\n');
  }

  /**
   * "What I am doing now", in the agent's own words.
   *
   * A heading for the steps beneath it, so a long turn reads as three or four
   * pieces of work rather than as thirty tool calls. Deliberately quiet: it is
   * structure, not an event.
   */
  phase(label: string): void {
    if (!label) return;
    this.closeLine();
    this.write(`
  ${chalk.bold.cyan('▸')} ${chalk.bold(label)}
`);
  }

  status(text: string): void {
    this.closeLine();
    this.write(`  ${chalk.dim(text)}\n`);
  }

  error(message: string, suggestions?: string[]): void {
    this.closeLine();
    this.write(`\n  ${chalk.red.bold('Error')} ${message}\n`);
    for (const s of suggestions ?? []) this.write(`    ${chalk.dim('·')} ${chalk.dim(s)}\n`);
    this.write('\n');
  }

  terminalOutput(chunk: string, stream: 'stdout' | 'stderr'): void {
    if (!this.options.verbose) return;
    if (this.activeLine !== null) this.closeLine();
    const paint = stream === 'stderr' ? chalk.red : chalk.dim;
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.write(`    ${paint(line)}\n`);
    }
  }

  loop(text: string): void {
    this.closeLine();
    this.write(`\n  ${chalk.magenta('↻')} ${chalk.magenta(text)}\n\n`);
  }

  /** Called when a turn ends, so nothing is left half-drawn. */
  finish(): void {
    this.closeLine();
    this.stopSpinner();
  }

  note(text: string): void {
    this.closeLine();
    this.write(`  ${chalk.dim(text)}\n`);
  }

  blank(): void {
    this.closeLine();
    this.write('\n');
  }
}

/** A one-line summary of a tool result, for the collapsed line. */
export function summariseResult(tool: string, result: string): string {
  const trimmed = (result ?? '').trim();
  if (!trimmed) return '';

  const clean = tool.replace(/^function:/, '');
  if (clean === 'search' || clean === 'grep_search') {
    const m = /^(\d+) match/.exec(trimmed);
    if (m) return `${m[1]} matches`;
    if (/^No matches/.test(trimmed)) return 'no matches';
  }
  if (clean === 'read_file') {
    return `${trimmed.split('\n').length} lines`;
  }
  if (clean === 'run_command') {
    const m = /exit (\d+)/.exec(trimmed);
    if (m) return `exit ${m[1]}`;
  }

  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

export function looksLikeError(result: string): boolean {
  return /^(FAILED|Error|Tool execution failed|Cannot|Could not)/i.test((result ?? '').trim());
}
