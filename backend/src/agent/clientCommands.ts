/**
 * Slash commands that the CLIENT performs, catalogued on the SERVER.
 *
 * THE DISTINCTION THAT MAKES THIS NECESSARY
 *
 * A workflow (workflows.ts) is a prompt program: the server expands `/fix` into
 * several hundred words and hands them to the agent. That is the right shape for
 * anything whose answer is "the agent does some work".
 *
 * `/model`, `/clear`, `/cost`, `/config` are not that. There is no prompt that
 * changes the active model, and writing one would be a lie — the agent cannot
 * do it, the client can. They are ACTIONS ON THE CLIENT, and the client is
 * where they have to run.
 *
 * WHY THE CATALOGUE STILL LIVES HERE
 *
 * Because there are two clients. The desktop app and the CLI both present a
 * slash menu, and if each kept its own list they would drift within a week:
 * a command in one and not the other, the same name meaning different things,
 * two help texts that disagree. The architecture note about the CLI being a
 * client rather than a second agent applies exactly as much to the command
 * surface as it does to the agent loop.
 *
 * So: the LIST is served (GET /api/settings/commands), the BEHAVIOUR is
 * implemented per client, and `surfaces` says honestly where each one works —
 * `/paste` needs a clipboard and a composer, `/bg` needs a terminal, and
 * pretending otherwise would put dead entries in one of the two menus.
 */

export type CommandSurface = 'desktop' | 'cli';

export interface ClientCommand {
  /** What the user types, without the slash. */
  command: string;
  /** Short title for the picker. */
  title: string;
  /** One line, in the imperative, saying what happens. */
  description: string;
  group: 'session' | 'agent' | 'context' | 'project' | 'settings' | 'help';
  /** Lucide icon name, resolved by the desktop client. */
  icon: string;
  /** Where this command actually does something. */
  surfaces: CommandSurface[];
  /** Free-text argument hint, shown after the command name. */
  argHint?: string;
  /** Aliases accepted for the same command. */
  aliases?: string[];
}

