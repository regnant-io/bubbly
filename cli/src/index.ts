#!/usr/bin/env node
/**
 * The Bubbly command line.
 *
 * SHAPE OF THE COMMAND SURFACE
 *
 *   bubbly                     open an interactive session here
 *   bubbly "fix the login"     one task, then exit
 *   bubbly run "…"             the same, explicitly, with --json for scripts
 *   bubbly /fix "…"            run a workflow
 *   bubbly threads             what has been worked on
 *   bubbly status              what is running right now
 *   bubbly bg …                long-running commands that outlive the terminal
 *   bubbly config …            read and change settings
 *   bubbly stop [thread]       halt a running turn
 *   bubbly connect             SSH hosts and forge accounts
 *   bubbly serve               run the backend (--detach to leave it running)
 *   bubbly doctor              why isn't this working
 *
 * The bare form matters. `bubbly` with no arguments should do the obvious
 * thing — open a session in the current directory — because that is what it is
 * for ninety per cent of the time, and a tool that requires a subcommand to do
 * its main job is a tool people stop reaching for.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { BubblyClient, isBackendUp } from './client';
import { startRepl } from './commands/repl';
import { runHeadless } from './commands/headless';
import type { ApprovalPolicy } from './session';

const packageJson = require('../package.json');

const DEFAULT_URL = process.env.BUBBLY_URL || 'http://localhost:3001';

interface CommonOptions {
  url?: string;
  workspace?: string;
  thread?: string;
  approve?: string;
  verbose?: boolean;
  mode?: string;
  start?: boolean;
}

function resolveWorkspace(given?: string): string {
  const target = path.resolve(given || process.cwd());
  if (!fs.existsSync(target)) {
    process.stderr.write(chalk.red(`\n  No such directory: ${target}\n\n`));
    process.exit(2);
  }
  return target;
}

function resolveApprovalPolicy(given?: string): ApprovalPolicy {
  if (given === 'auto' || given === 'deny' || given === 'ask') return given;
  if (given) {
    process.stderr.write(chalk.red(`\n  --approve must be ask, auto or deny (got "${given}")\n\n`));
    process.exit(2);
  }
  // Interactive defaults to asking; a pipe cannot ask, so it defaults to denying
  // rather than to silently approving whatever the agent wants to do.
  return process.stdin.isTTY ? 'ask' : 'deny';
}

/**
 * Leave the process, cleanly.
 *
 * `process.exit()` is immediate and unconditional: it tears the event loop down
 * mid-flight, and on Windows that raced libuv's own teardown of the WebSocket
 * and stdin handles, printing an assertion failure after every session
 * ("!(handle->flags & UV_HANDLE_CLOSING)"). Harmless, and indistinguishable
 * from a crash to anyone reading it.
 *
 * Yielding one macrotask first lets every handle that was already closing
 * finish doing so, and flushing stdout means the last line of a piped session
 * is never truncated — the two things an exit path actually owes the caller.
 */
async function leave(code: number): Promise<void> {
  // Flush first: a piped session must not lose its last line.
  await new Promise<void>((resolve) => {
    if (process.stdout.write('')) resolve();
    else process.stdout.once('drain', () => resolve());
  });

  process.exitCode = code;

  /*
   * A WATCHDOG, NOT AN EXIT.
   *
   * Setting exitCode lets the event loop drain and the process leave on its
   * own, which is the whole point — but it also means one stuck handle would
   * hang a script forever, and `bubbly run` in CI must always terminate.
   *
   * The timer is UNREF'D, which gives exactly the behaviour wanted from both
   * halves: if nothing is holding the loop open it never fires and the process
   * has already gone; if something is, it fires and takes the process with it.
   */
  const watchdog = setTimeout(() => {
    process.exit(code);
  }, 1500);
  if (typeof watchdog.unref === 'function') watchdog.unref();
}

/**
 * Start the backend ourselves, if it is not already up.
 *
 * Only when `--start` is passed. Starting a server as a side effect of running a
 * command is the kind of helpfulness that leaves orphaned processes behind and
 * makes "why is port 3001 busy" someone's afternoon.
 */
