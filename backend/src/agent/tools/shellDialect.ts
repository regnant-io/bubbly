/**
 * Which shell runs a command, and what has to be rewritten for it.
 *
 * THE BUG THIS FILE WAS WRITTEN TO KILL
 *
 * Bubbly used to run every Windows command through `powershell.exe`, and had a
 * rewrite that turned `a && b` into `a; b` — correct, because Windows
 * PowerShell 5.1 has no chain operators and `&&` is a hard parse error there.
 *
 * Then the shell was switched to `cmd.exe` (to dodge npm.ps1's $LASTEXITCODE
 * bug) and the rewrite stayed. In cmd.exe the situation is exactly inverted:
 * `&&` is valid and `;` is NOT a separator at all — it is an ordinary character
 * that cmd hands to the program. So `cd app && npm install` was rewritten to
 * `cd app; npm install`, which cmd parses as a single `cd` into a directory
 * literally named `app; npm install`. Every chained command in the product was
 * silently destroyed: the first half didn't run, the second half didn't exist,
 * and the error ("The system cannot find the path specified") pointed nowhere
 * near the cause.
 *
 * The lesson is that "normalize the command" is meaningless without knowing the
 * dialect. So the dialect is now explicit, chosen PER COMMAND, and every
 * rewrite is a function of it.
 *
 * PER-COMMAND ROUTING
 *
 * Models emit whatever shell they think in — usually POSIX, sometimes
 * PowerShell. Rather than fight that with prompt rules alone, a command that
 * clearly needs a particular shell is GIVEN that shell, when one is available:
 * `Get-ChildItem | Where-Object …` goes to PowerShell, `grep -r foo . | head`
 * goes to Git Bash if it is installed, and everything else goes to cmd.exe
 * where npm and node behave best. The routing decision is reported back to the
 * agent so it learns what actually ran.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export type ShellDialect = 'cmd' | 'powershell' | 'posix';

export interface ResolvedShell {
  /** Executable to spawn. */
  file: string;
  /** Full argv for the spawn, including the command itself. */
  args: string[];
  dialect: ShellDialect;
  /** Human-readable name for logs and for the agent-facing note. */
  name: string;
  /** Set when this shell was chosen because of the command's own syntax. */
  reason?: string;
}

/** Preference from settings. 'auto' routes per command (the default). */
export type ShellPreference = 'auto' | 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh' | 'zsh';

// --- Availability probing (cached: these answers never change at runtime) ----

const availability = new Map<string, string | null>();

function locate(candidates: string[], probeName?: string): string | null {
  const key = probeName ?? candidates.join('|');
  if (availability.has(key)) return availability.get(key)!;

  let found: string | null = null;
  let probeFailed = false;

  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) { found = c; break; }
      continue;
    }
    // Ask the OS where it is. `where` on Windows, `command -v` elsewhere.
    try {
      const probe = process.platform === 'win32'
        ? spawnSync('where', [c], { encoding: 'utf8', windowsHide: true, timeout: 4_000 })
        : spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8', timeout: 4_000 });
      // A probe that could not RUN — a spawn failure, or a timeout under load —
      // says nothing about whether the tool exists. Caching that as "absent" is
      // how one hiccup permanently downgrades every later command in the
      // process, which showed up as a PowerShell command being routed to
      // cmd.exe and failing, intermittently, only under parallel load.
      if (probe.error || probe.status === null) { probeFailed = true; continue; }
      const first = (probe.stdout ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
      if (probe.status === 0 && first) { found = first; break; }
    } catch {
      probeFailed = true;
    }
  }

  // Only remember a definite answer.
  if (found || !probeFailed) availability.set(key, found);
  return found;
}

/** PowerShell 7+ (`pwsh`) supports `&&`; Windows PowerShell 5.1 does not. */
export function findPwsh(): string | null {
  return locate(['pwsh.exe', 'pwsh'], 'pwsh');
}

export function findWindowsPowerShell(): string | null {
  const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return locate([
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ], 'powershell');
}

