/**
 * Search — one tool for finding things.
 *
 * WHY ONE TOOL AND NOT THREE
 *
 * There used to be `search_in_files` (literal, no options), `grep_search`
 * (regex, globs, context) and `find_files` (fuzzy filename). Three tools whose
 * descriptions all began "search for…", differing in ways a model has to
 * remember rather than discover. The observable result was that models picked
 * whichever name came to mind, most often the weakest one.
 *
 * One tool with explicit switches removes the guess. `regex` is a flag rather
 * than a different tool, `target` chooses content or filenames or both, and
 * `mode` chooses how much to return.
 *
 * WHAT MAKES THE RESULT USEFUL RATHER THAN MERELY CORRECT
 *
 *  - Results are GROUPED BY FILE. A flat list of `path:line` repeats the same
 *    long path for every hit and buries the shape of the answer.
 *  - The output is BUDGETED, and says what it dropped. A truncated list that
 *    doesn't admit truncation is actively misleading.
 *  - Zero results come with a DIAGNOSIS, not a dead end.
 *  - Case sensitivity is SMART by default.
 *
 * THREE BUGS THIS FILE HAS BEEN CORRECTED FOR
 *
 *  1. A BARE GLOB SILENTLY MATCHED NOTHING. Globs are tested against the whole
 *     path from the workspace root, so `include: "*.ts"` — which is what a model
 *     writes nine times out of ten — matched `index.ts` at the root and NOTHING
 *     nested. The search came back empty and looked authoritative. Patterns are
 *     now normalized: a pattern with no `/` is anchored at any depth, and a bare
 *     directory name means "everything under it".
 *  2. IT COULD HANG THE SERVER. Every candidate file was read synchronously with
 *     no ceiling on how many, so a search over a large monorepo blocked the
 *     event loop — the WebSocket froze, the UI stopped updating, and the agent
 *     appeared to have died. There are now file, byte and TIME budgets, and the
 *     walk yields to the event loop.
 *  3. IT IGNORED .gitignore. Build output that happened not to be called `dist`
 *     was searched, so a symbol's real definition was buried under forty copies
 *     of it in a generated bundle.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { resolveSafePath } from './filesystem';
import { logger } from '../../utils/logger';

export type SearchTarget = 'content' | 'filenames' | 'both';
export type SearchMode = 'content' | 'files' | 'count';

export interface SearchOptions {
  query: string;
  target?: SearchTarget;
  mode?: SearchMode;
  regex?: boolean;
  wholeWord?: boolean;
  /** true/false forces it; undefined means smart-case. */
  caseSensitive?: boolean;
  searchPath?: string;
  /** Glob(s) to include. Accepts a comma-separated list or an array. */
  include?: string | string[];
  /** Glob(s) to exclude. Accepts a comma-separated list or an array. */
  exclude?: string | string[];
  contextLines?: number;
  maxResults?: number;
  /** Search dotfiles and dot-directories too. Off by default. */
  includeHidden?: boolean;
  /** Search files git ignores. Off by default. */
  includeIgnored?: boolean;
  /** Let `.` match newlines so a pattern can span lines. Implies regex. */
  multiline?: boolean;
  /** Hard ceiling on wall-clock time. Defaults to SEARCH_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
  /** Column of the match within the line (1-based), for precise navigation. */
  column?: number;
  /** Lines around the hit, when contextLines > 0. */
  context?: Array<{ line: number; text: string }>;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Files that contained at least one hit, in first-seen order. */
  files: string[];
  /** Total hits found, so truncation can be reported honestly. */
  totalHits: number;
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
  /** Set when the walk stopped because it ran out of time rather than results. */
  timedOut?: boolean;
  error?: string;
  /** Per-file counts, for mode 'count'. */
  counts?: Array<{ file: string; count: number }>;
  /** The include globs actually used, after normalization. Shown to the agent
   *  so a silently-rewritten pattern is never a mystery. */
  effectiveInclude?: string[];
  elapsedMs?: number;
}

const DEFAULT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'vendor', 'target', 'bin', 'obj', 'Pods', '.gradle', '.idea', '.terraform',
  'bower_components', 'jspm_packages', '.pnpm-store', '.yarn',
]);

/** Directory names that are skipped even when hidden files are requested. */
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Files above this are almost certainly generated; scanning them is a waste. */
const MAX_FILE_BYTES = 2_000_000;