async function ensureBackend(url: string, allowStart: boolean): Promise<void> {
  if (await isBackendUp(url)) return;

  if (!allowStart) {
    process.stderr.write(
      chalk.red(`\n  No Bubbly backend at ${url}.\n`) +
      chalk.dim('  Start one with `bubbly serve`, pass --start to launch it automatically, or point at another with --url.\n\n'),
    );
    process.exit(2);
  }

  const backendEntry = path.resolve(__dirname, '../../backend/dist/index.js');
  if (!fs.existsSync(backendEntry)) {
    process.stderr.write(
      chalk.red('\n  Cannot start the backend: its build is missing.\n') +
      chalk.dim(`  Expected ${backendEntry}. Run \`npm run build\` in the Bubbly repository first.\n\n`),
    );
    process.exit(2);
  }

  process.stderr.write(chalk.dim('  Starting the backend…\n'));
  const child = spawn(process.execPath, [backendEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: new URL(url).port || '3001' },
  });
  child.unref();

  // Poll rather than sleep: the backend is usually up in under a second, and a
  // fixed sleep is either too slow or too optimistic.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isBackendUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stderr.write(chalk.red('\n  The backend did not come up within 20s.\n\n'));
  process.exit(2);
}

async function connect(options: CommonOptions): Promise<BubblyClient> {
  const url = options.url || DEFAULT_URL;
  await ensureBackend(url, options.start === true);
  const client = new BubblyClient({ baseUrl: url });
  await client.connect();
  return client;
}

const program = new Command();

program
  .name('bubbly')
  .description('Bubbly — a local AI coding agent, in your terminal')
  .version(packageJson.version)
  .option('-u, --url <url>', `backend URL (default: ${DEFAULT_URL})`)
  .option('-w, --workspace <path>', 'directory to work in (default: the current one)')
  .option('-t, --thread <id>', 'continue an existing thread')
  .option('-a, --approve <policy>', 'ask | auto | deny')
  .option('-m, --mode <mode>', 'vibe_coding | spec_session')
  .option('-v, --verbose', 'show tool calls, output and diffs')
  .option('--start', 'start the backend if it is not running')
  .argument('[task...]', 'a task to run, or nothing for an interactive session')
  .action(async (task: string[], options: CommonOptions) => {
    const workspacePath = resolveWorkspace(options.workspace);
    const client = await connect(options);
    const approvalPolicy = resolveApprovalPolicy(options.approve);

    // `bubbly /fix "the login"` — a workflow straight from the shell.
    const first = task[0];
    if (first?.startsWith('/')) {
      const workflows = await client
        .get<{ workflows: Array<{ command: string; params: Array<{ name: string; required?: boolean; options?: string[] }> }> }>(
          '/api/settings/workflows',
        )
        .then((d) => d.workflows)
        .catch(() => []);
      const workflow = workflows.find((w) => w.command === first.slice(1));
      if (!workflow) {
        process.stderr.write(chalk.red(`\n  No workflow "${first}". Run \`bubbly workflows\` to see them.\n\n`));
        client.close();
        process.exit(2);
      }
      const rest = task.slice(1).join(' ').trim();
      const primary = workflow.params.find((p) => p.required && !p.options);
      const args: Record<string, string> = {};
      if (primary && rest) args[primary.name] = rest;

      const code = await runHeadless({
        client,
        workspacePath,
        message: `${first} ${rest}`.trim(),
        workflow: { command: workflow.command, args },
        sessionId: options.thread,
        threadType: options.mode,
        approvalPolicy,
        json: false,
        verbose: options.verbose ?? true,
        timeoutSeconds: 0,
      });
      client.close();
      await leave(code);
    }

    if (task.length > 0) {
      const code = await runHeadless({
        client,
        workspacePath,
        message: task.join(' '),
        sessionId: options.thread,
        threadType: options.mode,
        approvalPolicy,
        json: false,
        verbose: options.verbose ?? true,
        timeoutSeconds: 0,
      });
      client.close();
      await leave(code);
    }

    await startRepl({
      client,
      workspacePath,
      sessionId: options.thread,
      threadType: options.mode,
      approvalPolicy,
      verbose: options.verbose ?? true,
    });
    await leave(0);
  });

