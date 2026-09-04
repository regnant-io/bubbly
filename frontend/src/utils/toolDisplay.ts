/**
 * Humanized tool display — turns raw tool names + args into IDE-grade labels.
 *
 * Instead of "read_file { path: 'index.html' }" we show:
 *   - while running:  "Reading index.html…"
 *   - when complete:  "Read index.html"
 *
 * Each tool maps to a present-participle (running) and past-tense (done) verb
 * plus a concise target derived from its arguments.
 */

export type ToolIconName =
  | 'read' | 'write' | 'edit' | 'delete' | 'list' | 'tree' | 'search'
  | 'terminal' | 'git' | 'commit' | 'spec' | 'context' | 'map' | 'symbol'
  | 'references' | 'outline' | 'validate' | 'config' | 'browser' | 'generic';

/** Per-action verb overrides for multi-action tools (browser_control, computer_control),
 * keyed by their "action" argument. Falls back to the tool's base MAP entry when the
 * action isn't listed here. */
const ACTION_VERBS: Record<string, Record<string, { gerund: string; past: string }>> = {
  browser_control: {
    open: { gerund: 'Opening', past: 'Opened' },
    goto: { gerund: 'Navigating to', past: 'Navigated to' },
    reload: { gerund: 'Reloading the page', past: 'Reloaded the page' },
    click: { gerund: 'Clicking', past: 'Clicked' },
    type: { gerund: 'Typing', past: 'Typed' },
    press: { gerund: 'Pressing', past: 'Pressed' },
    scroll: { gerund: 'Scrolling the page', past: 'Scrolled the page' },
    wait: { gerund: 'Waiting', past: 'Waited' },
    screenshot: { gerund: 'Taking a screenshot', past: 'Took a screenshot' },
    snapshot: { gerund: 'Reading the page', past: 'Read the page' },
    viewport: { gerund: 'Resizing the viewport', past: 'Resized the viewport' },
    back: { gerund: 'Going back', past: 'Went back' },
    forward: { gerund: 'Going forward', past: 'Went forward' },
    close: { gerund: 'Closing the browser', past: 'Closed the browser' },
  },
  watch: {
    wait: { gerund: 'Waiting for', past: 'Waited for' },
    collect: { gerund: 'Collecting finished waits', past: 'Collected finished waits' },
    list: { gerund: 'Listing waits', past: 'Listed waits' },
    cancel: { gerund: 'Cancelling a wait', past: 'Cancelled a wait' },
    extend: { gerund: 'Giving a wait longer', past: 'Gave a wait longer' },
  },
  artifact: {
    write: { gerund: 'Writing a document', past: 'Wrote a document' },
    read: { gerund: 'Reading a document', past: 'Read a document' },
    list: { gerund: 'Listing documents', past: 'Listed documents' },
  },
  preview_config: {
    show: { gerund: 'Checking the run config', past: 'Checked the run config' },
    detect: { gerund: 'Working out how this project runs', past: 'Worked out how this project runs' },
    write: { gerund: 'Recording how this project runs', past: 'Recorded how this project runs' },
  },
  repo: {
    status: { gerund: 'Checking the repository', past: 'Checked the repository' },
    branch: { gerund: 'Switching branch to', past: 'Switched branch to' },
    commit: { gerund: 'Committing', past: 'Committed' },
    push: { gerund: 'Pushing', past: 'Pushed' },
    pull: { gerund: 'Pulling', past: 'Pulled' },
    clone: { gerund: 'Cloning', past: 'Cloned' },
  },
  forge: {
    pr: { gerund: 'Opening a pull request', past: 'Opened a pull request' },
    issue: { gerund: 'Filing an issue', past: 'Filed an issue' },
    list: { gerund: 'Listing from GitHub', past: 'Listed from GitHub' },
  },
  computer_control: {
    screenshot: { gerund: 'Taking a screenshot', past: 'Took a screenshot' },
    screen_size: { gerund: 'Reading screen size', past: 'Read screen size' },
    move: { gerund: 'Moving the mouse', past: 'Moved the mouse' },
    click: { gerund: 'Clicking', past: 'Clicked' },
    double_click: { gerund: 'Double-clicking', past: 'Double-clicked' },
    right_click: { gerund: 'Right-clicking', past: 'Right-clicked' },
    drag: { gerund: 'Dragging', past: 'Dragged' },
    type: { gerund: 'Typing', past: 'Typed' },
    key: { gerund: 'Pressing a key', past: 'Pressed a key' },
    scroll: { gerund: 'Scrolling', past: 'Scrolled' },
  },
};