/** Ceilings that stop a search from becoming an outage. */
export const SEARCH_FILE_BUDGET = 20_000;
export const SEARCH_TIME_BUDGET_MS = 8_000;
/** How often the walk yields, so the WebSocket keeps flowing during a search. */
const YIELD_EVERY_FILES = 400;

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']']);

/** Extensions we never even open — binary by definition. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib', '.pdb',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.webm', '.flac', '.ogg',
  '.class', '.jar', '.wasm', '.pyc', '.pyo', '.node', '.sqlite', '.db',
]);

/** Friendly language names → the extensions they cover, for `include`. */
export const FILE_TYPE_GROUPS: Record<string, string[]> = {
  ts: ['ts', 'tsx', 'mts', 'cts'],
  js: ['js', 'jsx', 'mjs', 'cjs'],
  web: ['ts', 'tsx', 'js', 'jsx', 'html', 'css', 'scss', 'less', 'vue', 'svelte'],
  py: ['py', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  java: ['java', 'kt', 'kts', 'scala', 'groovy'],
  c: ['c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'hxx'],
  csharp: ['cs', 'csproj'],
  ruby: ['rb', 'erb', 'rake'],
  php: ['php'],
  swift: ['swift'],
  shell: ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'],
  config: ['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'properties'],
  docs: ['md', 'mdx', 'rst', 'txt', 'adoc'],
  sql: ['sql'],
};

// --- Glob handling ----------------------------------------------------------

/**
 * Split a user/model-supplied pattern list into individual patterns.
 * Accepts an array, or a comma- or space-separated string, or a brace group.
 */
export function splitPatterns(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((p) => p.trim()).filter(Boolean);

  // Split on commas OUTSIDE brace groups: "*.{ts,tsx},docs" is two patterns,
  // not three. Splitting naively broke every braced glob a model wrote.
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Expand `{a,b}` groups into separate patterns. `src/*.{ts,tsx}` → two globs. */
export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const [whole, inner] = m;
  const out: string[] = [];
  for (const part of inner.split(',')) {
    out.push(...expandBraces(pattern.replace(whole, part.trim())));
  }
  return out;
}

/**
 * Make a pattern mean what the person writing it meant.
 *
 * THE SINGLE MOST DAMAGING SEARCH BUG was that `include: "*.ts"` matched only
 * top-level files, because globs are tested against the path from the workspace
 * root. A search for a symbol "in the TypeScript files" therefore scanned two
 * files and reported, with total confidence, that the symbol did not exist.
 *
 * Rules, in order:
 *   - A named file-type group ("ts", "web", "config") expands to its extensions.
 *   - A bare extension ("ts", ".ts", "*.ts") means that extension at ANY depth.
 *   - A pattern with no `/` at all is anchored at any depth (`**​/` prefixed).
 *   - A bare directory name or a trailing `/` means everything beneath it.
 *   - Anything already containing `/` or `**` is left exactly as written.
 */
export function normalizeGlob(pattern: string): string[] {
  const p = pattern.replace(/\\/g, '/').trim();
  if (!p) return [];

  const group = FILE_TYPE_GROUPS[p.toLowerCase()];
  if (group) return group.map((ext) => `**/*.${ext}`);

  // "ts" / ".ts" → **/*.ts
  const bareExt = /^\.?([A-Za-z0-9_+-]+)$/.exec(p);
  if (bareExt && !p.includes('*') && !p.includes('/') && !p.includes('.') && bareExt[1].length <= 6) {
    // Ambiguous: could be an extension or a directory. Match both — a directory
    // that does not exist costs nothing, and a missed match costs everything.
    return [`**/*.${bareExt[1]}`, `${bareExt[1]}/**`, `**/${bareExt[1]}/**`];
  }

  if (p.endsWith('/')) return [`${p}**`];

  if (!p.includes('/')) {
    // "*.ts", "README*", "package.json" — anchor at any depth.
    return [p.startsWith('**') ? p : `**/${p}`];
  }

  // Contains a slash: honour it as written, but a trailing bare directory
  // segment ("src/components") should still mean everything beneath it.
  if (!p.includes('*') && !p.includes('.')) return [`${p}/**`, p];

  return [p];
}

/** Turn a caller's include/exclude value into the concrete globs used. */
export function effectiveGlobs(value: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of splitPatterns(value)) {
    for (const braced of expandBraces(raw)) {
      out.push(...normalizeGlob(braced));
    }
  }
  return [...new Set(out)];
}

/**
 * Minimal but correct glob to RegExp.
 *
 * Written as a single left-to-right scan rather than a chain of replaces. The
 * subtlety that actually matters: a leading double-star followed by a slash
 * must match ZERO or more directories, so a pattern written for nested files
 * still matches a top-level one.
 */
export function globToRegExp(glob: string): RegExp | null {
  const g = glob.replace(/\\/g, '/').trim();
  if (!g) return null;

  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];

    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';   // "**/" -> zero or more directories
          i += 2;
        } else {
          out += '.*';         // "**"  -> anything at all, across separators
          i += 1;
        }
      } else {
        out += '[^/]*';        // "*"   -> within one path segment
      }
      continue;
    }

    if (c === '?') { out += '[^/]'; continue; }
    if (c === '/') { out += '/'; continue; }
    out += REGEX_SPECIALS.has(c) ? `\\${c}` : c;
  }

  // Paths are compared case-insensitively on Windows and macOS, where the
  // filesystem itself is. A glob that fails only because of a capital letter is
  // indistinguishable from "no such file" to whoever is reading the result.
  const flags = process.platform === 'linux' ? '' : 'i';
  try { return new RegExp(`^${out}$`, flags); } catch { return null; }
}

