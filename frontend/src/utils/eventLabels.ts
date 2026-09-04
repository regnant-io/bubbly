/**
 * Turning internal identifiers into words.
 *
 * The audit log and the thread list were rendering raw keys — `vibe_coding`,
 * `tool_result`, `edit_file`, `session_idle`. Those are database values, and
 * showing them to a person is a small failure repeated on every row: it looks
 * unfinished, it is harder to scan than prose, and it leaks a naming scheme
 * nobody outside the codebase has any reason to learn.
 *
 * The rule applied here is that a label should say what HAPPENED, in the tense
 * the reader is reading it in. `tool_call` is not "Tool Call"; it is "Ran a
 * tool". `session_idle` is not "Session Idle"; it is "Finished".
 *
 * Anything unknown is title-cased rather than passed through, so a new event
 * type added later degrades to "Some New Event" instead of `some_new_event`.
 */

export interface EventLabel {
  /** What to show. */
  label: string;
  /** A one-line explanation, for a tooltip or an expanded row. */
  detail?: string;
  /** Semantic weight, for colour. */
  tone: 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';
}

const AUDIT_LABELS: Record<string, EventLabel> = {
  session_created: { label: 'Thread started', tone: 'accent' },
  session_running: { label: 'Agent started working', tone: 'accent' },
  session_idle: { label: 'Finished', detail: 'The agent completed its turn and handed control back.', tone: 'positive' },
  session_complete: { label: 'Turn complete', tone: 'positive' },
  error: { label: 'Error', tone: 'danger' },

  tool_call: { label: 'Ran a tool', tone: 'neutral' },
  tool_result: { label: 'Tool finished', tone: 'neutral' },
  tool_error: { label: 'Tool failed', tone: 'danger' },
  tool_auto_declined: {
    label: 'Blocked automatically',
    detail: 'The call was rejected before running because its arguments were invalid.',
    tone: 'warning',
  },

  approval_approved: { label: 'You approved', tone: 'positive' },
  approval_rejected: { label: 'You declined', tone: 'warning' },
  approval_timeout: {
    label: 'Approval expired',
    detail: 'Nobody answered before the request expired, so the action was not taken.',
    tone: 'warning',
  },

  ask_user: { label: 'Asked you a question', tone: 'accent' },
  delegate_task: { label: 'Delegated to a worker', tone: 'accent' },
  delegate_parallel: { label: 'Delegated in parallel', tone: 'accent' },
  mcp_tool: { label: 'Used an MCP tool', tone: 'neutral' },
  context_migrated: {
    label: 'Continued in a fresh thread',
    detail: 'The context limit was approaching, so the work moved to a new thread with a handoff summary.',
    tone: 'warning',
  },
};

/** Tools, as verbs. Shared with the transcript so the two never disagree. */
const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read a file',
  read_files: 'Read several files',
  write_file: 'Created a file',
  edit_file: 'Edited a file',
  append_file: 'Appended to a file',
  delete_file: 'Deleted a file',
  create_directory: 'Created a folder',
  list_directory: 'Listed a folder',
  get_file_tree: 'Mapped the file tree',
  search: 'Searched',
  find_symbol: 'Looked up a symbol',
  find_references: 'Found references',
  get_file_outline: 'Outlined a file',
  get_repo_map: 'Mapped the codebase',
  gather_context: 'Gathered context',
  run_command: 'Ran a command',
  run_background: 'Started a background process',
  get_process_output: 'Read process output',
  send_process_input: 'Answered a process',
  list_processes: 'Listed processes',
  stop_process: 'Stopped a process',
  watch: 'Waited on something',
  update_plan: 'Updated the plan',
  artifact: 'Wrote a document',
  ask_user: 'Asked you a question',
  delegate_task: 'Delegated work',
  delegate_parallel: 'Delegated work in parallel',
  validate_changes: 'Validated the changes',
  read_config: 'Read the config',
  write_config: 'Wrote the config',
  preview_config: 'Set up the preview',
  browser_control: 'Used the browser',
  computer_control: 'Controlled the screen',
  create_checkpoint: 'Created a checkpoint',
  list_checkpoints: 'Listed checkpoints',
  revert_to_checkpoint: 'Reverted to a checkpoint',
  rename_symbol: 'Renamed a symbol',
  git_status: 'Checked git status',
  git_diff: 'Read the diff',
  git_log: 'Read the history',
  git_add_and_commit: 'Committed',
  repo: 'Worked with the repository',
  forge: 'Talked to GitHub/GitLab',
};

/** Title Case as a last resort, so an unknown key still reads as English. */
function titleCase(raw: string): string {
  const words = raw.replace(/^mcp__/, '').replace(/[_-]+/g, ' ').trim();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditEventLabel(eventType: string, tool?: string): EventLabel {
  // A tool name is more specific than the event that carried it, and more
  // useful: "Edited a file" beats "Tool finished" every time.
  if (tool) {
    const clean = tool.replace(/^function:/, '');
    const known = TOOL_LABELS[clean];
    if (known) {
      return {
        label: known,
        tone: eventType === 'tool_error' ? 'danger' : eventType === 'tool_auto_declined' ? 'warning' : 'neutral',
      };
    }
    if (clean.startsWith('mcp__')) {
      return { label: `MCP · ${titleCase(clean.split('__').pop() ?? clean)}`, tone: 'neutral' };
    }
    return { label: titleCase(clean), tone: 'neutral' };
  }

  return AUDIT_LABELS[eventType] ?? { label: titleCase(eventType), tone: 'neutral' };
}

export function toolLabelFor(tool: string): string {
  const clean = tool.replace(/^function:/, '');
  return TOOL_LABELS[clean] ?? titleCase(clean);
}

/** Thread types, as the words a person would use. */
export function threadTypeLabel(threadType: string): { label: string; blurb: string } {
  switch (threadType) {
    case 'spec_session':
      return { label: 'Spec', blurb: 'Requirements, design and tasks before any code' };
    case 'vibe_coding':
      return { label: 'Vibe', blurb: 'Straight to the work, conversational' };
    default:
      return { label: titleCase(threadType), blurb: '' };
  }
}

/** Session status, as a state rather than an enum value. */
export function statusLabel(status: string): EventLabel {
  switch (status) {
    case 'running': return { label: 'Working', tone: 'accent' };
    case 'idle': return { label: 'Idle', tone: 'neutral' };
    case 'done': return { label: 'Done', tone: 'positive' };
    case 'error': return { label: 'Stopped with an error', tone: 'danger' };
    case 'active': return { label: 'Active', tone: 'accent' };
    default: return { label: titleCase(status), tone: 'neutral' };
  }
}

export const TONE_CLASS: Record<EventLabel['tone'], string> = {
  neutral: 'text-text-muted',
  positive: 'text-green-agent',
  warning: 'text-amber-agent',
  danger: 'text-red-agent',
  accent: 'text-accent-bright',
};