export interface ToolDisplay {
  /** e.g. "Reading" */
  gerund: string;
  /** e.g. "Read" */
  past: string;
  /** concise target, e.g. "index.html" or "npm test" */
  target: string;
  icon: ToolIconName;
  /** semantic color class for the icon */
  color: string;
}

function basename(p: unknown): string {
  const s = String(p ?? '');
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || s;
}

function clamp(s: string, n = 48): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const MAP: Record<string, { gerund: string; past: string; icon: ToolIconName; color: string }> = {
  read_file: { gerund: 'Reading', past: 'Read', icon: 'read', color: 'text-blue-agent' },
  update_plan: { gerund: 'Updating the plan', past: 'Updated the plan', icon: 'spec', color: 'text-accent-bright' },
  delegate_task: { gerund: 'Delegating to a worker', past: 'Delegated to a worker', icon: 'generic', color: 'text-violet-agent' },
  ask_user: { gerund: 'Asking you', past: 'Asked you', icon: 'generic', color: 'text-amber-agent' },
  set_spec_design: { gerund: 'Writing the design', past: 'Wrote the design', icon: 'spec', color: 'text-accent-bright' },
  approve_spec_phase: { gerund: 'Advancing the spec', past: 'Advanced the spec', icon: 'spec', color: 'text-accent-bright' },
  add_sub_tasks: { gerund: 'Breaking down the task', past: 'Broke down the task', icon: 'spec', color: 'text-accent-bright' },
  write_file: { gerund: 'Creating', past: 'Created', icon: 'write', color: 'text-green-agent' },
  edit_file: { gerund: 'Editing', past: 'Edited', icon: 'edit', color: 'text-blue-agent' },
  delete_file: { gerund: 'Deleting', past: 'Deleted', icon: 'delete', color: 'text-red-agent' },
  list_directory: { gerund: 'Listing', past: 'Listed', icon: 'list', color: 'text-cyan-agent' },
  get_file_tree: { gerund: 'Mapping', past: 'Mapped', icon: 'tree', color: 'text-cyan-agent' },
  // `search` replaced search_in_files / grep_search / find_files. The old names
  // are kept so an older thread's transcript still renders with a proper label
  // instead of falling through to the raw tool name.
  search: { gerund: 'Searching', past: 'Searched', icon: 'search', color: 'text-orange-agent' },
  search_in_files: { gerund: 'Searching', past: 'Searched', icon: 'search', color: 'text-orange-agent' },
  create_directory: { gerund: 'Creating folder', past: 'Created folder', icon: 'write', color: 'text-green-agent' },
  run_command: { gerund: 'Running', past: 'Ran', icon: 'terminal', color: 'text-amber-agent' },
  git_status: { gerund: 'Checking git', past: 'Checked git', icon: 'git', color: 'text-violet-agent' },
  git_diff: { gerund: 'Diffing', past: 'Diffed', icon: 'git', color: 'text-violet-agent' },
  git_add_and_commit: { gerund: 'Committing', past: 'Committed', icon: 'commit', color: 'text-green-agent' },
  git_log: { gerund: 'Reading history', past: 'Read history', icon: 'git', color: 'text-violet-agent' },
  create_spec: { gerund: 'Designing spec', past: 'Created spec', icon: 'spec', color: 'text-accent-bright' },
  read_spec: { gerund: 'Reading spec', past: 'Read spec', icon: 'spec', color: 'text-accent-bright' },
  list_specs: { gerund: 'Listing specs', past: 'Listed specs', icon: 'spec', color: 'text-accent-bright' },
  update_spec_status: { gerund: 'Updating spec', past: 'Updated spec', icon: 'spec', color: 'text-accent-bright' },
  add_spec_task: { gerund: 'Adding task', past: 'Added task', icon: 'spec', color: 'text-accent-bright' },
  update_task_status: { gerund: 'Updating task', past: 'Updated task', icon: 'spec', color: 'text-accent-bright' },
  get_next_task: { gerund: 'Getting next task', past: 'Got next task', icon: 'spec', color: 'text-accent-bright' },
  gather_context: { gerund: 'Gathering context', past: 'Gathered context', icon: 'context', color: 'text-brown-agent' },
  get_repo_map: { gerund: 'Mapping codebase', past: 'Mapped codebase', icon: 'map', color: 'text-brown-agent' },
  find_symbol: { gerund: 'Finding symbol', past: 'Found symbol', icon: 'symbol', color: 'text-cyan-agent' },
  find_references: { gerund: 'Finding references', past: 'Found references', icon: 'references', color: 'text-cyan-agent' },
  get_file_outline: { gerund: 'Outlining', past: 'Outlined', icon: 'outline', color: 'text-cyan-agent' },
  validate_changes: { gerund: 'Validating', past: 'Validated', icon: 'validate', color: 'text-green-agent' },
  read_config: { gerund: 'Reading config', past: 'Read config', icon: 'config', color: 'text-cyan-agent' },
  write_config: { gerund: 'Writing config', past: 'Wrote config', icon: 'config', color: 'text-green-agent' },
  append_file: { gerund: 'Appending to', past: 'Appended to', icon: 'edit', color: 'text-green-agent' },
  read_files: { gerund: 'Reading files', past: 'Read files', icon: 'read', color: 'text-blue-agent' },
  grep_search: { gerund: 'Searching', past: 'Searched', icon: 'search', color: 'text-orange-agent' },
  find_files: { gerund: 'Finding files', past: 'Found files', icon: 'search', color: 'text-orange-agent' },
  run_background: { gerund: 'Starting', past: 'Started', icon: 'terminal', color: 'text-amber-agent' },
  get_process_output: { gerund: 'Reading logs', past: 'Read logs', icon: 'terminal', color: 'text-amber-agent' },
  list_processes: { gerund: 'Listing processes', past: 'Listed processes', icon: 'terminal', color: 'text-amber-agent' },
  stop_process: { gerund: 'Stopping', past: 'Stopped', icon: 'terminal', color: 'text-red-agent' },
  create_checkpoint: { gerund: 'Checkpointing', past: 'Checkpointed', icon: 'git', color: 'text-violet-agent' },
  list_checkpoints: { gerund: 'Listing checkpoints', past: 'Listed checkpoints', icon: 'git', color: 'text-violet-agent' },
  revert_to_checkpoint: { gerund: 'Reverting', past: 'Reverted', icon: 'git', color: 'text-red-agent' },
  rename_symbol: { gerund: 'Renaming', past: 'Renamed', icon: 'edit', color: 'text-blue-agent' },
  browser_control: { gerund: 'Using the browser', past: 'Used the browser', icon: 'browser', color: 'text-violet-agent' },
  computer_control: { gerund: 'Controlling the screen', past: 'Controlled the screen', icon: 'browser', color: 'text-violet-agent' },

  /*
   * THE REST OF THE REGISTRY.
   *
   * Everything the backend can call belongs in this table. A tool missing from
   * it fell through to the generic entry, and the generic entry's past tense
   * was the word "Did" — so a transcript full of real work read as "Did watch",
   * "Did artifact", "Did forge". That is not a cosmetic problem: "Did artifact"
   * tells the reader nothing about what happened, which is the whole job of the
   * line.
   *
   * The rule for adding one: name the WORK, in the tense the reader is reading
   * it in, never the tool. `watch` is not "Watched"; it is "Waited for". `repo`
   * is not "Repo"; it is "Worked with the repository".
   */
  watch: { gerund: 'Waiting for', past: 'Waited for', icon: 'generic', color: 'text-amber-agent' },
  artifact: { gerund: 'Writing a document', past: 'Wrote a document', icon: 'spec', color: 'text-accent-bright' },
  preview_config: { gerund: 'Setting up the preview', past: 'Set up the preview', icon: 'config', color: 'text-cyan-agent' },
  send_process_input: { gerund: 'Answering', past: 'Answered', icon: 'terminal', color: 'text-amber-agent' },
  delegate_parallel: { gerund: 'Delegating in parallel', past: 'Delegated in parallel', icon: 'generic', color: 'text-violet-agent' },
  repo: { gerund: 'Working with the repository', past: 'Worked with the repository', icon: 'git', color: 'text-violet-agent' },
  forge: { gerund: 'Talking to GitHub', past: 'Talked to GitHub', icon: 'git', color: 'text-violet-agent' },
  set_phase: { gerund: 'Starting', past: 'Started', icon: 'generic', color: 'text-accent-bright' },
  git_commit: { gerund: 'Committing', past: 'Committed', icon: 'commit', color: 'text-green-agent' },
};