function anyMatch(res: RegExp[], rel: string): boolean {
  return res.some((re) => re.test(rel));
}

// --- .gitignore -------------------------------------------------------------

interface IgnoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * A deliberately small .gitignore reader.
 *
 * It handles the forms that actually appear in real projects — `dist/`,
 * `*.log`, `/build`, `!keep.txt`, `**​/tmp` — and ignores the exotic corners.
 * Being approximate is fine here: the cost of wrongly skipping a file is that a
 * search misses it, so anything uncertain is NOT ignored.
 */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let body = line;
    const negated = body.startsWith('!');
    if (negated) body = body.slice(1);

    const dirOnly = body.endsWith('/');
    if (dirOnly) body = body.slice(0, -1);

    // A pattern with no slash (other than a trailing one) applies at any depth.
    const anchored = body.startsWith('/');
    if (anchored) body = body.slice(1);
    const pattern = anchored || body.includes('/') ? body : `**/${body}`;

    const re = globToRegExp(pattern);
    if (!re) continue;
    // Match the path itself OR anything beneath it.
    const source = re.source.replace(/\$$/, '(?:/.*)?$');
    rules.push({ re: new RegExp(source, re.flags), negated, dirOnly });
  }
  return rules;
}

function loadIgnoreRules(root: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const name of ['.gitignore', '.bubblyignore']) {
    try {
      const p = path.join(root, name);
      if (fs.existsSync(p)) rules.push(...parseGitignore(fs.readFileSync(p, 'utf8')));
    } catch { /* an unreadable ignore file just means no rules */ }
  }
  return rules;
}

