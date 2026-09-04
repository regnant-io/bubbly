import chalk from 'chalk';
import path from 'path';
import { BubblyClient } from '../client';
import { Renderer } from '../ui/render';
import { renderMarkdown } from '../ui/markdown';

/**
 * The slash commands the TERMINAL performs, rather than the agent.
 *
 * `/model`, `/status`, `/bg`, `/cost` are not prompts. No wording sent to a
 * model changes which model is answering, and writing a prompt that pretends
 * otherwise is how a command surface stops being trustworthy. These run here,
 * against the backend's REST API, and print their answer directly.
 *
 * The CATALOGUE they are drawn from is served by the backend
 * (/api/settings/commands) so the desktop app and the terminal cannot end up
 * offering different commands under the same names — the same reason workflows
 * are expanded server-side. What lives here is only the behaviour.
 *
 * EVERY COMMAND EITHER DOES SOMETHING OR SAYS WHY NOT. There are no entries
 * that print "not implemented": a command that cannot work on this surface is
 * filtered out of the catalogue before it is ever shown.
 */

export interface CommandContext {
  client: BubblyClient;
  renderer: Renderer;
  workspacePath: string;
  sessionId: string | undefined;
  /** Whether a turn is in flight right now. */
  running: boolean;
  /** Mutate REPL state. Each returns the new value so the caller can persist it. */
  setWorkspace: (p: string) => void;
  setSessionId: (id: string | undefined) => void;
  setVerbose: (v: boolean) => boolean;
  setApprovalPolicy: (p: 'ask' | 'auto' | 'deny') => void;
  approvalPolicy: 'ask' | 'auto' | 'deny';
  verbose: boolean;
  /** Send a prompt to the agent as if the user had typed it. */
  sendPrompt: (message: string) => Promise<void>;
  /** Ask the user a question at the prompt. */
  ask: (question: string) => Promise<string>;
  exit: () => void;
}

/** The result of running a local command. */
export type CommandOutcome = 'handled' | 'unknown';

const out = (text: string) => process.stdout.write(text);
const line = (text = '') => out(`${text}\n`);

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** `key  value` rows, aligned, with the label dimmed. */
function rows(pairs: Array<[string, string]>, indent = '    '): void {
  const width = Math.max(...pairs.map(([k]) => k.length), 0);
  for (const [k, v] of pairs) line(`${indent}${chalk.dim(k.padEnd(width + 2))}${v}`);
}

/** The settings key holding the model name for a provider. */
function modelKeyFor(provider: string): string {
  switch (provider) {
    case 'claude': return 'claudeModel';
    case 'gemini': return 'geminiModel';
    case 'openrouter': return 'openrouterModel';
    default: return 'ollamaModel';
  }
}

interface CommandCatalogueEntry {
  command: string;
  title: string;
  description: string;
  group: string;
  argHint?: string;
  aliases?: string[];
}

/** Loaded once per session from the backend, so /help cannot drift. */
export async function loadCommandCatalogue(client: BubblyClient): Promise<CommandCatalogueEntry[]> {
  try {
    const d = await client.get<{ commands: CommandCatalogueEntry[] }>('/api/settings/commands?surface=cli');
    return d.commands ?? [];
  } catch {
    return [];
  }
}

const GROUP_TITLE: Record<string, string> = {
  session: 'Session',
  agent: 'The agent',
  context: 'Context',
  project: 'This project',
  settings: 'Settings',
  help: 'Help',
};

export function printHelp(
  catalogue: CommandCatalogueEntry[],
  workflows: Array<{ command: string; description: string }>,
): void {
  line();
  const groups = new Map<string, CommandCatalogueEntry[]>();
  for (const c of catalogue) {
    const list = groups.get(c.group);
    if (list) list.push(c); else groups.set(c.group, [c]);
  }
  for (const [group, items] of groups) {
    line(`  ${chalk.bold(GROUP_TITLE[group] ?? group)}`);
    for (const c of items) {
      const name = `/${c.command}${c.argHint ? ` ${c.argHint}` : ''}`;
      line(`    ${chalk.cyan(name.padEnd(30))}${chalk.dim(c.description)}`);
    }
    line();
  }
  if (workflows.length > 0) {
    line(`  ${chalk.bold('Workflows')} ${chalk.dim('— multi-phase jobs the agent runs')}`);
    for (const w of workflows) {
      line(`    ${chalk.cyan(`/${w.command}`.padEnd(30))}${chalk.dim(w.description)}`);
    }
    line();
  }
}