export const CLIENT_COMMANDS: ClientCommand[] = [
  // ---------------------------------------------------------------- session
  {
    command: 'new', title: 'New thread', group: 'session', icon: 'MessageSquare',
    description: 'Start a fresh thread. The current one is kept and can be reopened.',
    surfaces: ['desktop', 'cli'], aliases: ['clear'],
  },
  {
    command: 'threads', title: 'Threads', group: 'session', icon: 'ListTree',
    description: 'List recent threads and open one.',
    surfaces: ['desktop', 'cli'], aliases: ['chat'],
  },
  {
    command: 'resume', title: 'Resume a thread', group: 'session', icon: 'RefreshCw',
    description: 'Reopen a thread by id and carry on where it stopped.',
    surfaces: ['desktop', 'cli'], argHint: '<thread id>',
  },
  {
    command: 'cd', title: 'Change workspace', group: 'session', icon: 'FolderPlus',
    description: 'Point Bubbly at another directory. Starts a new thread, since the code is different.',
    surfaces: ['desktop', 'cli'], argHint: '<path>',
  },

  // ------------------------------------------------------------------ agent
  {
    command: 'stop', title: 'Stop the agent', group: 'agent', icon: 'Square',
    description: 'Halt the running turn. Cancels its waits so nothing wakes it back up.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'plan', title: 'Plan', group: 'agent', icon: 'ClipboardList',
    description: 'Show the working plan for this thread and how far through it the agent is.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'watch', title: 'Waits', group: 'agent', icon: 'Clock',
    description: 'What the agent is waiting on, with the option to skip a wait it will never finish.',
    surfaces: ['desktop', 'cli'], argHint: '[skip <id>]',
  },
  {
    command: 'approve', title: 'Approval policy', group: 'agent', icon: 'ShieldCheck',
    description: 'Whether the agent asks before acting: ask, auto or deny.',
    surfaces: ['desktop', 'cli'], argHint: '[ask|auto|deny]',
  },
  {
    command: 'agents', title: 'Workers', group: 'agent', icon: 'Zap',
    description: 'Show the delegated workers this thread has run and what each reported.',
    surfaces: ['desktop', 'cli'],
  },

  // ---------------------------------------------------------------- context
  {
    command: 'context', title: 'Context usage', group: 'context', icon: 'Gauge',
    description: 'How much of the model’s window this thread is using, and what is in it.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'compact', title: 'Compact the thread', group: 'context', icon: 'ChevronUp',
    description: 'Summarise the older turns now instead of waiting for the automatic pass.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'cost', title: 'Usage and cost', group: 'context', icon: 'Gauge',
    description: 'Tokens used, threads, messages and the busiest days.',
    surfaces: ['desktop', 'cli'], aliases: ['usage'],
  },
  {
    command: 'paste', title: 'Paste an image', group: 'context', icon: 'FilePlus',
    description: 'Attach whatever image is on the clipboard to the next message.',
    surfaces: ['desktop'],
  },

  // ---------------------------------------------------------------- project
  {
    command: 'init', title: 'Write the project brief', group: 'project', icon: 'BookOpen',
    description: 'Read the codebase and write BUBBLY.md — the standing brief every thread starts from.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'todos', title: 'TODOs', group: 'project', icon: 'CheckCircle',
    description: 'Find the TODO / FIXME / HACK comments in the workspace.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'checkpoint', title: 'Checkpoints', group: 'project', icon: 'GitBranch',
    description: 'Snapshot the workspace, or list and restore an earlier snapshot.',
    surfaces: ['desktop', 'cli'], argHint: '[list|restore <id>]', aliases: ['rewind'],
  },
  {
    command: 'diff', title: 'Changes', group: 'project', icon: 'GitBranch',
    description: 'What this thread has changed on disk, file by file.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'bg', title: 'Background processes', group: 'project', icon: 'Terminal',
    description: 'Start, list, read and stop long-running commands that outlive the terminal.',
    surfaces: ['cli'], argHint: '[list|start <cmd>|logs <id>|stop <id>|stop-all]',
  },
  {
    command: 'preview', title: 'Preview', group: 'project', icon: 'Monitor',
    description: 'Start the project’s dev server and show where it is serving.',
    surfaces: ['desktop', 'cli'],
  },

  // --------------------------------------------------------------- settings
  {
    command: 'model', title: 'Model', group: 'settings', icon: 'Zap',
    description: 'Show or change the model this thread talks to.',
    surfaces: ['desktop', 'cli'], argHint: '[name]',
  },
  {
    command: 'config', title: 'Settings', group: 'settings', icon: 'Wrench',
    description: 'Read or change a setting by name.',
    surfaces: ['desktop', 'cli'], argHint: '[key] [value]',
  },
  {
    command: 'tools', title: 'Tools', group: 'settings', icon: 'Wrench',
    description: 'Every tool the agent can call, and what each one is for.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'mcp', title: 'MCP servers', group: 'settings', icon: 'Server',
    description: 'Connected MCP servers and the tools they contribute.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'connect', title: 'Connections', group: 'settings', icon: 'Server',
    description: 'SSH hosts, GitHub/GitLab accounts, and what Bubbly can already authenticate with.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'status', title: 'Status', group: 'settings', icon: 'Monitor',
    description: 'Backend, model, workspace, running threads and background processes.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'doctor', title: 'Doctor', group: 'settings', icon: 'ShieldCheck',
    description: 'Check everything Bubbly needs is present and working, and say what is not.',
    surfaces: ['desktop', 'cli'],
  },

  // ------------------------------------------------------------------- help
  {
    command: 'help', title: 'Help', group: 'help', icon: 'BookOpen',
    description: 'Every command, grouped, with what it does.',
    surfaces: ['desktop', 'cli'],
  },
  {
    command: 'verbose', title: 'Verbose output', group: 'help', icon: 'ListTree',
    description: 'Show or hide tool calls, command output and diffs.',
    surfaces: ['cli'],
  },
  {
    command: 'exit', title: 'Exit', group: 'help', icon: 'X',
    description: 'Leave the terminal client. Anything running in the background keeps running.',
    surfaces: ['cli'], aliases: ['quit'],
  },
];

/** Commands available on one surface, in menu order. */
export function commandsFor(surface: CommandSurface): ClientCommand[] {
  return CLIENT_COMMANDS.filter((c) => c.surfaces.includes(surface));
}

/** Resolve a typed word to a command, honouring aliases. */
export function resolveCommand(word: string, surface: CommandSurface): ClientCommand | null {
  const w = word.replace(/^\//, '').toLowerCase();
  return (
    commandsFor(surface).find((c) => c.command === w || c.aliases?.includes(w)) ?? null
  );
}
