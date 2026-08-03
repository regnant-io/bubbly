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
};

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
  const base = MAP[clean] ?? { gerund: 'Working', past: 'Did', icon: 'generic' as ToolIconName, color: 'text-text-muted' };
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