/** Git Bash / WSL-free POSIX shell on Windows, if the user has Git installed. */
export function findGitBash(): string | null {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  return locate([
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    local ? path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    'bash.exe',
  ].filter(Boolean), 'gitbash');
}

function findUnixShell(): string {
  const preferred = process.env.SHELL;
  if (preferred && fs.existsSync(preferred)) return preferred;
  for (const c of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (fs.existsSync(c)) return c;
  }
  return '/bin/sh';
}

// --- Syntax sniffing --------------------------------------------------------

/** Constructs only PowerShell understands. */
const POWERSHELL_SYNTAX = [
  /\$env:/i,
  /\b(?:Get|Set|New|Remove|Test|Write|Select|Where|ForEach|ConvertTo|ConvertFrom|Out|Start|Stop|Invoke|Measure|Copy|Move|Rename|Join|Split|Resolve)-[A-Z][a-zA-Z]+/,
  /-ErrorAction\b/i,
  /\|\s*(?:Where|Select|ForEach|Measure|Sort|Format)-/i,
  /@['"][\s\S]*['"]@/,        // here-strings
  /\[(?:System\.)?[A-Za-z.]+\]::/,  // .NET static calls
];

/** Constructs only a POSIX shell understands. cmd.exe chokes on all of these. */
const POSIX_SYNTAX = [
  /\$\([^)]*\)/,                 // command substitution
  /`[^`]*`/,                     // legacy substitution
  /<<-?\s*['"]?\w+/,             // heredoc
  /\b2>\s*\/dev\/null/,
  /(?:^|[;&|]\s*)export\s+\w+=/,
  /(?:^|[;&|]\s*)(?:grep|sed|awk|chmod|chown|ln\s+-s|xargs|tee|head|tail|wc|cut|tr|sort\s+-|uniq)\b/,
  /\|\s*(?:grep|sed|awk|xargs|head|tail|wc|less|jq)\b/,
  /\$\{\w+/,                     // ${VAR} expansion
  /(?:^|\s)\w+=\S+\s+\w/,        // VAR=value cmd  (inline env prefix)
];

function looksLike(command: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(command));
}

// --- Shell resolution -------------------------------------------------------

function cmdShell(reason?: string): ResolvedShell {
  const file = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  return { file, args: [], dialect: 'cmd', name: 'cmd.exe', reason };
}

/**
 * Choose the shell for one command.
 *
 * `preference` comes from settings. 'auto' (the default) routes per command:
 * PowerShell syntax goes to PowerShell, POSIX syntax goes to Git Bash when it
 * exists, and everything else goes to cmd.exe — which is where npm, node and
 * the whole JS toolchain are most reliable on Windows.
 */
export function resolveShell(command: string, preference: ShellPreference = 'auto'): ResolvedShell {
  if (process.platform !== 'win32') {
    const explicit =
      preference === 'bash' ? locate(['bash']) :
      preference === 'zsh' ? locate(['zsh']) :
      preference === 'sh' ? locate(['sh']) :
      preference === 'pwsh' || preference === 'powershell' ? findPwsh() :
      null;
    const file = explicit ?? findUnixShell();
    const dialect: ShellDialect = /pwsh/.test(file) ? 'powershell' : 'posix';
    return { file, args: [], dialect, name: path.basename(file) };
  }

  // --- Windows ---
  if (preference === 'cmd') return cmdShell();

  if (preference === 'powershell' || preference === 'pwsh') {
    const seven = findPwsh();
    const five = findWindowsPowerShell();
    const file = (preference === 'pwsh' ? seven : five ?? seven) ?? seven ?? five;
    if (file) return { file, args: [], dialect: 'powershell', name: path.basename(file) };
    return cmdShell('PowerShell was requested but not found');
  }

  if (preference === 'bash' || preference === 'sh' || preference === 'zsh') {
    const bash = findGitBash();
    if (bash) return { file: bash, args: [], dialect: 'posix', name: 'bash' };
    return cmdShell('bash was requested but Git Bash is not installed');
  }

  // preference === 'auto' — route on the command's own syntax.
  if (looksLike(command, POWERSHELL_SYNTAX)) {
    const file = findPwsh() ?? findWindowsPowerShell();
    if (file) {
      return {
        file, args: [], dialect: 'powershell', name: path.basename(file),
        reason: 'the command uses PowerShell syntax (cmdlets, $env:, or a pipeline of them)',
      };
    }
  }

  if (looksLike(command, POSIX_SYNTAX)) {
    const bash = findGitBash();
    if (bash) {
      return {
        file: bash, args: [], dialect: 'posix', name: 'bash',
        reason: 'the command uses POSIX shell syntax that cmd.exe cannot parse',
      };
    }
  }

  return cmdShell();
}

/**
 * Build the full argv for a resolved shell running `command`.
 *
 * THE cmd.exe CASE IS NOT COSMETIC — IT DECIDES WHETHER EXIT CODES SURVIVE.
 *
 * Node quotes each argv element for Windows using MSVCRT rules, which escape an
 * embedded double quote as `\\"`. cmd.exe has never understood that escape.
 * So passing the command as a plain argv element meant that
 *
 *     node -e "process.exit(3)"
 *
 * reached cmd as
 *
 *     node -e \\"process.exit(3)\\"
 *
 * — a different program, which did not run, and whose failure cmd reported as
 * SUCCESS. Measured on a real machine: exit code 3 came back as 0. Every command
 * containing a double quote was silently corrupted, and every non-zero exit code
 * from one was reported to the agent as a clean success. The agent then built on
 * top of steps that had never actually run.
 *
 * The fix is the one Node itself uses internally for `shell: true` on Windows:
 * wrap the whole command in quotes, and set `windowsVerbatimArguments` so Node
 * passes the string through untouched. `/s` then tells cmd to strip exactly that
 * outer pair, leaving the command's own quotes intact.
 */