program
  .command('chat')
  .description('Open an interactive session')
  .action(async (_opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const workspacePath = resolveWorkspace(options.workspace);
    const client = await connect(options);
    await startRepl({
      client,
      workspacePath,
      sessionId: options.thread,
      threadType: options.mode,
      approvalPolicy: resolveApprovalPolicy(options.approve),
      verbose: options.verbose ?? true,
    });
    await leave(0);
  });

program
  .command('run <task...>')
  .description('Run one task and exit — for scripts and CI')
  .option('--json', 'emit a machine-readable result on stdout')
  .option('--timeout <seconds>', 'give up after this long', '0')
  .action(async (task: string[], localOptions: { json?: boolean; timeout?: string }, command) => {
    const options = command.parent.opts() as CommonOptions;
    const workspacePath = resolveWorkspace(options.workspace);
    const client = await connect(options);
    const code = await runHeadless({
      client,
      workspacePath,
      message: task.join(' '),
      sessionId: options.thread,
      threadType: options.mode,
      approvalPolicy: resolveApprovalPolicy(options.approve),
      json: localOptions.json === true,
      verbose: options.verbose === true,
      timeoutSeconds: Number(localOptions.timeout) || 0,
    });
    client.close();
    await leave(code);
  });

program
  .command('workflows')
  .description('List the available workflows')
  .action(async (_opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const { workflows } = await client.get<{
      workflows: Array<{ command: string; name: string; description: string; group: string }>;
    }>('/api/settings/workflows');

    const groups = new Map<string, typeof workflows>();
    for (const w of workflows) {
      const list = groups.get(w.group);
      if (list) list.push(w); else groups.set(w.group, [w]);
    }
    process.stdout.write('\n');
    for (const [group, items] of groups) {
      process.stdout.write(`  ${chalk.bold(group)}\n`);
      for (const w of items) {
        process.stdout.write(`    ${chalk.cyan(`/${w.command}`.padEnd(14))} ${chalk.dim(w.description)}\n`);
      }
      process.stdout.write('\n');
    }
    client.close();
  });

program
  .command('threads')
  .description('List recent threads')
  .option('-n, --limit <count>', 'how many to show', '15')
  .action(async (localOptions: { limit?: string }, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const data = await client.get<{
      sessions: Array<{ id: string; firstMessage?: string; updatedAt: string; messageCount: number; model: string }>;
    }>('/api/sessions');

    const limit = Number(localOptions.limit) || 15;
    const sessions = (data.sessions ?? []).slice(0, limit);
    if (sessions.length === 0) {
      process.stdout.write(`\n  ${chalk.dim('No threads yet.')}\n\n`);
    } else {
      process.stdout.write('\n');
      for (const s of sessions) {
        const when = new Date(s.updatedAt).toLocaleString();
        const title = (s.firstMessage || '(no messages)').replace(/\s+/g, ' ').slice(0, 58);
        process.stdout.write(`  ${chalk.cyan(s.id.slice(0, 8))}  ${title}\n`);
        process.stdout.write(`  ${' '.repeat(8)}  ${chalk.dim(`${when} · ${s.messageCount} messages · ${s.model}`)}\n`);
      }
      process.stdout.write(`\n  ${chalk.dim('Continue one with: bubbly chat --thread <id>')}\n\n`);
    }
    client.close();
  });