/**
 * A readable label for a tool nobody has written an entry for.
 *
 * The old fallback was the literal word "Did", which is worse than the raw tool
 * name: at least `mcp__linear__create_issue` contains the answer. Turning the
 * identifier into a sentence keeps a new or third-party tool legible on the day
 * it is added, without anyone having to remember to come back here.
 */
function humanizeUnknownTool(tool: string): { gerund: string; past: string; icon: ToolIconName; color: string } {
  if (tool.startsWith('mcp__')) {
    const leaf = tool.split('__').pop() ?? tool;
    const words = leaf.replace(/[_-]+/g, ' ').trim();
    return { gerund: `Using ${words}`, past: `Used ${words}`, icon: 'generic', color: 'text-violet-agent' };
  }
  const words = tool.replace(/[_-]+/g, ' ').trim();
  if (!words) return { gerund: 'Working', past: 'Worked', icon: 'generic', color: 'text-text-muted' };
  return { gerund: `Running ${words}`, past: `Ran ${words}`, icon: 'generic', color: 'text-text-muted' };
}

function targetFor(tool: string, args: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'update_plan': {
      // Describe the plan naturally: how many steps and the one in progress.
      const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
      if (steps.length === 0) return '';
      const done = steps.filter((s) => s.status === 'done').length;
      const active = steps.find((s) => s.status === 'in_progress');
      if (active && typeof active.title === 'string') {
        return `— now on “${clamp(active.title, 36)}”`;
      }
      if (done === steps.length) return `— all ${steps.length} steps done`;
      return `— ${done} of ${steps.length} steps done`;
    }
    case 'delegate_task':
      return args.instruction ? `“${clamp(String(args.instruction), 40)}”` : '';
    case 'ask_user':
      return args.question ? `“${clamp(String(args.question), 40)}”` : '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'get_file_outline':
    case 'read_config':
    case 'write_config':
    case 'append_file':
      return basename(args.path);
    case 'read_files':
      return Array.isArray(args.paths) ? `${(args.paths as unknown[]).length} file(s)` : '';
    case 'search': {
      const q = String(args.query ?? args.pattern ?? '');
      if (!q) return '';
      const shown = args.regex === true ? `/${clamp(q, 30)}/` : `"${clamp(q, 30)}"`;
      return args.target === 'filenames' ? `${shown} in filenames` : shown;
    }
    case 'grep_search':
      return args.pattern ? `/${clamp(String(args.pattern), 30)}/` : '';
    case 'find_files':
      return args.query ? `"${clamp(String(args.query), 30)}"` : '';
    case 'run_background':
      return clamp(String(args.command ?? ''), 52);
    case 'get_process_output':
    case 'stop_process':
      return args.process_id ? String(args.process_id) : '';
    case 'create_checkpoint':
      return args.label ? `"${clamp(String(args.label), 32)}"` : '';
    case 'revert_to_checkpoint':
      return args.checkpoint_id ? String(args.checkpoint_id) : '';
    case 'rename_symbol':
      return args.old_name && args.new_name ? `${args.old_name} → ${args.new_name}` : '';
    case 'list_directory':
    case 'get_file_tree':
      return args.path ? String(args.path) : 'workspace';
    case 'search_in_files':
      return args.query ? `"${clamp(String(args.query), 30)}"` : '';
    case 'run_command':
      return clamp(String(args.command ?? ''), 52);
    case 'git_add_and_commit':
      return args.message ? `"${clamp(String(args.message), 32)}"` : '';
    case 'create_spec':
      return args.title ? String(args.title) : '';
    case 'find_symbol':
    case 'find_references':
      return args.name ? String(args.name) : '';
    case 'get_repo_map':
      return args.focus ? clamp(String(args.focus), 32) : '';
    case 'validate_changes':
      return Array.isArray(args.files) ? `${(args.files as unknown[]).length} file(s)` : '';
    case 'gather_context':
      return args.task_description ? clamp(String(args.task_description), 32) : '';
    case 'set_phase':
      return args.label ? String(args.label) : '';
    case 'watch': {
      const kind = String(args.condition ?? '');
      if (kind === 'url_live' && args.url) return String(args.url);
      if (kind === 'port_open' && args.port) return `port ${args.port}`;
      if (kind === 'process_exit' && args.process_id) return `${args.process_id} to finish`;
      if (kind === 'output_match' && args.pattern) return `/${clamp(String(args.pattern), 30)}/`;
      if (kind === 'file_exists' && args.path) return basename(args.path);
      return '';
    }
    case 'artifact':
      return args.title ? clamp(String(args.title), 34) : args.id ? String(args.id) : '';
    case 'send_process_input':
      return args.input ? clamp(String(args.input), 30) : args.process_id ? String(args.process_id) : '';
    case 'delegate_parallel':
      return Array.isArray(args.tasks) ? `${(args.tasks as unknown[]).length} workers` : '';
    case 'repo':
      return args.branch ? String(args.branch) : args.url ? String(args.url) : args.message ? clamp(String(args.message), 30) : '';
    case 'forge':
      return args.title ? clamp(String(args.title), 34) : args.repo ? String(args.repo) : '';
    case 'browser_control': {
      const action = String(args.action ?? '');
      if ((action === 'open' || action === 'goto') && args.url) return String(args.url);
      if (action === 'click') return args.selector ? String(args.selector) : args.text ? `"${clamp(String(args.text), 30)}"` : '';
      if (action === 'type') return args.text ? `"${clamp(String(args.text), 30)}"` : '';
      if (action === 'press') return args.key ? String(args.key) : '';
      if (action === 'viewport') return args.preset ? String(args.preset) : (args.width && args.height) ? `${args.width}×${args.height}` : '';
      return '';
    }
    case 'computer_control': {
      const action = String(args.action ?? '');
      if (action === 'type') return args.text ? `"${clamp(String(args.text), 30)}"` : '';
      if (action === 'key') return Array.isArray(args.keys) ? (args.keys as unknown[]).join('+') : args.keys ? String(args.keys) : '';
      if (['click', 'double_click', 'right_click', 'move'].includes(action) && typeof args.x === 'number') return `(${args.x}, ${args.y})`;
      return '';
    }
    default:
      if (args.path) return basename(args.path);
      if (args.spec_id) return String(args.spec_id);
      return '';
  }
}

