/**
 * The tool surface, executed on a remote host.
 *
 * WHY THIS EXISTS AS A SEPARATE FILE
 *
 * The tools in `agent/tools/index.ts` are built on `fs` and `spawn` — hundreds
 * of direct calls accumulated over the life of the project. Two ways to make
 * them work remotely:
 *
 *   (a) Rewrite every tool to go through the provider interface.
 *   (b) Intercept the tools whose behaviour is genuinely I/O, implement those
 *       against the provider, and let everything else fall through unchanged.
 *
 * (a) is the tidier diagram and the worse engineering decision here. It touches
 * every tool and every test to change behaviour that, for the local case,
 * already works — and the failure mode of a missed call site is not a compile
 * error but an "edit" that writes to the WRONG MACHINE. (b) is a narrow,
 * auditable list: if a tool is not in this file, it demonstrably does not touch
 * the workspace, and that is checkable by reading one table.
 *
 * The list below is that table. Everything in it is I/O against the workspace.
 * Everything not in it — update_plan, artifact, ask_user, delegate_task,
 * get_repo_map — either has no filesystem side effects or operates on data
 * Bubbly already holds locally.
 */

import path from 'path';
import { createTwoFilesPatch } from 'diff';
import { logger } from '../utils/logger';
import { providerForWorkspacePath, isRemotePath } from './registry';
import { remoteProcesses } from './remoteProcesses';
import { SshProvider, shellQuote } from './sshProvider';
import type { FileDiff } from '../types';
import type { WorkspaceProvider } from './types';

/** Tools that read or write the workspace, and so must run on the far side. */
export const REMOTE_HANDLED_TOOLS = new Set([
  'read_file', 'read_files', 'write_file', 'edit_file', 'append_file', 'delete_file',
  'list_directory', 'get_file_tree', 'create_directory', 'search',
  'search_in_files', 'grep_search', 'find_files',
  'run_command', 'run_background', 'get_process_output', 'send_process_input',
  'list_processes', 'stop_process',
  'git_status', 'git_diff', 'git_log', 'git_add_and_commit',
]);

export function handlesRemotely(tool: string): boolean {
  return REMOTE_HANDLED_TOOLS.has(tool.replace(/^function:/, ''));
}

export interface RemoteToolResult {
  result: string;
  diff?: FileDiff[];
}

type EventEmitter = (event: { type: string; content: string }) => void;

const MAX_READ_BYTES = 2_000_000;

function asSsh(provider: WorkspaceProvider): SshProvider {
  if (!(provider instanceof SshProvider)) {
    throw new Error('This operation needs an SSH workspace, but the current one is not remote.');
  }
  return provider;
}

/** Build the diff record the Changes panel renders, for a remote write. */
function makeDiff(relPath: string, before: string | null, after: string | null): FileDiff[] {
  const type: FileDiff['type'] = before === null ? 'created' : after === null ? 'deleted' : 'modified';
  const patch = createTwoFilesPatch(
    before === null ? '/dev/null' : `a/${relPath}`,
    after === null ? '/dev/null' : `b/${relPath}`,
    before ?? '',
    after ?? '',
    undefined,
    undefined,
    { context: 3 },
  );
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return [{ path: relPath, type, diff: patch, additions, deletions }];
}

async function readIfExists(provider: WorkspaceProvider, relPath: string): Promise<string | null> {
  const stat = await provider.stat(relPath);
  if (!stat.exists || stat.isDirectory) return null;
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`${relPath} is ${(stat.size / 1e6).toFixed(1)}MB — too large to edit safely over a network.`);
  }
  return provider.readFile(relPath);
}

/**
 * Run one tool against a remote workspace.
 *
 * Returns `null` for anything not in REMOTE_HANDLED_TOOLS, so the caller falls
 * through to the ordinary local implementation. That is the right behaviour for
 * a tool with no workspace I/O, and it is why the fall-through is explicit
 * rather than a silent default.
 */