program
  .command('connect')
  .description('Show SSH hosts, forge accounts and what Bubbly can already authenticate with')
  .action(async (_opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const overview = await client.get<{
      credentials: {
        ssh: { agent: boolean; agentKeys: number; keyFiles: number; configuredHosts: number };
        github: string | null;
        gitlab: string | null;
      };
      vault: { backend: string; storedCount: number };
      sshConnections: Array<{ id: string; name: string; host: string; username: string; auth: string }>;
      forgeAccounts: Array<{ forge: string; host: string; username?: string; tokenSource: string }>;
    }>('/api/connections/overview');

    const tick = (ok: boolean) => (ok ? chalk.green('✓') : chalk.dim('·'));
    const c = overview.credentials;

    process.stdout.write(`\n  ${chalk.bold('Already available')}\n`);
    process.stdout.write(`    ${tick(c.ssh.agent)} ssh-agent ${chalk.dim(c.ssh.agent ? `— ${c.ssh.agentKeys} identities` : '— not running')}\n`);
    process.stdout.write(`    ${tick(c.ssh.keyFiles > 0)} keys in ~/.ssh ${chalk.dim(`— ${c.ssh.keyFiles}`)}\n`);
    process.stdout.write(`    ${tick(c.ssh.configuredHosts > 0)} hosts in ~/.ssh/config ${chalk.dim(`— ${c.ssh.configuredHosts}`)}\n`);
    process.stdout.write(`    ${tick(!!c.github)} GitHub ${chalk.dim(c.github ? `— via ${c.github}` : '— none found')}\n`);
    process.stdout.write(`    ${tick(!!c.gitlab)} GitLab ${chalk.dim(c.gitlab ? `— via ${c.gitlab}` : '— none found')}\n`);

    process.stdout.write(`\n  ${chalk.bold('Saved SSH hosts')}\n`);
    if (overview.sshConnections.length === 0) {
      process.stdout.write(`    ${chalk.dim('none — add one in the app under Settings → Connections')}\n`);
    }
    for (const s of overview.sshConnections) {
      process.stdout.write(`    ${chalk.cyan(s.name.padEnd(18))} ${chalk.dim(`${s.username}@${s.host} · ${s.auth}`)}\n`);
    }

    process.stdout.write(`\n  ${chalk.bold('Forge accounts')}\n`);
    if (overview.forgeAccounts.length === 0) {
      process.stdout.write(`    ${chalk.dim('none saved — detected credentials above are used automatically')}\n`);
    }
    for (const a of overview.forgeAccounts) {
      process.stdout.write(`    ${chalk.cyan(a.host.padEnd(18))} ${chalk.dim(`${a.username ?? 'unverified'} · ${a.tokenSource}`)}\n`);
    }

    process.stdout.write(`\n  ${chalk.dim(`Credential storage: ${overview.vault.backend} · ${overview.vault.storedCount} stored`)}\n\n`);
    client.close();
  });

/**
 * Long-running commands, owned by the BACKEND rather than by a terminal.
 *
 * This is the difference between "run npm run dev in a terminal you now have to
 * keep open" and "start it and get on with your life". The process lives in the
 * backend, so it survives this CLI exiting, the terminal window closing, and the
 * desktop app being quit to the tray — and it is the SAME process table the
 * agent reads, so `bubbly bg list` and the agent's own view can never disagree.
 */
const bg = program
  .command('bg')
  .description('Long-running commands that outlive this terminal');

bg
  .command('list', { isDefault: true })
  .description('What is running')
  .action(async (_opts, command) => {
    const options = command.parent.parent.opts() as CommonOptions;
    const client = await connect(options);
    const { processes } = await client.get<{
      processes: Array<{ id: string; command: string; cwd: string; status: string; uptimeMs: number; detectedUrl: string | null; exitCode: number | null }>;
    }>('/api/processes');
    process.stdout.write('\n');
    if (processes.length === 0) {
      process.stdout.write(`  ${chalk.dim('Nothing running.')}\n`);
      process.stdout.write(`  ${chalk.dim('Start something with: bubbly bg start "npm run dev"')}\n`);
    }
    for (const p of processes) {
      const mark = p.status === 'running' ? chalk.green('●') : chalk.dim('○');
      const secs = Math.round(p.uptimeMs / 1000);
      const uptime = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
      const detail = p.status === 'running' ? `up ${uptime}` : `${p.status}${p.exitCode != null ? ` (exit ${p.exitCode})` : ''}`;
      process.stdout.write(`  ${mark} ${chalk.cyan(p.id)}  ${p.command}\n`);
      process.stdout.write(`     ${chalk.dim(detail)}${p.detectedUrl ? ` ${chalk.blue(p.detectedUrl)}` : ''} ${chalk.dim(p.cwd)}\n`);
    }
    process.stdout.write('\n');
    client.close();
  });