export function getToolDisplay(tool: string, args?: Record<string, unknown>): ToolDisplay {
  const clean = tool.replace(/^function:/, '');
  const base = MAP[clean] ?? humanizeUnknownTool(clean);
  // Multi-action tools (browser_control, computer_control) get a per-action verb
  // instead of the generic tool-level one, so the UI never shows a raw action
  // name or a bare "Did" fallback for e.g. a browser click or a screenshot.
  const actionVerb = args?.action ? ACTION_VERBS[clean]?.[String(args.action)] : undefined;
  return {
    gerund: actionVerb?.gerund ?? base.gerund,
    past: actionVerb?.past ?? base.past,
    target: targetFor(clean, args),
    icon: base.icon,
    color: base.color,
  };
}

/** The single-line label, e.g. "Reading index.html" / "Read index.html". */
export function toolLabel(tool: string, args: Record<string, unknown> | undefined, done: boolean): string {
  const d = getToolDisplay(tool, args);
  const verb = done ? d.past : d.gerund;
  return d.target ? `${verb} ${d.target}` : verb;
}


/**
 * One sentence describing a run of tool calls.
 *
 * The old summary was a count table — "3 read · 2 edited" — which is accurate,
 * unreadable, and says nothing about WHAT. Three reads of which files? Edited
 * what? A reader scanning a transcript needs the nouns, and the header had room
 * for them: it was capped at a handful of words for no reason other than that
 * counts are short.
 *
 * So this reads like a sentence, names things while there are few enough of
 * them to name, and falls back to counts only when a list would be longer than
 * the fact it conveys.
 */