export async function executeRemoteTool(
  toolName: string,
  args: Record<string, unknown>,
  workspacePath: string,
  onEvent?: EventEmitter,
  signal?: AbortSignal,
): Promise<RemoteToolResult | null> {
  const tool = toolName.replace(/^function:/, '');
  if (!handlesRemotely(tool)) return null;
  if (!isRemotePath(workspacePath)) return null;

  const provider = providerForWorkspacePath(workspacePath);
  await provider.ensureReady();
  const log = logger.child({ component: 'remote-tool', tool, host: provider.label });

  switch (tool) {
    // --- Reading -----------------------------------------------------------
    case 'read_file': {
      const rel = String(args.path ?? '');
      const stat = await provider.stat(rel);
      if (!stat.exists) return { result: `FAILED: ${rel} does not exist on ${provider.label}.` };
      if (stat.isDirectory) return { result: `FAILED: ${rel} is a directory. Use list_directory.` };
      if (stat.size > MAX_READ_BYTES) {
        return { result: `FAILED: ${rel} is ${(stat.size / 1e6).toFixed(1)}MB. Read a range instead, or search it.` };
      }
      const content = await provider.readFile(rel);
      const start = args.start_line != null ? Math.max(1, Number(args.start_line)) : undefined;
      const end = args.end_line != null ? Number(args.end_line) : undefined;
      if (start || end) {
        const lines = content.split('\n');
        const slice = lines.slice((start ?? 1) - 1, end ?? lines.length);
        return { result: `${rel} (lines ${start ?? 1}-${end ?? lines.length} of ${lines.length}):\n${slice.join('\n')}` };
      }
      return { result: content };
    }

    case 'read_files': {
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      const blocks: string[] = [];
      for (const rel of paths.slice(0, 25)) {
        try {
          const stat = await provider.stat(rel);
          if (!stat.exists) { blocks.push(`### ${rel}\n(not found on ${provider.label})`); continue; }
          if (stat.size > MAX_READ_BYTES) { blocks.push(`### ${rel}\n(too large: ${(stat.size / 1e6).toFixed(1)}MB)`); continue; }
          blocks.push(`### ${rel}\n${await provider.readFile(rel)}`);
        } catch (err) {
          blocks.push(`### ${rel}\n(error: ${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return { result: blocks.join('\n\n---\n\n') || 'No files were requested.' };
    }

    case 'list_directory': {
      const rel = String(args.path ?? '.');
      const entries = await provider.list(rel);
      const lines = entries
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        .map((e) => `${e.isDirectory ? 'DIR ' : 'FILE'}  ${e.name}${e.isDirectory ? '/' : ` (${e.size} bytes)`}`);
      return { result: `${rel} on ${provider.label}:\n${lines.join('\n') || '(empty)'}` };
    }

    case 'get_file_tree': {
      const entries = await provider.walk({ relPath: String(args.path ?? '.'), maxEntries: 2000 });
      const files = entries.filter((e) => !e.isDirectory).map((e) => e.path).sort();
      return {
        result: `${files.length} files under ${args.path ?? '.'} on ${provider.label}:\n${files.slice(0, 800).join('\n')}` +
          (files.length > 800 ? `\n… and ${files.length - 800} more` : ''),
      };
    }

    // --- Writing -----------------------------------------------------------
    case 'write_file': {
      const rel = String(args.path ?? '');
      const content = String(args.content ?? '');
      const before = await readIfExists(provider, rel);
      await provider.writeFile(rel, content);
      log.info('Wrote a remote file', { path: rel, bytes: content.length });
      return {
        result: `${before === null ? 'Created' : 'Overwrote'} ${rel} on ${provider.label} (${content.split('\n').length} lines).`,
        diff: makeDiff(rel, before, content),
      };
    }

    case 'append_file': {
      const rel = String(args.path ?? '');
      const addition = String(args.content ?? '');
      const before = (await readIfExists(provider, rel)) ?? '';
      const after = before.endsWith('\n') || before === '' ? before + addition : `${before}\n${addition}`;
      await provider.writeFile(rel, after);
      return {
        result: `Appended ${addition.split('\n').length} lines to ${rel} on ${provider.label}.`,
        diff: makeDiff(rel, before === '' ? null : before, after),
      };
    }

    case 'edit_file': {
      const rel = String(args.path ?? '');
      const oldText = String(args.old_text ?? args.old_string ?? '');
      const newText = String(args.new_text ?? args.new_string ?? '');
      const before = await readIfExists(provider, rel);
      if (before === null) return { result: `FAILED: ${rel} does not exist on ${provider.label}.` };
      if (!oldText) return { result: 'FAILED: edit_file needs the exact text to replace.' };

      const occurrences = before.split(oldText).length - 1;
      if (occurrences === 0) {
        return {
          result:
            `FAILED: that exact text does not appear in ${rel}. The file on ${provider.label} may differ from what you expect — ` +
            `read it again before editing. Whitespace and line endings must match exactly.`,
        };
      }
      if (occurrences > 1 && args.replace_all !== true) {
        return {
          result:
            `FAILED: that text appears ${occurrences} times in ${rel}. Include more surrounding context so the match is unique, ` +
            `or pass replace_all:true if you really mean all of them.`,
        };
      }
      const after = args.replace_all === true
        ? before.split(oldText).join(newText)
        : before.replace(oldText, newText);
      await provider.writeFile(rel, after);
      return {
        result: `Edited ${rel} on ${provider.label} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).`,
        diff: makeDiff(rel, before, after),
      };
    }

    case 'delete_file': {
      const rel = String(args.path ?? '');
      const before = await readIfExists(provider, rel);
      await provider.deleteFile(rel);
      return {
        result: `Deleted ${rel} on ${provider.label}.`,
        diff: before === null ? undefined : makeDiff(rel, before, null),
      };
    }

    case 'create_directory': {
      const rel = String(args.path ?? '');
      await provider.mkdirp(rel);
      return { result: `Created ${rel}/ on ${provider.label}.` };
    }

    // --- Search ------------------------------------------------------------
    case 'search':
    case 'search_in_files':
    case 'grep_search':
    case 'find_files':
      return { result: await remoteSearch(provider, args) };

    // --- Commands ----------------------------------------------------------
    case 'run_command': {
      const command = String(args.command ?? '');
      if (!command) return { result: 'FAILED: run_command needs a command.' };
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const timeoutMs = args.timeout_ms ? Number(args.timeout_ms) : undefined;

      const started = Date.now();
      const termId = `rterm_${Date.now().toString(36)}`;
      onEvent?.({ type: 'terminal_start', content: JSON.stringify({ id: termId, command, startTime: started }) });

      const r = await provider.execStreaming(command, {
        onStdout: (chunk) => onEvent?.({ type: 'terminal_output', content: JSON.stringify({ id: termId, stream: 'stdout', content: chunk }) }),
        onStderr: (chunk) => onEvent?.({ type: 'terminal_output', content: JSON.stringify({ id: termId, stream: 'stderr', content: chunk }) }),
      }, { cwd, timeoutMs, signal });

      onEvent?.({ type: 'terminal_end', content: JSON.stringify({ id: termId, exitCode: r.exitCode, duration: Date.now() - started }) });

      const body = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      return {
        result:
          `[${provider.label}] exit ${r.exitCode}\n${body || '(no output)'}` +
          (r.exitCode !== 0 ? `\n\nThis ran on the REMOTE host, so local paths and local tools are not available to it.` : ''),
      };
    }

    case 'run_background': {
      const command = String(args.command ?? '');
      const cwd = args.cwd ? String(args.cwd) : '.';
      const started = await remoteProcesses.start(
        asSsh(provider), command, cwd,
        (url) => onEvent?.({ type: 'preview_url', content: url }),
      );
      if (started.error) return { result: `FAILED to start it on ${provider.label}: ${started.error}` };
      return {
        result: started.reused
          ? `That command is already running on ${provider.label} as ${started.id}. Reusing it rather than starting a second copy.`
          : `Started on ${provider.label} as ${started.id}. It runs there, not locally. ` +
            `Use watch(condition:"output_match", process_id:"${started.id}", …) to know when it is ready.`,
      };
    }

    case 'get_process_output': {
      const id = String(args.process_id ?? '');
      const r = remoteProcesses.getOutput(id, { full: args.full === true });
      if (!r.ok) return { result: `FAILED: ${r.error}` };
      return {
        result:
          `[${id}] status: ${r.status}${r.exitCode != null ? `, exit ${r.exitCode}` : ''}\n` +
          (r.awaitingInput ? `WAITING FOR INPUT: ${r.awaitingInput.prompt}\n` : '') +
          (r.output || '(no new output)'),
      };
    }

    case 'send_process_input': {
      const r = remoteProcesses.sendInput(String(args.process_id ?? ''), String(args.input ?? ''));
      return { result: r.ok ? 'Sent.' : `FAILED: ${r.error}` };
    }

    case 'list_processes': {
      const list = remoteProcesses.list();
      if (list.length === 0) return { result: `No background processes on ${provider.label}.` };
      return {
        result: list.map((p) =>
          `${p.id} — ${p.command} (${p.status}${p.exitCode != null ? `, exit ${p.exitCode}` : ''}, up ${Math.round(p.uptimeMs / 1000)}s)` +
          (p.detectedUrl ? ` serving ${p.detectedUrl}` : '')).join('\n'),
      };
    }

    case 'stop_process': {
      const r = await remoteProcesses.stop(String(args.process_id ?? ''), asSsh(provider));
      return { result: r.note };
    }

    // --- Git on the remote host ---------------------------------------------
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_add_and_commit':
      return { result: await remoteGit(provider, tool, args) };

    default:
      return null;
  }
}

/**
 * Search, executed on the far side.
 *
 * Reading every candidate file over SFTP to grep it locally would move the
 * entire repository across the network for one query. `grep -r` on the host
 * moves the ANSWER. Where ripgrep is installed it is preferred — it respects
 * .gitignore natively, which is the behaviour the local engine goes to some
 * trouble to reproduce.
 */
async function remoteSearch(provider: WorkspaceProvider, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? args.pattern ?? '');
  if (!query.trim()) return 'FAILED: search needs a query.';

  const isRegex = args.regex === true;
  const wholeWord = args.whole_word === true;
  const smartCase = /[A-Z]/.test(query);
  const caseSensitive = typeof args.case_sensitive === 'boolean' ? args.case_sensitive : smartCase;
  const target = String(args.target ?? 'content');
  const searchPath = args.path ? String(args.path) : '.';
  const maxResults = Math.min(Number(args.max_results ?? 60) || 60, 500);
  const contextLines = Math.min(Number(args.context_lines ?? 0) || 0, 10);
  const include = args.include ? String(args.include) : undefined;

  const hasRg = (await provider.exec('command -v rg >/dev/null 2>&1 && echo yes', { timeoutMs: 10_000 }))
    .stdout.includes('yes');

  if (target === 'filenames') {
    // `find` is universally available; rg's --files is nicer but not worth a
    // second code path for a listing.
    const cmd = `find ${shellQuote(searchPath)} -type f -iname ${shellQuote(`*${query}*`)} 2>/dev/null | head -n ${maxResults}`;
    const r = await provider.exec(cmd, { timeoutMs: 60_000 });
    const files = r.stdout.split('\n').filter(Boolean);
    return files.length === 0
      ? `No files matching "${query}" under ${searchPath} on ${provider.label}.`
      : `${files.length} file(s) on ${provider.label}:\n${files.join('\n')}`;
  }

  let cmd: string;
  if (hasRg) {
    const flags = [
      '--line-number', '--with-filename', '--no-heading', '--color=never',
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      isRegex ? '' : '--fixed-strings',
      wholeWord ? '--word-regexp' : '',
      contextLines > 0 ? `--context ${contextLines}` : '',
      include ? `--glob ${shellQuote(include)}` : '',
      `--max-count ${maxResults}`,
    ].filter(Boolean).join(' ');
    cmd = `rg ${flags} -- ${shellQuote(query)} ${shellQuote(searchPath)} 2>/dev/null | head -n ${maxResults * (contextLines * 2 + 1)}`;
  } else {
    const flags = [
      '-rn',
      caseSensitive ? '' : '-i',
      isRegex ? '-E' : '-F',
      wholeWord ? '-w' : '',
      contextLines > 0 ? `-C ${contextLines}` : '',
      include ? `--include=${shellQuote(include)}` : '',
      "--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build",
    ].filter(Boolean).join(' ');
    cmd = `grep ${flags} -- ${shellQuote(query)} ${shellQuote(searchPath)} 2>/dev/null | head -n ${maxResults}`;
  }

  const r = await provider.exec(cmd, { timeoutMs: 90_000 });
  const lines = r.stdout.split('\n').filter(Boolean);

  if (lines.length === 0) {
    return (
      `No matches for "${query}" on ${provider.label} under ${searchPath}` +
      `${include ? ` (include: ${include})` : ''}.\n\n` +
      `This searched the REMOTE host with ${hasRg ? 'ripgrep' : 'grep'}. ` +
      `${hasRg ? 'Files ignored by git were skipped — pass include_ignored to widen it.' : 'node_modules, dist, build and .git were skipped.'} ` +
      `If you expected a hit, check the path and try target:"filenames" to confirm the file is where you think.`
    );
  }

  return (
    `${lines.length} matching line(s) on ${provider.label} (${hasRg ? 'ripgrep' : 'grep'}):\n${lines.join('\n')}` +
    (lines.length >= maxResults ? `\n\nTRUNCATED at ${maxResults} — narrow the query or the path.` : '')
  );
}

/** Git commands, run in the remote working tree. */
async function remoteGit(
  provider: WorkspaceProvider,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const isRepo = await provider.exec('git rev-parse --is-inside-work-tree 2>/dev/null', { timeoutMs: 15_000 });
  if (!isRepo.stdout.includes('true')) {
    return `FAILED: ${provider.label} is not inside a git repository, so ${tool} has nothing to work with.`;
  }

  if (tool === 'git_status') {
    const r = await provider.exec('git status --porcelain=v1 -b', { timeoutMs: 30_000 });
    return `Git status on ${provider.label}:\n${r.stdout || '(clean)'}`;
  }
  if (tool === 'git_diff') {
    const file = args.path ? ` -- ${shellQuote(String(args.path))}` : '';
    const r = await provider.exec(`git diff --stat${file} && git diff${file}`, { timeoutMs: 60_000 });
    return r.stdout.trim() || 'No unstaged changes.';
  }
  if (tool === 'git_log') {
    const n = Math.min(Number(args.limit ?? 10) || 10, 100);
    const r = await provider.exec(`git log -${n} --format='%h %ad %an: %s' --date=short`, { timeoutMs: 30_000 });
    return r.stdout.trim() || 'No commits.';
  }

  // git_add_and_commit
  const message = String(args.message ?? '').trim();
  if (!message) return 'FAILED: a commit needs a message.';
  const add = await provider.exec('git add -A', { timeoutMs: 60_000 });
  if (add.exitCode !== 0) return `FAILED to stage changes: ${add.stderr.trim()}`;
  const commit = await provider.exec(`git commit -m ${shellQuote(message)}`, { timeoutMs: 60_000 });
  if (commit.exitCode !== 0) {
    return /nothing to commit/i.test(commit.stdout + commit.stderr)
      ? 'Nothing to commit — the working tree is clean.'
      : `FAILED to commit: ${(commit.stderr || commit.stdout).trim()}`;
  }
  return `Committed on ${provider.label}:\n${commit.stdout.trim()}`;
}

/** Path helper for callers that need to show a remote path in the UI. */
export function displayRemotePath(workspacePath: string, relPath: string): string {
  if (!isRemotePath(workspacePath)) return path.join(workspacePath, relPath);
  return `${workspacePath.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`;
}