bg
  .command('start <cmd...>')
  .description('Start a command in the background and return immediately')
  .action(async (cmd: string[], _opts, command) => {
    const options = command.parent.parent.opts() as CommonOptions;
    const workspacePath = resolveWorkspace(options.workspace);
    const client = await connect(options);
    try {
      const r = await client.post<{ id: string; reused: boolean }>('/api/processes', {
        command: cmd.join(' '), cwd: workspacePath,
      });
      process.stdout.write(
        r.reused
          ? `\n  ${chalk.dim('Already running as')} ${chalk.cyan(r.id)} ${chalk.dim('— reusing it rather than starting a second copy.')}\n\n`
          : `\n  ${chalk.green('Started')} ${chalk.cyan(r.id)}\n  ${chalk.dim(`It keeps running when you close this terminal. Stop it with: bubbly bg stop ${r.id}`)}\n\n`,
      );
    } catch (err) {
      process.stderr.write(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`));
      client.close();
      process.exit(1);
    }
    client.close();
  });

bg
  .command('logs <id>')
  .description('Show what a background process has printed')
  .option('-f, --follow', 'keep printing new output until Ctrl-C')
  .action(async (id: string, localOptions: { follow?: boolean }, command) => {
    const options = command.parent.parent.opts() as CommonOptions;
    const client = await connect(options);
    const read = (full: boolean) =>
      client.get<{ output: string; status: string; exitCode: number | null }>(
        `/api/processes/${id}/output?full=${full}`,
      );
    try {
      const first = await read(true);
      process.stdout.write(`${first.output.trimEnd()}\n`);
      if (!localOptions.follow) {
        process.stdout.write(`\n  ${chalk.dim(`${first.status}${first.exitCode != null ? ` · exit ${first.exitCode}` : ''}`)}\n\n`);
        client.close();
        return;
      }
      // Follow mode polls the INCREMENTAL read, which is what the endpoint's
      // read offset is for — re-fetching the whole buffer every second would
      // reprint the entire log on every tick.
      process.stdout.write(chalk.dim('  — following, Ctrl-C to stop —\n'));
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 1000));
        const next = await read(false);
        if (next.output) process.stdout.write(next.output);
        if (next.status !== 'running') {
          process.stdout.write(`\n  ${chalk.dim(`${next.status}${next.exitCode != null ? ` · exit ${next.exitCode}` : ''}`)}\n`);
          break;
        }
      }
    } catch (err) {
      process.stderr.write(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`));
      client.close();
      process.exit(1);
    }
    client.close();
  });