export function summariseSteps(
  steps: Array<{ tool: string; args?: Record<string, unknown>; isError?: boolean }>,
): string {
  if (steps.length === 0) return 'no steps';

  /** Consecutive steps sharing a verb collapse into one phrase. */
  type Run = { verb: string; targets: string[] };
  const runs: Run[] = [];
  for (const s of steps) {
    const d = getToolDisplay(s.tool, s.args);
    const verb = d.past;
    const target = d.target;
    const last = runs[runs.length - 1];
    if (last && last.verb === verb) {
      if (target) last.targets.push(target);
    } else {
      runs.push({ verb, targets: target ? [target] : [] });
    }
  }

  const phrase = (r: Run, index: number): string => {
    // Only the first phrase keeps its capital; the rest read as clauses.
    const verb = index === 0 ? r.verb : r.verb.charAt(0).toLowerCase() + r.verb.slice(1);
    if (r.targets.length === 0) return verb;
    if (r.targets.length === 1) return `${verb} ${r.targets[0]}`;
    if (r.targets.length === 2) return `${verb} ${r.targets[0]} and ${r.targets[1]}`;
    // Three or more: name the first two, count the rest. Naming five files is
    // not more informative than naming two and saying how many more there were.
    return `${verb} ${r.targets[0]}, ${r.targets[1]} and ${r.targets.length - 2} more`;
  };

  const parts = runs.slice(0, 4).map(phrase);
  if (runs.length > 4) parts.push(`${runs.length - 4} more steps`);

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]}, then ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
}

