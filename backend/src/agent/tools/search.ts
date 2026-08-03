/**
 * Search — one tool for finding things by text.
 *
 * WHY ONE TOOL AND NOT THREE
 *
 * There used to be `search_in_files` (literal, no options), `grep_search`
 * (regex, globs, context) and `find_files` (fuzzy filename). Three tools whose
 * descriptions all began "search for…", differing in ways a model has to
 * remember rather than discover. The observable result was that models picked
 * whichever name came to mind, most often the weakest one: `search_in_files`
 * has no include filter and no context lines, so a search for a symbol in a
 * TypeScript project returned a hundred untargeted lines with the interesting
 * one buried, and the next move was another search rather than a read.
 *
 * One tool with explicit switches removes the guess. `regex` is a flag rather
 * than a different tool, `target` chooses content or filenames, and `mode`
 * chooses how much to return.
 *
 * WHAT MAKES THE RESULT USEFUL RATHER THAN MERELY CORRECT
 *
 *  - Results are GROUPED BY FILE. A flat list of `path:line` repeats the same
 *    long path for every hit and buries the shape of the answer ("it's all in
 *    one module" vs "it's scattered across twelve").
 *  - The output is BUDGETED, and says what it dropped. A truncated list that
 *    doesn't admit truncation is actively misleading: the agent concludes it
 *    has seen every call site and changes a signature.
 *  - Zero results come with a DIAGNOSIS. "No matches" is a dead end; "no
 *    matches — nothing was even scanned, your include glob matched no files,
 *    and a nested file needs the leading star-star" is a next step.
 *  - Case sensitivity is SMART by default: a lowercase query is
 *    case-insensitive, a query containing an uppercase letter is sensitive.
 *    That is what a developer means when they type `useState` vs `usestate`.
 */

import fs from 'fs';
import path from 'path';
import { resolveSafePath } from './filesystem';
import { logger } from '../../utils/logger';

export type SearchTarget = 'content' | 'filenames';
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
  include?: string;
  exclude?: string;
  contextLines?: number;
  maxResults?: number;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
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
  error?: string;
  /** Per-file counts, for mode 'count'. */
  counts?: Array<{ file: string; count: number }>;
}

const DEFAULT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
]);

/** Files above this are almost certainly generated; scanning them is a waste. */
const MAX_FILE_BYTES = 2_000_000;

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']']);

/**
 * Minimal but correct glob to RegExp.
 *
 * Written as a single left-to-right scan rather than a chain of replaces. The
 * chain version needed placeholder characters to stop the single-star rule
 * eating half of a double star, and those placeholders had to be invisible
 * control codes — unreviewable in a diff and easy to mangle in transit. A scan
 * needs no placeholders because it consumes a double star as one token.
 *
 * The subtlety that actually matters: a leading double-star followed by a slash
 * must match ZERO or more directories, so a pattern written for nested files
 * still matches a top-level one.
 * Getting that wrong produces the most confusing possible failure — a search
 * that silently skips the very file the user was looking at.
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

  try { return new RegExp(`^${out}$`); } catch { return null; }
}

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
  const flags = sensitive ? '' : 'i';

  let source = opts.regex ? opts.query : escapeRegExp(opts.query);
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

/** Is this file worth reading as text? */
function isTextFile(full: string): boolean {
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
  } catch { return false; }
  return true;
}

/** A NUL byte anywhere in the first chunk means "not text". */
function looksBinary(content: string): boolean {
  return content.indexOf(String.fromCharCode(0)) !== -1;
}