bg
  .command('stop [id]')
  .description('Stop one background process, or all of them with --all')
  .option('-a, --all', 'stop everything')
  .action(async (id: string | undefined, localOptions: { all?: boolean }, command) => {
    const options = command.parent.parent.opts() as CommonOptions;
    const client = await connect(options);
    try {
      if (localOptions.all || !id) {
        const r = await client.del<{ stopped: number }>('/api/processes');
        process.stdout.write(`\n  ${chalk.dim(`Stopped ${r.stopped} process${r.stopped === 1 ? '' : 'es'}.`)}\n\n`);
      } else {
        await client.del(`/api/processes/${id}`);
        process.stdout.write(`\n  ${chalk.dim(`Stopped ${id}.`)}\n\n`);
      }
    } catch (err) {
      process.stderr.write(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`));
      client.close();
      process.exit(1);
    }
    client.close();
  });

program
  .command('status')
  .description('What is running right now — threads, processes and waits')
  .action(async (_opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const [settings, status] = await Promise.all([
      client.get<Record<string, string>>('/api/settings'),
      client.get<{
        running: Array<{ id: string; title: string; queued: number }>;
        backgroundProcesses: Array<{ id: string; command: string; url: string | null }>;
        watchers: number;
      }>('/api/status'),
    ]);
    const provider = settings.defaultProvider || 'claude';
    const modelKey = provider === 'claude' ? 'claudeModel'
      : provider === 'gemini' ? 'geminiModel'
      : provider === 'openrouter' ? 'openrouterModel' : 'ollamaModel';

    process.stdout.write('\n');
    process.stdout.write(`  ${chalk.dim('backend'.padEnd(12))}${client.baseUrl}\n`);
    process.stdout.write(`  ${chalk.dim('model'.padEnd(12))}${provider} · ${settings[modelKey] ?? 'default'}\n`);
    process.stdout.write(`  ${chalk.dim('workspace'.padEnd(12))}${settings.workspacePath || chalk.dim('not set')}\n\n`);

    if (status.running.length === 0 && status.backgroundProcesses.length === 0) {
      process.stdout.write(`  ${chalk.dim('Nothing running.')}\n\n`);
    } else {
      for (const t of status.running) {
        process.stdout.write(`  ${chalk.green('●')} ${chalk.cyan(t.id.slice(0, 8))} ${t.title}${t.queued ? chalk.dim(` (${t.queued} queued)`) : ''}\n`);
      }
      for (const p of status.backgroundProcesses) {
        process.stdout.write(`  ${chalk.green('●')} ${chalk.cyan(p.id)} ${p.command}${p.url ? ` ${chalk.blue(p.url)}` : ''}\n`);
      }
      if (status.watchers > 0) process.stdout.write(`  ${chalk.dim(`${status.watchers} wait(s) active`)}\n`);
      process.stdout.write('\n');
    }
    client.close();
  });

program
  .command('stop [thread]')
  .description('Halt a running turn (defaults to every running thread)')
  .action(async (thread: string | undefined, _opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const status = await client.get<{ running: Array<{ id: string; title: string }> }>('/api/status');
    const targets = thread
      ? status.running.filter((t) => t.id === thread || t.id.startsWith(thread))
      : status.running;
    if (targets.length === 0) {
      process.stdout.write(`\n  ${chalk.dim(thread ? `No running thread matches "${thread}".` : 'Nothing is running.')}\n\n`);
    } else {
      for (const t of targets) {
        client.stop(t.id);
        process.stdout.write(`  ${chalk.yellow('■')} stopped ${chalk.cyan(t.id.slice(0, 8))} ${chalk.dim(t.title)}\n`);
      }
      // The stop travels over the socket; give it a moment to leave before the
      // process exits and takes the connection with it.
      await new Promise((r) => setTimeout(r, 250));
      process.stdout.write('\n');
    }
    client.close();
  });

program
  .command('config [key] [value]')
  .description('Read or change a setting')
  .action(async (key: string | undefined, value: string | undefined, _opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const client = await connect(options);
    const settings = await client.get<Record<string, string>>('/api/settings');
    // A settings dump that includes an API key is a settings dump that ends up
    // pasted into a bug report. Secrets are shown as set / not set, never read.
    const secret = /key|token|secret|password|passphrase/i;

    if (!key) {
      const entries = Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));
      const width = Math.max(...entries.map(([k]) => k.length), 0);
      process.stdout.write('\n');
      for (const [k, v] of entries) {
        const shown = secret.test(k) ? chalk.dim(v ? '•••••• (set)' : '(not set)') : String(v ?? '');
        process.stdout.write(`  ${chalk.dim(k.padEnd(width + 2))}${shown}\n`);
      }
      process.stdout.write(`\n  ${chalk.dim('Change one with: bubbly config <key> <value>')}\n\n`);
      client.close();
      return;
    }

    if (!(key in settings)) {
      const near = Object.keys(settings).filter((k) => k.toLowerCase().includes(key.toLowerCase())).slice(0, 5);
      process.stderr.write(chalk.red(`\n  No setting called "${key}".\n`));
      if (near.length > 0) process.stderr.write(chalk.dim(`  Did you mean: ${near.join(', ')}?\n`));
      process.stderr.write('\n');
      client.close();
      process.exit(2);
    }

    if (value === undefined) {
      const shown = secret.test(key) ? (settings[key] ? '•••••• (set)' : '(not set)') : settings[key];
      process.stdout.write(`\n  ${chalk.dim(key)}  ${shown}\n\n`);
      client.close();
      return;
    }

    await client.put('/api/settings', { [key]: value });
    process.stdout.write(`\n  ${chalk.green('✓')} ${chalk.dim(key)}  ${secret.test(key) ? '•••••• (set)' : value}\n\n`);
    client.close();
  });

program
  .command('serve')
  .description('Run the Bubbly backend (--detach leaves it running after you exit)')
  .option('-p, --port <port>', 'port to listen on', '3001')
  .option('-d, --detach', 'leave the backend running in the background and return')
  .action(async (localOptions: { port?: string; detach?: boolean }) => {
    const backendEntry = path.resolve(__dirname, '../../backend/dist/index.js');
    if (!fs.existsSync(backendEntry)) {
      process.stderr.write(
        chalk.red('\n  The backend build is missing.\n') +
        chalk.dim(`  Expected ${backendEntry}. Run \`npm run build\` in the Bubbly repository.\n\n`),
      );
      process.exit(2);
    }
    const port = localOptions.port ?? '3001';

    if (localOptions.detach) {
      /*
       * A backend that survives the terminal.
       *
       * This is the counterpart to `bubbly bg`: the whole point of putting
       * long-running work in the backend is that the backend itself is not tied
       * to a terminal window. Detached + unref'd is what lets you start it from
       * a shell you are about to close.
       */
      const child = spawn(process.execPath, [backendEntry], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PORT: port },
      });
      child.unref();
      const url = `http://localhost:${port}`;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await isBackendUp(url)) {
          process.stdout.write(`\n  ${chalk.green('✓')} Backend running at ${chalk.cyan(url)} ${chalk.dim(`(pid ${child.pid})`)}\n`);
          process.stdout.write(`  ${chalk.dim('It keeps running after this shell exits. Stop it by ending that process.')}\n\n`);
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      process.stderr.write(chalk.red('\n  The backend did not come up within 20s.\n\n'));
      process.exit(2);
    }

    const child = spawn(process.execPath, [backendEntry], {
      stdio: 'inherit',
      env: { ...process.env, PORT: port },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  });