export function shellArgv(shell: ResolvedShell, command: string): string[] {
  switch (shell.dialect) {
    case 'cmd':
      // /d skips AutoRun, /s strips our outer quote pair, /c runs and exits.
      return ['/d', '/s', '/c', `"${command}"`];
    case 'powershell':
      return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
    case 'posix':
      return ['-c', command];
  }
}

/**
 * Must this shell's argv be passed to the OS verbatim?
 *
 * True only for cmd.exe, and only because of the quoting rules above. Every
 * spawn site must honour it — a spawn that forgets is the exit-code bug back
 * again, and it fails silently.
 */
export function needsVerbatimArguments(shell: ResolvedShell): boolean {
  return shell.dialect === 'cmd';
}

// --- Command normalization --------------------------------------------------

export interface Normalized {
  command: string;
  /** What was rewritten, for the agent-facing result. Empty when untouched. */
  notes: string[];
}

/**
 * Walk a command tracking quote state, calling `onOperator` for each two-char
 * operator found OUTSIDE quotes. Used by the dialect rewrites so a `&&` inside
 * a quoted string is never touched.
 */
function rewriteOperators(
  command: string,
  replace: (op: '&&' | '||') => string | null,
): { out: string; changed: boolean } {
  let out = '';
  let quote: '"' | "'" | null = null;
  let changed = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      out += ch;
      if (ch === quote) {
        if (command[i + 1] === quote) { out += command[i + 1]; i++; }
        else quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }

    const pair = command.slice(i, i + 2) as '&&' | '||';
    if (pair === '&&' || pair === '||') {
      const replacement = replace(pair);
      if (replacement !== null) {
        out = out.replace(/\s+$/, '') + replacement;
        i++;
        while (/\s/.test(command[i + 1] ?? '')) i++;
        changed = true;
        continue;
      }
    }

    out += ch;
  }

  return { out, changed };
}

/**
 * Unix commands models reach for constantly, and their cmd.exe equivalents.
 *
 * Only rewritten when the word is THE COMMAND — at the start of the line or
 * directly after a separator — so `git ls-files` and `npm i cat-names` are
 * untouched. Anything whose translation would change semantics (rm, mv, cp with
 * flags) is left alone and reported instead of guessed at.
 */