/**
 * Run a local command. Returns 'unknown' if it is not one of ours, so the
 * caller can fall through to the workflow picker.
 */
export async function runLocalCommand(
  input: string,
  ctx: CommandContext,
  catalogue: CommandCatalogueEntry[],
  workflows: Array<{ command: string; description: string }>,
): Promise<CommandOutcome> {
  const [wordRaw, ...rest] = input.slice(1).split(/\s+/);
  const word = wordRaw.toLowerCase();
  const arg = rest.join(' ').trim();
  const { client, renderer } = ctx;

  const entry = catalogue.find((c) => c.command === word || c.aliases?.includes(word));
  if (!entry) return 'unknown';

  // Everything below is addressed by the CANONICAL name, so an alias behaves
  // identically to the command it points at rather than nearly identically.
  switch (entry.command) {
    // ------------------------------------------------------------- session
    case 'new': {
      ctx.setSessionId(undefined);
      renderer.note('Started a fresh thread. The previous one is still in /threads.');
      return 'handled';
    }

    case 'threads': {
      const data = await client.get<{
        sessions: Array<{ id: string; firstMessage?: string; updatedAt: string; messageCount: number; model: string }>;
      }>('/api/sessions');
      const sessions = (data.sessions ?? []).slice(0, 12);
      line();
      if (sessions.length === 0) {
        line(`  ${chalk.dim('No threads yet.')}`);
      } else {
        for (const s of sessions) {
          const marker = s.id === ctx.sessionId ? chalk.green('●') : ' ';
          const title = (s.firstMessage || '(no messages)').replace(/\s+/g, ' ').slice(0, 56);
          line(`  ${marker} ${chalk.cyan(s.id.slice(0, 8))}  ${title}`);
          line(`      ${chalk.dim(`${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} messages · ${s.model}`)}`);
        }
        line(`\n  ${chalk.dim('Open one with /resume <id>.')}`);
      }
      line();
      return 'handled';
    }

    case 'resume': {
      if (!arg) { renderer.note('Which thread? /resume <id> — /threads lists them.'); return 'handled'; }
      // Accept the short id the listing prints, since that is what people copy.
      const data = await client.get<{ sessions: Array<{ id: string }> }>('/api/sessions');
      const match = (data.sessions ?? []).find((s) => s.id === arg || s.id.startsWith(arg));
      if (!match) { renderer.note(`No thread starts with "${arg}".`); return 'handled'; }
      ctx.setSessionId(match.id);
      client.focus(match.id);
      renderer.note(`Continuing thread ${match.id}. Your next message goes to it.`);
      return 'handled';
    }

    case 'cd': {
      if (!arg) { renderer.note(`Workspace: ${ctx.workspacePath}`); return 'handled'; }
      const next = path.resolve(arg);
      ctx.setWorkspace(next);
      // A different directory is different code; carrying the thread across
      // would point a half-finished conversation at files it has never seen.
      ctx.setSessionId(undefined);
      renderer.note(`Workspace: ${next} — new thread.`);
      return 'handled';
    }

    // --------------------------------------------------------------- agent
    case 'stop': {
      if (!ctx.sessionId) { renderer.note('Nothing is running.'); return 'handled'; }
      client.stop(ctx.sessionId);
      renderer.note('Stopping — and cancelling its waits, so nothing wakes it back up.');
      return 'handled';
    }

    case 'plan': {
      if (!ctx.sessionId) { renderer.note('No thread yet — send a message to start one.'); return 'handled'; }
      const data = await client.get<{ plan?: Array<{ title: string; status: string }> }>(
        `/api/sessions/${ctx.sessionId}/messages`,
      );
      const plan = data.plan ?? [];
      if (plan.length === 0) renderer.note('No plan on this thread yet.');
      else renderer.plan(plan);
      return 'handled';
    }

    case 'watch': {
      const status = await client.get<{ watchers: number }>('/api/status').catch(() => ({ watchers: 0 }));
      const [sub, id] = arg.split(/\s+/);
      if (sub === 'skip' && id) {
        client.skipWatch(id);
        renderer.note(`Skipping ${id}. The agent is told a human stopped waiting, not that it failed.`);
        return 'handled';
      }
      renderer.note(
        status.watchers > 0
          ? `${status.watchers} wait(s) active. Skip one with /watch skip <id> — the ids are printed when a wait starts.`
          : 'Nothing is being waited on.',
      );
      return 'handled';
    }

    case 'approve': {
      if (arg === 'ask' || arg === 'auto' || arg === 'deny') {
        ctx.setApprovalPolicy(arg);
        renderer.note(
          arg === 'auto' ? 'Approval policy: auto — the agent will not ask before acting.'
          : arg === 'deny' ? 'Approval policy: deny — anything needing permission is refused.'
          : 'Approval policy: ask — you approve anything risky.',
        );
      } else {
        renderer.note(`Approval policy is "${ctx.approvalPolicy}". Use /approve ask|auto|deny.`);
      }
      return 'handled';
    }

    case 'agents': {
      if (!ctx.sessionId) { renderer.note('No thread yet.'); return 'handled'; }
      const data = await client.get<{ events: Array<{ eventType: string; resultSummary?: string; createdAt: string }> }>(
        `/api/sessions/${ctx.sessionId}/audit`,
      ).catch(() => ({ events: [] }));
      const delegations = (data.events ?? []).filter((e) => e.eventType.startsWith('delegate'));
      line();
      if (delegations.length === 0) line(`  ${chalk.dim('No workers have been delegated to on this thread.')}`);
      for (const d of delegations.slice(-10)) {
        line(`  ${chalk.magenta('▸')} ${d.resultSummary ?? d.eventType}`);
        line(`    ${chalk.dim(new Date(d.createdAt).toLocaleString())}`);
      }
      line();
      return 'handled';
    }

    // ------------------------------------------------------------- context
    case 'context': {
      if (!ctx.sessionId) { renderer.note('No thread yet — context is measured against a real conversation.'); return 'handled'; }
      const data = await client.get<{ messages: unknown[] }>(`/api/sessions/${ctx.sessionId}/messages`);
      const settings = await client.get<Record<string, string>>('/api/settings');
      const provider = settings.defaultProvider || 'claude';
      line();
      rows([
        ['thread', ctx.sessionId],
        ['messages', String((data.messages ?? []).length)],
        ['model', `${provider} · ${settings[modelKeyFor(provider)] ?? 'default'}`],
      ]);
      line(`\n  ${chalk.dim('Exact token usage is reported live during a run; the composer gauge in the app shows it continuously.')}\n`);
      return 'handled';
    }

    case 'compact': {
      // Honest about what this is: there is no server call that compacts a
      // thread on demand, so this asks the agent to do the equivalent — and
      // says so, rather than implying a mechanism that does not exist.
      renderer.note('Asking the agent to summarise the thread so far. Compaction also happens automatically as the window fills.');
      await ctx.sendPrompt(
        'Summarise everything that matters from this conversation so far: the goal, the decisions taken and why, ' +
        'what is done, what is left, and any constraint you have discovered. Be specific about file paths and names. ' +
        'Do not take any action — this summary is the whole task.',
      );
      return 'handled';
    }

    case 'cost': {
      const stats = await client.get<{
        sessions: number; messages: number; totalTokens: number; activeDays: number;
        currentStreak: number; longestStreak: number; favoriteModel?: string;
      }>('/api/sessions/stats');
      line();
      rows([
        ['threads', String(stats.sessions)],
        ['messages', fmtCompact(stats.messages)],
        ['tokens', fmtCompact(stats.totalTokens)],
        ['active days', String(stats.activeDays)],
        ['streak', `${stats.currentStreak} days (best ${stats.longestStreak})`],
        ...(stats.favoriteModel ? [['most used', stats.favoriteModel] as [string, string]] : []),
      ]);
      line(`\n  ${chalk.dim('Bubbly does not price your tokens: a local model costs nothing and an API key’s rate is between you and your provider.')}\n`);
      return 'handled';
    }

    // ------------------------------------------------------------- project
    case 'init': {
      renderer.note('Reading the project and writing BUBBLY.md.');
      await ctx.sendPrompt(
        'Write BUBBLY.md at the root of this workspace: the standing brief every future thread starts from.\n\n' +
        'Read the codebase first — the package manifests, the directory layout, the build and test scripts, the entry ' +
        'points — and then write, concisely:\n' +
        '- what this project IS, in two or three sentences\n' +
        '- how to run it, test it and build it, using the commands that actually exist here\n' +
        '- the shape of the code: which directory holds what, and the one or two decisions someone must know before editing\n' +
        '- anything surprising: a generated file, a required env var, a step that looks optional and is not\n\n' +
        'Do not pad it. If BUBBLY.md already exists, read it and improve it rather than replacing it wholesale.',
      );
      return 'handled';
    }

    case 'todos': {
      renderer.note('Searching for TODO / FIXME / HACK.');
      await ctx.sendPrompt(
        'Search this workspace for TODO, FIXME, HACK and XXX comments. Group them by file, quote each one with its ' +
        'line number, and say briefly which look like real outstanding work and which are stale notes. Do not fix anything.',
      );
      return 'handled';
    }

    case 'checkpoint': {
      const [sub, ...restArg] = arg.split(/\s+/);
      if (sub === 'restore' && restArg[0]) {
        await ctx.sendPrompt(`Revert the workspace to checkpoint ${restArg[0]} using revert_to_checkpoint, then say what changed back.`);
      } else if (sub === 'list' || !sub) {
        await ctx.sendPrompt('List the workspace checkpoints with list_checkpoints and show them as a short table.');
      } else {
        await ctx.sendPrompt(`Create a workspace checkpoint labelled "${arg}" with create_checkpoint.`);
      }
      return 'handled';
    }

    case 'diff': {
      if (!ctx.sessionId) { renderer.note('No thread yet, so nothing has changed.'); return 'handled'; }
      const data = await client.get<{ sessionChanges?: Array<{ path: string; type: string; additions: number; deletions: number }> }>(
        `/api/sessions/${ctx.sessionId}/messages`,
      );
      const changes = data.sessionChanges ?? [];
      line();
      if (changes.length === 0) {
        line(`  ${chalk.dim('This thread has not changed any files.')}`);
      } else {
        for (const c of changes) {
          line(`  ${chalk.dim(c.type.padEnd(9))}${c.path} ${chalk.green(`+${c.additions}`)} ${chalk.red(`−${c.deletions}`)}`);
        }
      }
      line();
      return 'handled';
    }

    case 'bg': {
      const [sub, ...restArg] = arg.split(/\s+/);
      const argument = restArg.join(' ').trim();

      if (!sub || sub === 'list') {
        const { processes } = await client.get<{
          processes: Array<{ id: string; command: string; cwd: string; status: string; uptimeMs: number; detectedUrl: string | null; exitCode: number | null }>;
        }>('/api/processes');
        line();
        if (processes.length === 0) {
          line(`  ${chalk.dim('Nothing running in the background.')}`);
          line(`  ${chalk.dim('Start something with /bg start <command> — it outlives this terminal.')}`);
        } else {
          for (const p of processes) {
            const mark = p.status === 'running' ? chalk.green('●') : chalk.dim('○');
            line(`  ${mark} ${chalk.cyan(p.id)}  ${p.command}`);
            const detail = [
              p.status === 'running' ? `up ${humanMs(p.uptimeMs)}` : `${p.status}${p.exitCode != null ? ` (exit ${p.exitCode})` : ''}`,
              p.detectedUrl ? chalk.blue(p.detectedUrl) : '',
              chalk.dim(p.cwd),
            ].filter(Boolean).join(' · ');
            line(`     ${detail}`);
          }
        }
        line();
        return 'handled';
      }

      if (sub === 'start') {
        if (!argument) { renderer.note('What should I run? /bg start npm run dev'); return 'handled'; }
        const r = await client.post<{ id: string; reused: boolean; error?: string }>('/api/processes', {
          command: argument, cwd: ctx.workspacePath,
        }).catch((e: Error) => ({ id: '', reused: false, error: e.message }));
        if (r.error) { renderer.error(r.error); return 'handled'; }
        renderer.note(
          r.reused
            ? `Already running as ${r.id} — reusing it rather than starting a second copy.`
            : `Started ${r.id}. It keeps running when you close this terminal; /bg stop ${r.id} ends it.`,
        );
        return 'handled';
      }

      if (sub === 'logs') {
        if (!argument) { renderer.note('Which one? /bg logs <id> — /bg list shows the ids.'); return 'handled'; }
        const r = await client.get<{ output: string; status: string; exitCode: number | null }>(
          `/api/processes/${argument}/output?full=true`,
        ).catch(() => null);
        if (!r) { renderer.error(`No background process with id ${argument}.`); return 'handled'; }
        line();
        line(r.output.trimEnd() || chalk.dim('  (no output yet)'));
        line(`\n  ${chalk.dim(`${r.status}${r.exitCode != null ? ` · exit ${r.exitCode}` : ''}`)}\n`);
        return 'handled';
      }

      if (sub === 'stop') {
        if (!argument) { renderer.note('Which one? /bg stop <id>, or /bg stop-all.'); return 'handled'; }
        await client.del(`/api/processes/${argument}`).catch(() => null);
        renderer.note(`Stopped ${argument}.`);
        return 'handled';
      }

      if (sub === 'stop-all' || sub === 'stopall') {
        const r = await client.del<{ stopped: number }>('/api/processes').catch(() => ({ stopped: 0 }));
        renderer.note(`Stopped ${r.stopped} background process${r.stopped === 1 ? '' : 'es'}.`);
        return 'handled';
      }

      renderer.note('Usage: /bg [list | start <command> | logs <id> | stop <id> | stop-all]');
      return 'handled';
    }

    case 'preview': {
      type PreviewStart = {
        ok: boolean;
        url?: string | null;
        note?: string | null;
        error?: string;
        services?: Array<{ name: string; error?: string }>;
      };
      const r: PreviewStart = await client
        .post<PreviewStart>('/api/files/preview/start', { workspacePath: ctx.workspacePath })
        .catch((e: Error) => ({ ok: false, error: e.message }));
      if (!r.ok) { renderer.error(r.error ?? 'Could not start the preview.'); return 'handled'; }
      if (r.url) renderer.note(`Serving ${chalk.blue(r.url)}`);
      else renderer.note(r.note ?? 'Started. No address yet — it is read from the server’s own output, so give it a moment and run /status.');
      for (const s of r.services ?? []) if (s.error) renderer.note(chalk.yellow(`${s.name}: ${s.error}`));
      return 'handled';
    }

    // ------------------------------------------------------------ settings
    case 'model': {
      const settings = await client.get<Record<string, string>>('/api/settings');
      const provider = settings.defaultProvider || 'claude';
      const key = modelKeyFor(provider);

      if (!arg) {
        line();
        rows([['provider', provider], ['model', settings[key] ?? '(default)']]);
        line(`\n  ${chalk.dim('Change it with /model <name>. Switch provider with /config defaultProvider <claude|ollama|gemini|openrouter>.')}\n`);
        return 'handled';
      }

      await client.put('/api/settings', { [key]: arg });
      renderer.note(`Model set to ${arg}. It applies from your next message.`);
      return 'handled';
    }

    case 'config': {
      const settings = await client.get<Record<string, string>>('/api/settings');
      const [key, ...valueParts] = arg.split(/\s+/);
      const value = valueParts.join(' ');

      if (!key) {
        // Secrets are NEVER printed. A settings dump that includes an API key
        // is a settings dump that ends up in a pasted bug report.
        const secret = /key|token|secret|password|passphrase/i;
        const entries = Object.entries(settings)
          .filter(([, v]) => v !== undefined && v !== null)
          .sort(([a], [b]) => a.localeCompare(b));
        line();
        rows(entries.map(([k, v]) => [k, secret.test(k) ? chalk.dim(v ? '•••••• (set)' : '(not set)') : String(v)]) as Array<[string, string]>, '  ');
        line(`\n  ${chalk.dim('Change one with /config <key> <value>.')}\n`);
        return 'handled';
      }

      if (!(key in settings)) {
        const near = Object.keys(settings).filter((k) => k.toLowerCase().includes(key.toLowerCase())).slice(0, 5);
        renderer.note(
          near.length > 0
            ? `No setting called "${key}". Did you mean: ${near.join(', ')}?`
            : `No setting called "${key}". Run /config with no arguments to see them all.`,
        );
        return 'handled';
      }

      if (!value) {
        const secret = /key|token|secret|password|passphrase/i.test(key);
        renderer.note(`${key} = ${secret ? (settings[key] ? '•••••• (set)' : '(not set)') : settings[key]}`);
        return 'handled';
      }

      await client.put('/api/settings', { [key]: value });
      renderer.note(`${key} = ${value}`);
      return 'handled';
    }

    case 'tools': {
      const { tools } = await client.get<{ tools: Array<{ name: string; description: string }> }>('/api/settings/tools')
        .catch(() => ({ tools: [] as Array<{ name: string; description: string }> }));
      line();
      if (tools.length === 0) {
        line(`  ${chalk.dim('Could not read the tool list from this backend.')}`);
      } else {
        for (const t of tools) {
          line(`  ${chalk.cyan(t.name.padEnd(22))}${chalk.dim(t.description.split('\n')[0].slice(0, 90))}`);
        }
        line(`\n  ${chalk.dim(`${tools.length} tools.`)}`);
      }
      line();
      return 'handled';
    }

    case 'mcp': {
      // The backend exposes the connected TOOLS rather than a server roster,
      // which is the more useful thing anyway: a server that connected but
      // contributed nothing is indistinguishable from one that failed, and the
      // tool list says which is which.
      const data = await client.get<{ tools: Array<{ name: string; description?: string }>; error?: string }>('/api/mcp/tools')
        .catch(() => ({ tools: [], error: 'could not reach the backend' }));
      const tools = data.tools ?? [];
      line();
      if (data.error) {
        line(`  ${chalk.yellow(data.error)}`);
      } else if (tools.length === 0) {
        line(`  ${chalk.dim('No MCP tools are connected. Add a server in Settings → MCP in the app.')}`);
      } else {
        const byServer = new Map<string, string[]>();
        for (const t of tools) {
          const parts = t.name.split('__');
          const server = parts.length > 2 ? parts[1] : 'mcp';
          const list = byServer.get(server);
          if (list) list.push(parts[parts.length - 1]); else byServer.set(server, [parts[parts.length - 1]]);
        }
        for (const [server, names] of byServer) {
          line(`  ${chalk.green('✓')} ${chalk.cyan(server)} ${chalk.dim(`${names.length} tools`)}`);
          line(`    ${chalk.dim(names.slice(0, 8).join(', '))}${names.length > 8 ? chalk.dim(`, +${names.length - 8} more`) : ''}`);
        }
      }
      line();
      return 'handled';
    }

    case 'connect': {
      const o = await client.get<{
        credentials: { ssh: { agent: boolean; agentKeys: number; keyFiles: number; configuredHosts: number }; github: string | null; gitlab: string | null };
        vault: { backend: string; storedCount: number };
        sshConnections: Array<{ name: string; host: string; username: string; auth: string }>;
        forgeAccounts: Array<{ host: string; username?: string; tokenSource: string }>;
      }>('/api/connections/overview');
      const tick = (ok: boolean) => (ok ? chalk.green('✓') : chalk.dim('·'));
      const c = o.credentials;
      line();
      line(`  ${chalk.bold('Already available')}`);
      line(`    ${tick(c.ssh.agent)} ssh-agent ${chalk.dim(c.ssh.agent ? `— ${c.ssh.agentKeys} identities` : '— not running')}`);
      line(`    ${tick(c.ssh.keyFiles > 0)} keys in ~/.ssh ${chalk.dim(`— ${c.ssh.keyFiles}`)}`);
      line(`    ${tick(!!c.github)} GitHub ${chalk.dim(c.github ? `— via ${c.github}` : '— none found')}`);
      line(`    ${tick(!!c.gitlab)} GitLab ${chalk.dim(c.gitlab ? `— via ${c.gitlab}` : '— none found')}`);
      if (o.sshConnections.length > 0) {
        line(`\n  ${chalk.bold('Saved SSH hosts')}`);
        for (const sshHost of o.sshConnections) line(`    ${chalk.cyan(sshHost.name.padEnd(18))}${chalk.dim(`${sshHost.username}@${sshHost.host} · ${sshHost.auth}`)}`);
      }
      line(`\n  ${chalk.dim(`Credential storage: ${o.vault.backend} · ${o.vault.storedCount} stored`)}\n`);
      return 'handled';
    }

    case 'status': {
      const [settings, status] = await Promise.all([
        client.get<Record<string, string>>('/api/settings'),
        client.get<{
          running: Array<{ id: string; title: string }>;
          backgroundProcesses: Array<{ id: string; command: string; url: string | null }>;
          watchers: number;
        }>('/api/status').catch(() => ({ running: [], backgroundProcesses: [], watchers: 0 })),
      ]);
      const provider = settings.defaultProvider || 'claude';
      line();
      rows([
        ['backend', client.baseUrl],
        ['workspace', ctx.workspacePath],
        ['model', `${provider} · ${settings[modelKeyFor(provider)] ?? 'default'}`],
        ['approvals', ctx.approvalPolicy],
        ['thread', ctx.sessionId ?? chalk.dim('none yet')],
      ]);
      line();
      line(`  ${chalk.bold('Running now')}`);
      if (status.running.length === 0) line(`    ${chalk.dim('no threads working')}`);
      for (const t of status.running) line(`    ${chalk.green('●')} ${chalk.cyan(t.id.slice(0, 8))} ${t.title}`);
      for (const p of status.backgroundProcesses) {
        line(`    ${chalk.green('●')} ${chalk.cyan(p.id)} ${p.command}${p.url ? ` ${chalk.blue(p.url)}` : ''}`);
      }
      if (status.watchers > 0) line(`    ${chalk.dim(`${status.watchers} wait(s) active`)}`);
      line();
      return 'handled';
    }

    case 'doctor': {
      const results: Array<{ ok: boolean; label: string; detail: string }> = [];
      const major = Number(process.versions.node.split('.')[0]);
      results.push({ ok: major >= 18, label: 'Node.js', detail: `${process.version}${major >= 18 ? '' : ' — Bubbly needs 18 or newer'}` });
      results.push({ ok: client.connected, label: 'Backend', detail: client.connected ? client.baseUrl : 'not connected' });
      try {
        const settings = await client.get<Record<string, string>>('/api/settings');
        const provider = settings.defaultProvider || 'claude';
        const hasKey = provider === 'ollama' || !!(
          provider === 'claude' ? settings.anthropicApiKey
          : provider === 'gemini' ? settings.geminiApiKey
          : settings.openrouterApiKey
        );
        results.push({ ok: hasKey, label: 'Model', detail: hasKey ? `${provider} · ${settings[modelKeyFor(provider)] ?? 'default'}` : `${provider} has no API key configured` });
        results.push({ ok: !!settings.workspacePath, label: 'Workspace', detail: settings.workspacePath || 'not set' });
        const overview = await client.get<{ vault: { backend: string } }>('/api/connections/overview');
        results.push({ ok: true, label: 'Credential vault', detail: overview.vault.backend });
      } catch (err) {
        results.push({ ok: false, label: 'REST API', detail: err instanceof Error ? err.message : String(err) });
      }
      line();
      for (const r of results) line(`  ${r.ok ? chalk.green('✓') : chalk.red('✗')} ${r.label.padEnd(18)}${chalk.dim(r.detail)}`);
      line();
      return 'handled';
    }

    // ---------------------------------------------------------------- help
    case 'verbose': {
      const next = ctx.setVerbose(!ctx.verbose);
      renderer.note(`Tool calls and command output are now ${next ? 'shown' : 'hidden'}.`);
      return 'handled';
    }

    case 'help': {
      printHelp(catalogue, workflows);
      return 'handled';
    }

    case 'exit': {
      ctx.exit();
      return 'handled';
    }

    default:
      return 'unknown';
  }
}

/** Rendered markdown, for commands that print prose. Exported for reuse. */
export function md(text: string): string {
  return renderMarkdown(text);
}