program
  .command('doctor')
  .description('Check that everything Bubbly needs is present and working')
  .action(async (_opts, command) => {
    const options = command.parent.opts() as CommonOptions;
    const url = options.url || DEFAULT_URL;
    const results: Array<{ ok: boolean; label: string; detail: string }> = [];

    results.push({
      ok: Number(process.versions.node.split('.')[0]) >= 18,
      label: 'Node.js',
      detail: `${process.version}${Number(process.versions.node.split('.')[0]) >= 18 ? '' : ' — Bubbly needs 18 or newer'}`,
    });

    const backendUp = await isBackendUp(url);
    results.push({ ok: backendUp, label: 'Backend', detail: backendUp ? url : `not reachable at ${url}` });

    if (backendUp) {
      const client = new BubblyClient({ baseUrl: url });
      try {
        await client.connect();
        results.push({ ok: true, label: 'WebSocket', detail: 'connected' });

        const settings = await client.get<Record<string, string>>('/api/settings');
        const provider = settings.defaultProvider || 'claude';
        const hasKey =
          provider === 'ollama' ||
          !!(provider === 'claude' ? settings.anthropicApiKey
            : provider === 'gemini' ? settings.geminiApiKey
            : settings.openrouterApiKey);
        results.push({
          ok: hasKey,
          label: 'Model',
          detail: hasKey
            ? `${provider} · ${settings[`${provider === 'claude' ? 'claude' : provider}Model`] ?? 'default'}`
            : `${provider} has no API key configured`,
        });

        results.push({
          ok: !!settings.workspacePath,
          label: 'Workspace',
          detail: settings.workspacePath || 'not set',
        });

        const overview = await client.get<{ vault: { backend: string } }>('/api/connections/overview');
        results.push({ ok: true, label: 'Credential vault', detail: overview.vault.backend });

        client.close();
      } catch (err) {
        results.push({
          ok: false,
          label: 'WebSocket',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    process.stdout.write('\n');
    for (const r of results) {
      const mark = r.ok ? chalk.green('✓') : chalk.red('✗');
      process.stdout.write(`  ${mark} ${r.label.padEnd(18)} ${chalk.dim(r.detail)}\n`);
    }
    process.stdout.write('\n');
    await leave(results.every((r) => r.ok) ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`));
  process.exit(1);
});