export function runSearch(workspacePath: string, opts: SearchOptions): SearchOutcome {
  const target: SearchTarget = opts.target ?? 'content';
  const mode: SearchMode = opts.mode ?? 'content';
  const maxResults = Math.min(Math.max(opts.maxResults ?? 60, 1), 500);
  const ctx = Math.min(Math.max(opts.contextLines ?? 0, 0), 5);

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

  const includeRe = opts.include ? globToRegExp(opts.include) : null;
  const excludeRe = opts.exclude ? globToRegExp(opts.exclude) : null;

  const hits: SearchHit[] = [];
  const fileOrder: string[] = [];
  const perFile = new Map<string, number>();
  let totalHits = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let stop = false;

  const noteHit = (rel: string) => {
    if (!perFile.has(rel)) { perFile.set(rel, 0); fileOrder.push(rel); }
    perFile.set(rel, perFile.get(rel)! + 1);
    totalHits++;
  };

  const walk = (dir: string): void => {
    if (stop) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (stop) return;

      if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        // Hidden directories are skipped, but `.bubbly` is allowed through so a
        // search can find a spec — those are project documents, not machine state.
        if (entry.name.startsWith('.') && entry.name !== '.bubbly' && entry.name !== '.github') continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, '/');
      if (includeRe && !includeRe.test(rel)) continue;
      if (excludeRe && excludeRe.test(rel)) continue;

      if (target === 'filenames') {
        filesScanned++;
        if (re.test(rel)) {
          noteHit(rel);
          if (fileOrder.length >= maxResults) { stop = true; return; }
        }
        continue;
      }

      if (!isTextFile(full)) { filesSkipped++; continue; }
      let content: string;
      try { content = fs.readFileSync(full, 'utf8'); } catch { filesSkipped++; continue; }
      if (looksBinary(content)) { filesSkipped++; continue; }
      filesScanned++;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        noteHit(rel);

        if (mode === 'content' && hits.length < maxResults) {
          const hit: SearchHit = { file: rel, line: i + 1, text: lines[i].slice(0, 400) };
          if (ctx > 0) {
            const from = Math.max(0, i - ctx);
            const to = Math.min(lines.length, i + ctx + 1);
            hit.context = lines.slice(from, to).map((text, k) => ({ line: from + k + 1, text: text.slice(0, 300) }));
          }
          hits.push(hit);
        }
        // Keep counting past the display cap so the reported total is honest,
        // but stop entirely once counting itself becomes absurd.
        if (totalHits > maxResults * 20) { stop = true; break; }
      }
    }
  };

  walk(root);

  const shownCount = target === 'filenames' || mode !== 'content' ? fileOrder.length : hits.length;
  const truncated = mode === 'content' && target === 'content'
    ? totalHits > hits.length
    : stop;
  const counts = fileOrder.map((f) => ({ file: f, count: perFile.get(f) ?? 0 }));

  logger.debug('Search complete', {
    query: opts.query, target, mode, filesScanned, totalHits, shownCount, truncated,
  });

  return { hits, files: fileOrder, totalHits, filesScanned, filesSkipped, truncated, counts };
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

  // An include glob is the most common reason a search comes back empty when
  // the text is definitely in the project, so it is called out whenever one is
  // set — not only when it matched nothing at all. A glob that matched two
  // files and missed the one you wanted looks like a successful search with no
  // results, which is the most misleading outcome available.
  if (opts.include) {
    notes.push(
      outcome.filesScanned === 0
        ? `Nothing was even scanned: the include glob "${opts.include}" matched no files.`
        : `Only ${outcome.filesScanned} file(s) matched the include glob "${opts.include}" — the text may well be in a file the glob excluded.`
    );
    notes.push(
      `Globs match the WHOLE path from the workspace root, and a single "*" never crosses a "/". ` +
      `So "src/*.ts" reaches src/app.ts but not src/deep/nested.ts; use a leading "**/" (e.g. "**/*.ts") to search at any depth. ` +
      `Try again without the include glob if you are not sure where the file lives.`
    );
  }

  if (outcome.filesScanned === 0 && !opts.include) {
    if (opts.searchPath && opts.searchPath !== '.') {
      notes.push(`Nothing was scanned under "${opts.searchPath}" — check that directory exists and is not one of the skipped ones (node_modules, dist, .git…).`);
    } else {
      notes.push('Nothing was scanned. The workspace may be empty, or everything in it is excluded (node_modules, dist, .git…).');
    }
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

  if (opts.target !== 'filenames') {
    notes.push('If you are looking for a FILE rather than for text inside one, use target:"filenames".');
  }

  notes.push('For a code symbol, find_symbol / find_references understand declarations and call sites and are usually a better move than text search.');

  return notes.join('\n');
}

/** Render a SearchOutcome as the text the agent reads. */
export function formatSearchOutcome(opts: SearchOptions, outcome: SearchOutcome): string {
  if (outcome.error) return `Search failed: ${outcome.error}`;

  const mode: SearchMode = opts.mode ?? 'content';
  const what = opts.target === 'filenames' ? 'file paths' : 'file contents';
  const how = opts.regex ? 'regex' : 'literal';

  if (outcome.totalHits === 0) {
    return (
      `No matches for ${how} "${opts.query}" in ${what} (scanned ${outcome.filesScanned} files).\n\n` +
      diagnoseEmptySearch(opts, outcome)
    );
  }

  const header =
    `${outcome.totalHits} match${outcome.totalHits === 1 ? '' : 'es'} in ${outcome.files.length} file${outcome.files.length === 1 ? '' : 's'} ` +
    `(${how} "${opts.query}" in ${what}, scanned ${outcome.filesScanned} files)`;

  if (mode === 'files' || opts.target === 'filenames') {
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

  const footer = outcome.truncated
    ? `\n\nTRUNCATED: ${outcome.totalHits} matches exist but only ${outcome.hits.length} are shown. ` +
      `Do NOT assume you have seen them all — narrow it with include/exclude or a more specific query, ` +
      `or run mode:"count" first to see where they are concentrated.`
    : '';

  return `${header}\n\n${blocks.join('\n\n')}${footer}`;
}