function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (!rule.re.test(rel)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

// --- Matching ---------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matcher. Returns an error string rather than throwing: a model's
 * malformed regex should come back as advice, not as a crashed tool call.
 */
export function buildMatcher(opts: SearchOptions): { re: RegExp } | { error: string } {
  const smartCase = /[A-Z]/.test(opts.query);
  const sensitive = opts.caseSensitive ?? smartCase;
  // `g` is required so `lastIndex` can walk every match on a line; every use
  // site resets lastIndex, which is the discipline a global regex demands.
  let flags = 'g';
  if (!sensitive) flags += 'i';
  if (opts.multiline) flags += 's';

  const useRegex = opts.regex || opts.multiline;
  let source = useRegex ? opts.query : escapeRegExp(opts.query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;

  try {
    return { re: new RegExp(source, flags) };
  } catch (err) {
    return {
      error:
        `Invalid regex "${opts.query}": ${err instanceof Error ? err.message : String(err)}. ` +
        `If you meant to search for this text literally, drop regex:true — then characters like ( ) [ ] . * + ? are treated as themselves.`,
    };
  }
}

/** Every match position on one line. */
function matchColumns(re: RegExp, line: string, cap = 20): number[] {
  re.lastIndex = 0;
  const cols: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    cols.push(m.index + 1);
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width match guard
    if (cols.length >= cap) break;
  }
  return cols;
}

function looksBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// --- The walk ---------------------------------------------------------------

interface WalkContext {
  root: string;
  workspacePath: string;
  includeRes: RegExp[];
  excludeRes: RegExp[];
  ignoreRules: IgnoreRule[];
  opts: SearchOptions;
  deadline: number;
}

/**
 * Run a search. Asynchronous so a large tree cannot block the event loop — the
 * WebSocket has to keep flowing while this runs, or the whole UI freezes and
 * the agent looks dead.
 */
export async function runSearch(workspacePath: string, opts: SearchOptions): Promise<SearchOutcome> {
  const startedAt = Date.now();
  const target: SearchTarget = opts.target ?? 'content';
  const mode: SearchMode = opts.mode ?? 'content';
  const maxResults = Math.min(Math.max(opts.maxResults ?? 60, 1), 1000);
  const ctxLines = Math.min(Math.max(opts.contextLines ?? 0, 0), 10);

  const base: SearchOutcome = {
    hits: [], files: [], totalHits: 0, filesScanned: 0, filesSkipped: 0, truncated: false,
  };

  if (!opts.query || !opts.query.trim()) {
    return { ...base, error: 'Empty query — say what you are looking for.' };
  }

  let root: string;
  try {
    root = resolveSafePath(workspacePath, opts.searchPath ?? '.');
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  if (!fs.existsSync(root)) {
    return { ...base, error: `Search path "${opts.searchPath}" does not exist in the workspace.` };
  }

  const matcher = buildMatcher(opts);
  if ('error' in matcher) return { ...base, error: matcher.error };
  const { re } = matcher;

  const includeGlobs = effectiveGlobs(opts.include);
  const excludeGlobs = effectiveGlobs(opts.exclude);
  const includeRes = includeGlobs.map(globToRegExp).filter((r): r is RegExp => r !== null);
  const excludeRes = excludeGlobs.map(globToRegExp).filter((r): r is RegExp => r !== null);

  const ctx: WalkContext = {
    root,
    workspacePath,
    includeRes,
    excludeRes,
    ignoreRules: opts.includeIgnored ? [] : loadIgnoreRules(workspacePath),
    opts,
    deadline: startedAt + Math.min(opts.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS, 60_000),
  };

  const hits: SearchHit[] = [];
  const fileOrder: string[] = [];
  const perFile = new Map<string, number>();
  let totalHits = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let filesConsidered = 0;
  let stop = false;
  let timedOut = false;

  const noteHit = (rel: string) => {
    if (!perFile.has(rel)) { perFile.set(rel, 0); fileOrder.push(rel); }
    perFile.set(rel, perFile.get(rel)! + 1);
    totalHits++;
  };

  const searchesContent = target === 'content' || target === 'both';
  const searchesNames = target === 'filenames' || target === 'both';

  const walk = async (dir: string): Promise<void> => {
    if (stop) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

    // Directories first would reorder results unhelpfully; keep on-disk order
    // but sort so results are deterministic across platforms.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (stop) return;

      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (!opts.includeIgnored && DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (!opts.includeHidden && entry.name.startsWith('.')
            && entry.name !== '.bubbly' && entry.name !== '.github' && entry.name !== '.vscode') continue;
        if (isIgnored(ctx.ignoreRules, rel, true)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!opts.includeHidden && entry.name.startsWith('.') && !entry.name.startsWith('.env')) {
        // Dotfiles are usually config the agent DOES want, so only the truly
        // hidden ones are skipped — and `.env*` is always interesting.
        if (!/^\.(?:gitignore|editorconfig|npmrc|nvmrc|prettierrc|eslintrc)/.test(entry.name)) continue;
      }

      if (includeRes.length > 0 && !anyMatch(includeRes, rel)) continue;
      if (excludeRes.length > 0 && anyMatch(excludeRes, rel)) continue;
      if (isIgnored(ctx.ignoreRules, rel, false)) continue;

      filesConsidered++;
      if (filesConsidered % YIELD_EVERY_FILES === 0) {
        // Hand the event loop back so the socket keeps flowing during a big
        // search. Without this the whole app freezes for the duration.
        await new Promise<void>((r) => setImmediate(r));
        if (Date.now() > ctx.deadline) { timedOut = true; stop = true; return; }
      }
      if (filesConsidered > SEARCH_FILE_BUDGET) { timedOut = true; stop = true; return; }

      if (searchesNames) {
        re.lastIndex = 0;
        if (re.test(rel)) {
          noteHit(rel);
          if (!searchesContent && fileOrder.length >= maxResults) { stop = true; return; }
        }
        if (!searchesContent) { filesScanned++; continue; }
      }

      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) { filesSkipped++; continue; }

      let stat: fs.Stats;
      try { stat = await fsp.stat(full); } catch { filesSkipped++; continue; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { filesSkipped++; continue; }

      let buf: Buffer;
      try { buf = await fsp.readFile(full); } catch { filesSkipped++; continue; }
      if (looksBinaryBuffer(buf)) { filesSkipped++; continue; }
      const content = buf.toString('utf8');
      filesScanned++;

      if (opts.multiline) {
        // Multiline patterns are matched against the whole file; the reported
        // line is where the match starts.
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const lineNo = content.slice(0, m.index).split('\n').length;
          noteHit(rel);
          if (mode === 'content' && hits.length < maxResults) {
            hits.push({ file: rel, line: lineNo, text: m[0].slice(0, 400).replace(/\n/g, '⏎ ') });
          }
          if (m.index === re.lastIndex) re.lastIndex++;
          if (totalHits > maxResults * 20) { stop = true; break; }
        }
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const cols = matchColumns(re, lines[i]);
        if (cols.length === 0) continue;
        // One hit per line (with the first column recorded) keeps the output
        // readable; the count is still per-match so totals stay honest.
        for (let k = 0; k < cols.length; k++) noteHit(rel);

        if (mode === 'content' && hits.length < maxResults) {
          const hit: SearchHit = {
            file: rel,
            line: i + 1,
            column: cols[0],
            text: lines[i].slice(0, 400),
          };
          if (ctxLines > 0) {
            const from = Math.max(0, i - ctxLines);
            const to = Math.min(lines.length, i + ctxLines + 1);
            hit.context = lines.slice(from, to).map((text, k) => ({ line: from + k + 1, text: text.slice(0, 300) }));
          }
          hits.push(hit);
        }
        if (totalHits > maxResults * 20) { stop = true; break; }
      }
    }
  };

  await walk(root);

  const truncated =
    (mode === 'content' && searchesContent ? totalHits > hits.length : false) ||
    (searchesNames && !searchesContent ? stop : false) ||
    timedOut;
  const counts = fileOrder.map((f) => ({ file: f, count: perFile.get(f) ?? 0 }));
  const elapsedMs = Date.now() - startedAt;

  logger.debug('Search complete', {
    query: opts.query, target, mode, filesScanned, totalHits, truncated, timedOut, elapsedMs,
  });

  return {
    hits, files: fileOrder, totalHits, filesScanned, filesSkipped, truncated, timedOut,
    counts, effectiveInclude: includeGlobs, elapsedMs,
  };
}

/**
 * Explain an empty result.
 *
 * "No matches found." is where an agent's search loop goes to die: it retries
 * the same query, then a vaguer one, then gives up and reads files at random.
 * Almost every genuine zero-result has a specific, checkable cause, and naming
 * it turns a dead end into the next action.
 */
export function diagnoseEmptySearch(opts: SearchOptions, outcome: SearchOutcome): string {
  const notes: string[] = [];

  if (outcome.timedOut) {
    notes.push(
      `The search hit its budget (${outcome.filesScanned} files in ${outcome.elapsedMs}ms) and stopped early, ` +
      `so this is NOT proof the text is absent. Narrow it with search_path or include and run it again.`,
    );
  }

  if (opts.include) {
    const eff = (outcome.effectiveInclude ?? []).join(', ');
    notes.push(
      outcome.filesScanned === 0
        ? `Nothing was scanned: the include glob (${eff || String(opts.include)}) matched no files.`
        : `Only ${outcome.filesScanned} file(s) matched the include glob (${eff || String(opts.include)}) — the text may be in a file it excluded.`,
    );
    notes.push(
      `Include patterns are expanded for you: "*.ts" and "ts" both become "**/*.ts", so depth is not the problem. ` +
      `Try again without the include glob if you are not sure where the file lives.`,
    );
  }

  if (outcome.filesScanned === 0 && !opts.include) {
    if (opts.searchPath && opts.searchPath !== '.') {
      notes.push(`Nothing was scanned under "${opts.searchPath}" — check that directory exists and is not skipped (node_modules, dist, .git…).`);
    } else {
      notes.push('Nothing was scanned. The workspace may be empty, or everything in it is excluded (node_modules, dist, .git…).');
    }
  }

  if (!opts.includeIgnored) {
    notes.push('Files matched by .gitignore were skipped. Pass include_ignored:true if the text might be in build output or a vendored copy.');
  }

  if (opts.regex) {
    notes.push('This ran as a REGEX. If the query contained characters like ( ) [ ] . * + ? that you meant literally, re-run without regex:true.');
  } else if (/[\\^$.*+?()[\]{}|]/.test(opts.query)) {
    notes.push('This ran as a LITERAL string, so regex metacharacters were matched as themselves. If you meant a pattern, pass regex:true.');
  }

  if (/[A-Z]/.test(opts.query) && opts.caseSensitive === undefined) {
    notes.push('The query contains an uppercase letter, so it was matched case-SENSITIVELY (smart case). Pass case_sensitive:false to widen it.');
  }

  if (opts.wholeWord) {
    notes.push('whole_word was on, so "foo" would not match "foobar". Turn it off to match substrings.');
  }

  if (opts.target === 'content') {
    notes.push('If you are looking for a FILE rather than for text inside one, use target:"filenames" (or "both").');
  }

  notes.push('For a code symbol, find_symbol / find_references understand declarations and call sites and are usually a better move than text search.');

  return notes.join('\n');
}

/** Render a SearchOutcome as the text the agent reads. */
export function formatSearchOutcome(opts: SearchOptions, outcome: SearchOutcome): string {
  if (outcome.error) return `Search failed: ${outcome.error}`;

  const mode: SearchMode = opts.mode ?? 'content';
  const target = opts.target ?? 'content';
  const what = target === 'filenames' ? 'file paths' : target === 'both' ? 'file paths and contents' : 'file contents';
  const how = opts.regex || opts.multiline ? 'regex' : 'literal';

  if (outcome.totalHits === 0) {
    return (
      `No matches for ${how} "${opts.query}" in ${what} (scanned ${outcome.filesScanned} files in ${outcome.elapsedMs ?? 0}ms).\n\n` +
      diagnoseEmptySearch(opts, outcome)
    );
  }

  const header =
    `${outcome.totalHits} match${outcome.totalHits === 1 ? '' : 'es'} in ${outcome.files.length} file${outcome.files.length === 1 ? '' : 's'} ` +
    `(${how} "${opts.query}" in ${what}, scanned ${outcome.filesScanned} files in ${outcome.elapsedMs ?? 0}ms)`;

  if (mode === 'files' || target === 'filenames') {
    const limit = opts.maxResults ?? 60;
    const shown = outcome.files.slice(0, limit);
    return [
      header,
      '',
      ...shown.map((f) => `  ${f}`),
      ...(outcome.files.length > shown.length ? [`  … and ${outcome.files.length - shown.length} more`] : []),
    ].join('\n');
  }

  if (mode === 'count') {
    const counts = (outcome.counts ?? []).slice().sort((a, b) => b.count - a.count);
    return [header, '', ...counts.map((c) => `  ${String(c.count).padStart(4)}  ${c.file}`)].join('\n');
  }

  // Grouped by file — the shape of the answer, not just a list of lines.
  const byFile = new Map<string, SearchHit[]>();
  for (const h of outcome.hits) {
    const list = byFile.get(h.file);
    if (list) list.push(h); else byFile.set(h.file, [h]);
  }

  const blocks: string[] = [];
  for (const [file, fileHits] of byFile) {
    const total = outcome.counts?.find((c) => c.file === file)?.count ?? fileHits.length;
    const extra = total > fileHits.length ? ` (showing ${fileHits.length} of ${total})` : '';
    const lines = [`${file}${extra}`];
    for (const h of fileHits) {
      if (h.context) {
        for (const c of h.context) {
          lines.push(`  ${String(c.line).padStart(5)}${c.line === h.line ? ' >' : '  '} ${c.text}`);
        }
        lines.push('  ---');
      } else {
        lines.push(`  ${String(h.line).padStart(5)}: ${h.text.trim()}`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  const notes: string[] = [];
  if (outcome.truncated && !outcome.timedOut) {
    notes.push(
      `TRUNCATED: ${outcome.totalHits} matches exist but only ${outcome.hits.length} are shown. ` +
      `Do NOT assume you have seen them all — narrow it with include/exclude or a more specific query, ` +
      `or run mode:"count" first to see where they are concentrated.`,
    );
  }
  if (outcome.timedOut) {
    notes.push(
      `STOPPED EARLY: the search hit its time/file budget, so results are PARTIAL. ` +
      `Narrow it with search_path or include and run it again before concluding anything.`,
    );
  }

  return `${header}\n\n${blocks.join('\n\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
}