const CMD_TRANSLATIONS: Array<{ from: RegExp; to: string; note: string }> = [
  { from: /^ls(\s+-[a-zA-Z]+)*(\s|$)/, to: 'dir ', note: 'ls → dir' },
  { from: /^pwd(\s|$)/, to: 'cd ', note: 'pwd → cd' },
  { from: /^clear(\s|$)/, to: 'cls ', note: 'clear → cls' },
  { from: /^which(\s|$)/, to: 'where ', note: 'which → where' },
  { from: /^cat(\s|$)/, to: 'type ', note: 'cat → type' },
  { from: /^touch\s+(\S+)$/, to: 'type nul > $1', note: 'touch → type nul >' },
];

function translateSegmentForCmd(segment: string): { text: string; note?: string } {
  const trimmed = segment.replace(/^\s+/, '');
  const lead = segment.slice(0, segment.length - trimmed.length);
  for (const t of CMD_TRANSLATIONS) {
    if (t.from.test(trimmed)) {
      return { text: lead + trimmed.replace(t.from, t.to).trimEnd() + ' ', note: t.note };
    }
  }
  return { text: segment };
}

/**
 * Rewrite a command for the dialect that will actually run it.
 *
 * cmd.exe:      `&&`/`||` are LEFT ALONE (they are native), and a handful of
 *               unambiguous Unix command names are translated.
 * PowerShell 5: `&&`/`||` are a parse error, so they become `;`.
 * PowerShell 7: native `&&`/`||`; nothing to do.
 * POSIX:        nothing to do.
 */
export function normalizeForDialect(command: string, shell: ResolvedShell): Normalized {
  const notes: string[] = [];

  if (shell.dialect === 'posix') return { command, notes };

  if (shell.dialect === 'powershell') {
    // pwsh 7+ understands the chain operators; only 5.1 needs the rewrite.
    const isFive = /WindowsPowerShell|powershell\.exe$/i.test(shell.file) && !/pwsh/i.test(shell.file);
    if (!isFive) return { command, notes };
    const { out, changed } = rewriteOperators(command, () => '; ');
    if (changed) {
      notes.push('Windows PowerShell 5.1 has no && / || operators, so they were run sequentially with ";".');
    }
    return { command: out, notes };
  }

  // --- cmd.exe ---
  // Split on cmd's own separators so each segment's leading word can be
  // examined. `&&`, `||` and `&` all separate; everything else is content.
  let out = '';
  let segment = '';
  let quote: '"' | "'" | null = null;

  const flush = () => {
    const t = translateSegmentForCmd(segment);
    if (t.note && !notes.includes(t.note)) notes.push(t.note);
    out += t.text;
    segment = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      segment += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; segment += ch; continue; }

    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||') { flush(); out += pair; i++; continue; }
    if (ch === '&' || ch === '|') { flush(); out += ch; continue; }
    segment += ch;
  }
  flush();

  if (notes.length > 0) {
    notes.unshift('This ran in cmd.exe, where some Unix command names do not exist. Translated:');
  }

  return { command: out, notes };
}

/**
 * A short line telling the agent which shell ran the command and why — appended
 * to a FAILED result only, where it is the difference between "my command is
 * wrong" and "I used the wrong dialect".
 */
export function shellHint(shell: ResolvedShell, notes: string[]): string {
  const parts: string[] = [];
  parts.push(
    `Shell: ${shell.name} (${shell.dialect})${shell.reason ? ` — chosen because ${shell.reason}` : ''}.`,
  );
  if (notes.length > 0) parts.push(notes.join(' '));
  if (shell.dialect === 'cmd') {
    parts.push(
      'cmd.exe syntax applies: `&&` and `||` chain commands, `%VAR%` reads a variable, `dir`/`type`/`where` replace `ls`/`cat`/`which`. ' +
      'For PowerShell or POSIX syntax, write the command in that dialect and it will be routed to the right shell automatically.',
    );
  }
  return parts.join('\n');
}
