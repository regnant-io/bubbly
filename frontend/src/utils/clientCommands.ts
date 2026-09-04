import type { RightContextId } from '../store';

/**
 * The slash commands the APP performs, rather than the agent.
 *
 * The catalogue is served by the backend (/api/settings/commands) so the
 * desktop app and the terminal client offer the same commands under the same
 * names — the same reason workflows are expanded server-side. What lives here
 * is only the behaviour, because the behaviour genuinely differs: `/plan` opens
 * a panel here and prints a checklist there, and pretending those are the same
 * action would make one of them worse.
 *
 * THE RULE FOR ADDING ONE
 *
 * It either does something real or it is not in the catalogue for this surface.
 * `/bg` and `/verbose` are terminal-only and are filtered out server-side, so
 * this file never has to render a command that would do nothing.
 */

export interface ClientCommandDef {
  command: string;
  title: string;
  description: string;
  group: string;
  icon: string;
  argHint?: string;
  aliases?: string[];
}

export interface ClientCommandContext {
  /** Everything after the command word, trimmed. */
  arg: string;
  workspacePath: string;
  currentSessionId: string | null;
  /** Post an informational card into the transcript, from Bubbly not the model. */
  notice: (title: string, body: string) => void;
  /** Send a prompt to the agent as if the user had typed it. */
  prompt: (text: string) => void;
  openPanel: (id: RightContextId) => void;
  goToPanel: (panel: 'chat' | 'threads' | 'files' | 'specs' | 'settings' | 'workspace') => void;
  openSettings: (category?: string) => void;
  newThread: () => void;
  openThread: (id: string) => void;
  switchWorkspace: (path: string) => void;
  stop: () => void;
  attachClipboardImage: () => Promise<boolean>;
  contextUsage: { usedTokens: number; usableTokens: number; windowTokens: number; model: string; source: string } | null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Prompts that are genuinely prompts.
 *
 * `/init` and `/todos` are work for the AGENT — there is no API call that reads
 * a codebase and writes a brief. Keeping their wording HERE, next to the
 * commands that are not prompts, is what stops the distinction blurring: if a
 * command's implementation is a string, it belongs in this table and the reader
 * can see at a glance which commands ask the model and which do not.
 */
const AGENT_PROMPTS: Record<string, string> = {
  init:
    'Write BUBBLY.md at the root of this workspace: the standing brief every future thread starts from.\n\n' +
    'Read the codebase first — the package manifests, the directory layout, the build and test scripts, the entry ' +
    'points — and then write, concisely:\n' +
    '- what this project IS, in two or three sentences\n' +
    '- how to run it, test it and build it, using the commands that actually exist here\n' +
    '- the shape of the code: which directory holds what, and the one or two decisions someone must know before editing\n' +
    '- anything surprising: a generated file, a required env var, a step that looks optional and is not\n\n' +
    'Do not pad it. If BUBBLY.md already exists, read it and improve it rather than replacing it wholesale.',
  todos:
    'Search this workspace for TODO, FIXME, HACK and XXX comments. Group them by file, quote each one with its line ' +
    'number, and say briefly which look like real outstanding work and which are stale notes. Do not fix anything.',
  compact:
    'Summarise everything that matters from this conversation so far: the goal, the decisions taken and why, what is ' +
    'done, what is left, and any constraint you have discovered. Be specific about file paths and names. Do not take ' +
    'any action — this summary is the whole task.',
};

/** Run a client command. Returns false if the name is not one of ours. */
export async function runClientCommand(
  name: string,
  ctx: ClientCommandContext,
  catalogue: ClientCommandDef[],
): Promise<boolean> {
  const word = name.replace(/^\//, '').toLowerCase();
  const entry = catalogue.find((c) => c.command === word || c.aliases?.includes(word));
  if (!entry) return false;

  switch (entry.command) {
    case 'new':
      ctx.newThread();
      return true;

    case 'threads':
      ctx.goToPanel('threads');
      return true;

    case 'resume': {
      if (!ctx.arg) { ctx.goToPanel('threads'); return true; }
      ctx.openThread(ctx.arg);
      return true;
    }

    case 'cd': {
      if (!ctx.arg) {
        ctx.notice('Workspace', `Currently working in \`${ctx.workspacePath || 'nowhere — set one in Settings'}\`.`);
        return true;
      }
      ctx.switchWorkspace(ctx.arg);
      return true;
    }

    case 'stop':
      ctx.stop();
      return true;

    case 'plan':
      ctx.openPanel('plans');
      return true;

    case 'watch':
      ctx.openPanel('watchers');
      return true;

    case 'agents':
      ctx.openPanel('tasks');
      return true;

    case 'diff':
      ctx.openPanel('diff');
      return true;

    case 'preview':
      ctx.openPanel('preview');
      return true;

    case 'approve':
      ctx.openSettings('safety');
      return true;

    case 'context': {
      const u = ctx.contextUsage;
      if (!u || u.usableTokens <= 0) {
        ctx.notice('Context', 'Nothing measured yet — context is reported live once the agent has run at least once in this thread.');
        return true;
      }
      const pct = Math.round((u.usedTokens / u.usableTokens) * 100);
      ctx.notice(
        'Context',
        `**${pct}%** of the usable window.\n\n` +
        `- used: ${u.usedTokens.toLocaleString()} tokens\n` +
        `- usable: ${u.usableTokens.toLocaleString()}\n` +
        `- window: ${u.windowTokens.toLocaleString()} (${u.source})\n` +
        `- model: \`${u.model}\`\n\n` +
        'Older turns are condensed automatically near 85%, and the thread continues in a fresh one if it gets closer than that.',
      );
      return true;
    }

    case 'cost': {
      try {
        const stats = await fetch('/api/sessions/stats').then((r) => r.json()) as {
          sessions: number; messages: number; totalTokens: number; activeDays: number;
          currentStreak: number; longestStreak: number; favoriteModel?: string;
        };
        ctx.notice(
          'Usage',
          `- threads: ${stats.sessions}\n` +
          `- messages: ${fmt(stats.messages)}\n` +
          `- tokens: ${fmt(stats.totalTokens)}\n` +
          `- active days: ${stats.activeDays} (streak ${stats.currentStreak}, best ${stats.longestStreak})\n` +
          (stats.favoriteModel ? `- most used: \`${stats.favoriteModel}\`\n` : '') +
          '\nBubbly does not price your tokens: a local model costs nothing, and an API key’s rate is between you and your provider.',
        );
      } catch {
        ctx.notice('Usage', 'Could not read usage statistics from the backend.');
      }
      return true;
    }

    case 'paste': {
      const ok = await ctx.attachClipboardImage();
      if (!ok) {
        ctx.notice(
          'Paste',
          'No image on the clipboard, or the browser refused clipboard access. You can also drag an image onto the composer, or use the paperclip.',
        );
      }
      return true;
    }

    case 'checkpoint': {
      const [sub, ...rest] = ctx.arg.split(/\s+/);
      if (sub === 'restore' && rest[0]) {
        ctx.prompt(`Revert the workspace to checkpoint ${rest[0]} using revert_to_checkpoint, then say exactly what changed back.`);
      } else if (sub === 'list' || !sub) {
        ctx.prompt('List the workspace checkpoints with list_checkpoints and show them as a short table.');
      } else {
        ctx.prompt(`Create a workspace checkpoint labelled "${ctx.arg}" with create_checkpoint.`);
      }
      return true;
    }

    case 'model':
    case 'config':
      ctx.openSettings(entry.command === 'model' ? 'providers' : 'general');
      return true;

    case 'mcp':
      ctx.openSettings('mcp');
      return true;

    case 'connect':
      ctx.openSettings('connections');
      return true;

    case 'tools': {
      try {
        const { tools } = await fetch('/api/settings/tools').then((r) => r.json()) as {
          tools: Array<{ name: string; description: string }>;
        };
        ctx.notice(
          'Tools',
          `The agent can call **${tools.length}** tools in this workspace.\n\n` +
          tools.map((t) => `- \`${t.name}\` — ${t.description.split('\n')[0]}`).join('\n'),
        );
      } catch {
        ctx.notice('Tools', 'Could not read the tool list from the backend.');
      }
      return true;
    }

    case 'status': {
      try {
        const status = await fetch('/api/status').then((r) => r.json()) as {
          running: Array<{ id: string; title: string; queued: number }>;
          backgroundProcesses: Array<{ id: string; command: string; url: string | null }>;
          watchers: number;
        };
        const lines: string[] = [];
        lines.push(`- workspace: \`${ctx.workspacePath || 'not set'}\``);
        lines.push(`- thread: ${ctx.currentSessionId ? `\`${ctx.currentSessionId}\`` : 'none yet'}`);
        lines.push('');
        if (status.running.length === 0 && status.backgroundProcesses.length === 0) {
          lines.push('Nothing is running.');
        } else {
          for (const t of status.running) lines.push(`- **working**: ${t.title}${t.queued ? ` (${t.queued} queued)` : ''}`);
          for (const p of status.backgroundProcesses) lines.push(`- **process**: \`${p.command}\`${p.url ? ` → ${p.url}` : ''}`);
          if (status.watchers > 0) lines.push(`- ${status.watchers} wait(s) active`);
        }
        ctx.notice('Status', lines.join('\n'));
      } catch {
        ctx.notice('Status', 'Could not reach the backend.');
      }
      return true;
    }

    case 'doctor':
      ctx.openSettings('providers');
      ctx.notice(
        'Doctor',
        'Settings is open on Providers, where a missing API key or an unreachable Ollama shows itself. ' +
        'For a full check including the credential vault and the WebSocket, run `bubbly doctor` in a terminal.',
      );
      return true;

    case 'help': {
      const groups = new Map<string, ClientCommandDef[]>();
      for (const c of catalogue) {
        const list = groups.get(c.group);
        if (list) list.push(c); else groups.set(c.group, [c]);
      }
      const body = [...groups.entries()]
        .map(([group, items]) =>
          `**${group}**\n${items.map((c) => `- \`/${c.command}${c.argHint ? ` ${c.argHint}` : ''}\` — ${c.description}`).join('\n')}`,
        )
        .join('\n\n');
      ctx.notice('Commands', `${body}\n\nWorkflows (\`/fix\`, \`/implement\`, \`/review\`…) are listed in the same picker and run as multi-phase jobs.`);
      return true;
    }

    default: {
      const promptText = AGENT_PROMPTS[entry.command];
      if (promptText) { ctx.prompt(promptText); return true; }
      return false;
    }
  }
}