/** "Reading src/app.ts" — the live headline while a step is in flight. */
export function activeStepLabel(tool: string, args?: Record<string, unknown>): string {
  const d = getToolDisplay(tool, args);
  return d.target ? `${d.gerund} ${d.target}` : d.gerund;
}


/* ------------------------------------------------------------------------- *
 * PHASES
 *
 * A burst of twenty tool calls is almost never twenty things. It is three or
 * four: build it, find out why it broke, fix it, check. The agent names those
 * itself with set_phase (and implicitly whenever a plan step goes in progress),
 * and that is by far the best label available — it knows what it was trying to
 * do, and nothing else does.
 *
 * But models forget, older threads predate the tool entirely, and a worker
 * sub-agent may never call it. So a burst with no label still gets one, read
 * off the SHAPE of the steps. The heuristic is deliberately coarse: it names
 * the kind of work, never invents a specific claim, and it is only ever used
 * where the agent said nothing.
 * ------------------------------------------------------------------------- */

export interface PhaseLabel {
  label: string;
  detail?: string;
  /** Where the label came from. 'inferred' is styled more quietly than a label
   *  the agent actually wrote, because it is a guess and should read as one. */
  source: 'agent' | 'plan' | 'inferred';
}

const READ_TOOLS = new Set([
  'read_file', 'read_files', 'list_directory', 'get_file_tree', 'search', 'search_in_files',
  'grep_search', 'find_files', 'get_repo_map', 'find_symbol', 'find_references',
  'get_file_outline', 'gather_context', 'read_config', 'get_process_output', 'list_processes',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'append_file', 'delete_file', 'create_directory',
  'write_config', 'rename_symbol', 'artifact',
]);
const GIT_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_add_and_commit', 'git_commit', 'repo', 'forge']);
const RUN_TOOLS = new Set(['run_command', 'run_background', 'watch', 'send_process_input', 'stop_process', 'validate_changes']);

/** Does this command read as a test run, a build, or an install? */
function commandKind(args: Record<string, unknown> | undefined): 'test' | 'build' | 'install' | 'other' {
  const cmd = String(args?.command ?? '').toLowerCase();
  if (!cmd) return 'other';
  if (/\b(test|jest|vitest|pytest|mocha|go test|cargo test)\b/.test(cmd)) return 'test';
  if (/\b(install|add)\b/.test(cmd) && /\b(npm|pnpm|yarn|bun|pip|cargo|go get)\b/.test(cmd)) return 'install';
  if (/\b(build|tsc|compile|webpack|vite build|cargo build|make)\b/.test(cmd)) return 'build';
  return 'other';
}

/**
 * Name a run of steps the agent did not name itself.
 *
 * Reads as a phase, not as a tally: the reader wants "Fixing what failed", not
 * "4 edits and 2 commands".
 */
export function inferPhase(
  steps: Array<{ tool: string; args?: Record<string, unknown>; isError?: boolean; done?: boolean }>,
  /** Did the run BEFORE this one end in an error? That changes what this one is. */
  followsFailure = false,
): string {
  if (steps.length === 0) return 'Working';

  const clean = steps.map((st) => ({ ...st, tool: st.tool.replace(/^function:/, '') }));
  const count = (pred: (t: { tool: string; args?: Record<string, unknown> }) => boolean) =>
    clean.filter(pred).length;

  const reads = count((t) => READ_TOOLS.has(t.tool));
  const writes = count((t) => WRITE_TOOLS.has(t.tool));
  const gits = count((t) => GIT_TOOLS.has(t.tool));
  const runs = count((t) => RUN_TOOLS.has(t.tool));
  const errored = clean.some((st) => st.isError);
  const installs = count((t) => commandKind(t.args) === 'install');
  const tests = count((t) => commandKind(t.args) === 'test');
  const builds = count((t) => commandKind(t.args) === 'build');

  // A failure in the middle of a run is the most informative thing in it.
  if (errored && writes > 0) return 'Fixing what failed';
  if (errored) return 'Working out what went wrong';
  if (followsFailure && writes > 0) return 'Fixing what failed';
  if (followsFailure && reads > 0 && writes === 0) return 'Working out what went wrong';

  if (installs > 0 && installs >= writes) return 'Installing dependencies';
  if (tests > 0 && writes === 0) return 'Running the tests';
  if (builds > 0 && writes === 0) return 'Building the project';
  if (clean.some((t) => t.tool === 'watch' || t.tool === 'run_background')) return 'Starting it up';
  if (clean.some((t) => t.tool === 'browser_control' || t.tool === 'computer_control')) return 'Checking it in the browser';
  if (gits > reads && gits >= writes) return 'Working with git';
  if (writes > 0 && reads > 0) return 'Making the changes';
  if (writes > 0) return 'Writing the code';
  if (reads > 0) return 'Reading the code';
  if (runs > 0) return 'Running commands';
  return 'Working';
}

/**
 * Split a burst into labelled phases.
 *
 * Consecutive steps sharing a phase label collapse into one segment. Steps the
 * agent labelled keep their label verbatim; an unlabelled stretch is inferred
 * from its own shape, and told whether the stretch before it ended badly —
 * which is the difference between "Reading the code" and "Working out what went
 * wrong".
 */
export function segmentByPhase<T extends {
  tool: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  done?: boolean;
  phase?: { label: string; detail?: string; source: 'agent' | 'plan' };
}>(steps: T[]): Array<{ phase: PhaseLabel; steps: T[] }> {
  if (steps.length === 0) return [];

  // First pass: contiguous runs sharing an explicit label (or sharing "none").
  const runs: Array<{ label: string | null; detail?: string; source?: 'agent' | 'plan'; steps: T[] }> = [];
  for (const st of steps) {
    const label = st.phase?.label ?? null;
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.steps.push(st);
    else runs.push({ label, detail: st.phase?.detail, source: st.phase?.source, steps: [st] });
  }

  // Second pass: name the unlabelled runs.
  return runs.map((run, i) => {
    if (run.label) {
      return { phase: { label: run.label, detail: run.detail, source: run.source ?? 'agent' }, steps: run.steps };
    }
    const previous = runs[i - 1];
    const followsFailure = !!previous && previous.steps.some((st) => st.isError);
    return { phase: { label: inferPhase(run.steps, followsFailure), source: 'inferred' as const }, steps: run.steps };
  });
}
