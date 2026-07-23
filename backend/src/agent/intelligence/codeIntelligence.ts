/**
 * Code Intelligence Engine — Bubbly's "structural brain".
 *
 * This is the system that makes small models (Granite, llama, qwen) perform at
 * a high level. Per dream.md: the breakthrough is NOT model size, it is CONTEXT
 * NARROWING. We build several maps of the codebase up front:
 *
 *   1. Structural map   — every file's symbols (functions/classes/types)
 *   2. Symbol index     — name → declarations (find_symbol)
 *   3. Reference graph  — symbol → files that reference it (find_references)
 *   4. Import graph      — file → files it depends on (+ reverse edges)
 *   5. Centrality (PageRank-style) — which files are most important
 *
 * From those we produce a compressed REPO MAP: a ranked, token-budgeted outline
 * of the most relevant files and their key signatures, optionally focused on a
 * task. The model navigates by structure instead of reading whole files.
 *
 * The index is cached per workspace and incrementally refreshed by mtime so it
 * stays fast on large repos.
 */

import fs from 'fs';
import path from 'path';
import { getProjectDataPath } from '../projectData';
import { logger } from '../../utils/logger';
import {
  extractSymbols,
  detectLanguage,
  type FileSymbols,
  type CodeSymbol,
  type SupportedLanguage,
} from './symbols';

export interface IndexedFile extends FileSymbols {
  fullPath: string;
  size: number;
  mtimeMs: number;
  /** Resolved workspace-relative paths this file imports. */
  resolvedDeps: string[];
  /** Centrality score in [0,1] after ranking. */
  rank: number;
}

export interface WorkspaceIndex {
  workspacePath: string;
  files: Map<string, IndexedFile>;
  /** symbol name (lowercased) → list of {path, symbol}. */
  symbolIndex: Map<string, Array<{ path: string; symbol: CodeSymbol }>>;
  builtAt: number;
  fileCount: number;
}

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  'out', 'target', '__pycache__', '.pytest_cache', '.venv', 'venv',
  '.bubbly', '.cache', 'vendor', '.idea', '.vscode',
];

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php',
]);

const MAX_FILE_SIZE = 1_500_000; // skip very large files for indexing

function shouldExclude(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return DEFAULT_EXCLUDES.some((p) => norm === p || norm.startsWith(p + '/') || norm.includes('/' + p + '/'));
}

// --- index cache (per workspace) -------------------------------------------

const indexCache = new Map<string, WorkspaceIndex>();

export function invalidateIndex(workspacePath: string): void {
  indexCache.delete(path.resolve(workspacePath));
}

// --- persistent cache -------------------------------------------------------
//
// The in-memory cache above dies with the process, so every restart used to
// re-read and re-parse every file in the workspace. We now persist the per-file
// analysis to disk and reload it on a cold start; the existing mtime/size check
// in buildIndex then reuses everything that hasn't changed, so a restart on an
// unchanged tree costs a directory walk instead of a full re-parse.
//
// Only the per-file analysis is stored. `symbolIndex`, `resolvedDeps` and `rank`
// are all derived and are recomputed on every build, so persisting them would
// just be a staleness risk.

/** Bump when IndexedFile/FileSymbols or the extractor's output shape changes,
 *  so stale caches from an older Bubbly are ignored rather than trusted. */
const INDEX_CACHE_VERSION = 1;

interface PersistedIndex {
  version: number;
  workspacePath: string;
  builtAt: number;
  /** [relPath, per-file analysis] pairs (Maps don't survive JSON). */
  files: Array<[string, Omit<IndexedFile, 'resolvedDeps' | 'rank'>]>;
}

function cacheFilePath(abs: string): string {
  // The index now lives OUTSIDE the project (see projectData), so a huge
  // generated index never pollutes the workspace or blocks clean-slate tools.
  return getProjectDataPath(abs, 'code-index.json');
}

/** Load a previously persisted index, or null if absent/stale/unreadable. */
function loadPersistedIndex(abs: string): Map<string, IndexedFile> | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(abs), 'utf8');
    const parsed = JSON.parse(raw) as PersistedIndex;
    if (parsed.version !== INDEX_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.files)) return null;
    const files = new Map<string, IndexedFile>();
    for (const [rel, f] of parsed.files) {
      files.set(rel, { ...f, resolvedDeps: [], rank: 0 });
    }
    return files;
  } catch {
    // Missing, corrupt, or unreadable — just rebuild from scratch.
    return null;
  }
}

/** Write the index to disk. Best-effort: a failure here must never break a run. */
function persistIndex(index: WorkspaceIndex): void {
  const file = cacheFilePath(index.workspacePath);
  const payload: PersistedIndex = {
    version: INDEX_CACHE_VERSION,
    workspacePath: index.workspacePath,
    builtAt: index.builtAt,
    files: Array.from(index.files.entries()).map(([rel, f]) => {
      // Drop the derived fields; keep the expensive parse output.
      const { resolvedDeps: _d, rank: _r, ...rest } = f;
      return [rel, rest];
    }),
  };
  // Serialize off the hot path so a large workspace doesn't stall the caller.
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a corrupt cache.
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      logger.debug?.('Could not persist code index', {
        workspacePath: index.workspacePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// --- file discovery ---------------------------------------------------------

function discoverCodeFiles(workspacePath: string): Array<{ rel: string; full: string; size: number; mtimeMs: number }> {
  const out: Array<{ rel: string; full: string; size: number; mtimeMs: number }> = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, '/');
      if (shouldExclude(rel)) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
        try {
          const st = fs.statSync(full);
          if (st.size <= MAX_FILE_SIZE) {
            out.push({ rel, full, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  walk(workspacePath);
  return out;
}

// --- import resolution -------------------------------------------------------

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php'];

/**
 * Resolve an import specifier to a workspace-relative file path, if it points
 * to a local file. External packages return null.
 */
function resolveImport(
  specifier: string,
  fromRel: string,
  language: SupportedLanguage,
  fileSet: Set<string>
): string | null {
  // Local relative imports only (JS/TS/Python style).
  const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
  if (!isRelative && language !== 'python') return null;

  const fromDir = path.dirname(fromRel);

  const candidates: string[] = [];

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = specifier.startsWith('/')
      ? specifier.slice(1)
      : path.join(fromDir, specifier).replace(/\\/g, '/');
    for (const ext of RESOLVE_EXTS) candidates.push(base + ext);
    for (const ext of RESOLVE_EXTS) candidates.push(path.join(base, 'index' + ext).replace(/\\/g, '/'));
    candidates.push(path.join(base, '__init__.py').replace(/\\/g, '/'));
  } else if (language === 'python') {
    // Dotted module path → try relative to workspace root.
    const dotted = specifier.replace(/\./g, '/');
    candidates.push(dotted + '.py');
    candidates.push(path.join(dotted, '__init__.py').replace(/\\/g, '/'));
  }

  for (const c of candidates) {
    const norm = c.replace(/\\/g, '/').replace(/^\.\//, '');
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

// --- index build -------------------------------------------------------------

/**
 * Build (or incrementally refresh) the workspace index. Cheap to call: it reuses
 * cached per-file analysis when the file's mtime/size are unchanged.
 */
export function buildIndex(workspacePath: string): WorkspaceIndex {
  const abs = path.resolve(workspacePath);
  const t0 = Date.now();
  const discovered = discoverCodeFiles(abs);
  const fileSet = new Set(discovered.map((d) => d.rel));

  // On a cold start (nothing in memory) fall back to the on-disk cache so a
  // restart doesn't re-parse an unchanged tree.
  const memPrev = indexCache.get(abs);
  const prevFiles: Map<string, IndexedFile> | undefined =
    memPrev?.files ?? loadPersistedIndex(abs) ?? undefined;
  const fromDisk = !memPrev && !!prevFiles;
  const files = new Map<string, IndexedFile>();

  let reused = 0;
  for (const d of discovered) {
    const cached = prevFiles?.get(d.rel);
    if (cached && cached.mtimeMs === d.mtimeMs && cached.size === d.size) {
      // Always take the freshly discovered absolute path — a persisted one is
      // stale if the workspace folder was moved or renamed.
      files.set(d.rel, { ...cached, fullPath: d.full, resolvedDeps: [], rank: 0 });
      reused++;
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(d.full, 'utf8');
    } catch {
      continue;
    }
    const fileSymbols = extractSymbols(d.rel, content);
    files.set(d.rel, {
      ...fileSymbols,
      fullPath: d.full,
      size: d.size,
      mtimeMs: d.mtimeMs,
      resolvedDeps: [],
      rank: 0,
    });
  }

  // Resolve import edges now that we know the full file set.
  for (const f of files.values()) {
    const deps = new Set<string>();
    for (const imp of f.imports) {
      const resolved = resolveImport(imp.specifier, f.path, f.language, fileSet);
      if (resolved && resolved !== f.path) deps.add(resolved);
    }
    f.resolvedDeps = Array.from(deps);
  }

  // Build symbol index.
  const symbolIndex = new Map<string, Array<{ path: string; symbol: CodeSymbol }>>();
  for (const f of files.values()) {
    for (const sym of f.symbols) {
      const key = sym.name.toLowerCase();
      if (!symbolIndex.has(key)) symbolIndex.set(key, []);
      symbolIndex.get(key)!.push({ path: f.path, symbol: sym });
    }
  }

  // Rank files by centrality (PageRank-style on the import graph).
  rankFiles(files);

  const index: WorkspaceIndex = {
    workspacePath: abs,
    files,
    symbolIndex,
    builtAt: Date.now(),
    fileCount: files.size,
  };
  indexCache.set(abs, index);

  // Persist only when the on-disk copy would actually change: something was
  // re-parsed, a file disappeared, or we had no cache to begin with. Otherwise
  // a steady-state workspace would rewrite an identical file on every build.
  const allReused = reused === discovered.length && prevFiles?.size === files.size;
  if (!allReused || !prevFiles) {
    persistIndex(index);
  }

  logger.info('Code index built', {
    workspacePath: abs,
    files: files.size,
    reused,
    fromDiskCache: fromDisk,
    symbols: symbolIndex.size,
    durationMs: Date.now() - t0,
  });

  return index;
}

/** Get a cached index or build one. */
export function getIndex(workspacePath: string, forceRebuild = false): WorkspaceIndex {
  const abs = path.resolve(workspacePath);
  if (!forceRebuild) {
    const cached = indexCache.get(abs);
    if (cached && Date.now() - cached.builtAt < 30_000) return cached;
  }
  return buildIndex(abs);
}

// --- ranking (PageRank-style) ------------------------------------------------

/**
 * Assign each file a centrality rank in [0,1]. Files imported by many others
 * (and by important others) score higher. This mirrors how Aider/Cursor decide
 * what belongs in the repo map.
 */
function rankFiles(files: Map<string, IndexedFile>): void {
  const ids = Array.from(files.keys());
  const n = ids.length;
  if (n === 0) return;

  // Reverse edges: who imports me.
  const incoming = new Map<string, string[]>();
  for (const id of ids) incoming.set(id, []);
  for (const f of files.values()) {
    for (const dep of f.resolvedDeps) {
      if (incoming.has(dep)) incoming.get(dep)!.push(f.path);
    }
  }

  const damping = 0.85;
  let rank = new Map<string, number>();
  for (const id of ids) rank.set(id, 1 / n);

  for (let iter = 0; iter < 20; iter++) {
    const next = new Map<string, number>();
    for (const id of ids) next.set(id, (1 - damping) / n);
    for (const f of files.values()) {
      const outDeps = f.resolvedDeps.filter((d) => files.has(d));
      if (outDeps.length === 0) continue;
      const share = (damping * (rank.get(f.path) ?? 0)) / outDeps.length;
      for (const dep of outDeps) next.set(dep, (next.get(dep) ?? 0) + share);
    }
    rank = next;
  }

  // Normalize to [0,1].
  let max = 0;
  for (const v of rank.values()) max = Math.max(max, v);
  if (max === 0) max = 1;
  for (const f of files.values()) {
    f.rank = (rank.get(f.path) ?? 0) / max;
  }
}

// --- symbol lookups ----------------------------------------------------------

export interface SymbolHit {
  path: string;
  name: string;
  kind: string;
  line: number;
  signature: string;
  container?: string;
}

/** Find declarations of a symbol by exact (case-insensitive) name. */
export function findSymbol(workspacePath: string, name: string): SymbolHit[] {
  const index = getIndex(workspacePath);
  const hits = index.symbolIndex.get(name.toLowerCase()) ?? [];
  return hits.map((h) => ({
    path: h.path,
    name: h.symbol.name,
    kind: h.symbol.kind,
    line: h.symbol.line,
    signature: h.symbol.signature,
    container: h.symbol.container,
  }));
}

/** Fuzzy symbol search (substring) for when the model isn't sure of the name. */
export function searchSymbols(workspacePath: string, query: string, limit = 25): SymbolHit[] {
  const index = getIndex(workspacePath);
  const q = query.toLowerCase();
  const hits: SymbolHit[] = [];
  for (const [key, arr] of index.symbolIndex) {
    if (key.includes(q)) {
      for (const h of arr) {
        hits.push({
          path: h.path,
          name: h.symbol.name,
          kind: h.symbol.kind,
          line: h.symbol.line,
          signature: h.symbol.signature,
          container: h.symbol.container,
        });
      }
    }
  }
  // Prefer exact-prefix matches and higher-ranked files.
  const index2 = index;
  hits.sort((a, b) => {
    const aExact = a.name.toLowerCase() === q ? 1 : 0;
    const bExact = b.name.toLowerCase() === q ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const ra = index2.files.get(a.path)?.rank ?? 0;
    const rb = index2.files.get(b.path)?.rank ?? 0;
    return rb - ra;
  });
  return hits.slice(0, limit);
}

export interface ReferenceHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Find files/lines that reference a symbol by name (word-boundary match),
 * excluding the declaration lines. This is a pragmatic, fast textual reference
 * finder over indexed code files.
 */
export function findReferences(workspacePath: string, name: string, limit = 60): ReferenceHit[] {
  const index = getIndex(workspacePath);
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const declLines = new Set<string>();
  for (const hit of index.symbolIndex.get(name.toLowerCase()) ?? []) {
    declLines.add(`${hit.path}:${hit.symbol.line}`);
  }

  const out: ReferenceHit[] = [];
  for (const f of index.files.values()) {
    let content: string;
    try {
      content = fs.readFileSync(f.fullPath, 'utf8');
    } catch {
      continue;
    }
    if (!re.test(content)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const key = `${f.path}:${i + 1}`;
        if (declLines.has(key)) continue;
        out.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** Outline of a single file: its symbols with signatures and lines. */
export function getFileOutline(workspacePath: string, relPath: string): IndexedFile | null {
  const index = getIndex(workspacePath);
  return index.files.get(relPath.replace(/\\/g, '/')) ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- repo map (compressed structural overview) ------------------------------

export interface RepoMapOptions {
  /** Optional task/query to bias relevance toward. */
  focus?: string;
  /** Approximate token budget for the map (chars ≈ tokens*4). */
  tokenBudget?: number;
  /** Max number of files to include. */
  maxFiles?: number;
}

/**
 * Produce a compressed, ranked repo map: the most important/relevant files and
 * their key symbol signatures, within a token budget. This is the single most
 * valuable context artifact for a weak model.
 */
export function buildRepoMap(workspacePath: string, opts: RepoMapOptions = {}): string {
  const index = getIndex(workspacePath);
  const tokenBudget = opts.tokenBudget ?? 1800;
  const charBudget = tokenBudget * 4;
  const maxFiles = opts.maxFiles ?? 40;

  const focusTerms = opts.focus
    ? Array.from(new Set(opts.focus.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2)))
    : [];

  // Score files: centrality + focus keyword overlap + having exported symbols.
  const scored = Array.from(index.files.values())
    .filter((f) => f.symbols.length > 0)
    .map((f) => {
      let score = f.rank * 10;
      const exportedCount = f.symbols.filter((s) => s.exported).length;
      score += Math.min(exportedCount, 8) * 0.4;

      if (focusTerms.length > 0) {
        const hay = (f.path + ' ' + f.symbols.map((s) => s.name).join(' ')).toLowerCase();
        for (const term of focusTerms) {
          if (f.path.toLowerCase().includes(term)) score += 6;
          else if (hay.includes(term)) score += 3;
        }
      }
      return { file: f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  const lines: string[] = [];
  lines.push('# Repository Map');
  lines.push(`Project type: ${detectProjectTypeFromIndex(index)} · ${index.fileCount} code files indexed`);
  if (opts.focus) lines.push(`Focused on: "${opts.focus.slice(0, 100)}"`);
  lines.push('');

  let used = lines.join('\n').length;

  for (const { file } of scored) {
    // Show exported/public symbols first; fall back to all if none exported.
    const exported = file.symbols.filter((s) => s.exported);
    const shown = (exported.length > 0 ? exported : file.symbols).slice(0, 12);

    const header = `\n## ${file.path}${file.rank > 0.5 ? '  ★' : ''}`;
    const symLines = shown.map((s) => {
      const prefix = s.container ? `  ${s.kind} ${s.container}.${s.name}` : `  ${s.kind} ${s.name}`;
      return `${prefix} — ${s.signature}`.slice(0, 200);
    });
    const block = [header, ...symLines].join('\n');

    if (used + block.length > charBudget) break;
    lines.push(block);
    used += block.length;
  }

  return lines.join('\n');
}

function detectProjectTypeFromIndex(index: WorkspaceIndex): string {
  const langs = new Map<SupportedLanguage, number>();
  for (const f of index.files.values()) {
    langs.set(f.language, (langs.get(f.language) ?? 0) + 1);
  }
  let top: SupportedLanguage = 'other';
  let max = 0;
  for (const [lang, count] of langs) {
    if (count > max && lang !== 'other') {
      max = count;
      top = lang;
    }
  }
  return top;
}

/**
 * Build focused context for a single task: the repo map biased to the task plus
 * the full outlines of the files most likely to be touched. Designed to be the
 * "working memory package" the dream describes — everything a weak model needs,
 * nothing it doesn't.
 */
export function buildTaskContext(
  workspacePath: string,
  taskDescription: string,
  opts: { tokenBudget?: number; maxFocusFiles?: number } = {}
): { repoMap: string; focusFiles: Array<{ path: string; outline: string; rank: number }> } {
  const index = getIndex(workspacePath);
  const repoMap = buildRepoMap(workspacePath, { focus: taskDescription, tokenBudget: opts.tokenBudget ?? 1400 });

  const focusTerms = taskDescription.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const maxFocusFiles = opts.maxFocusFiles ?? 4;

  const ranked = Array.from(index.files.values())
    .map((f) => {
      let score = f.rank * 4;
      const hay = (f.path + ' ' + f.symbols.map((s) => s.name).join(' ')).toLowerCase();
      for (const term of focusTerms) {
        if (f.path.toLowerCase().includes(term)) score += 5;
        else if (hay.includes(term)) score += 2;
      }
      return { f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFocusFiles);

  const focusFiles = ranked.map(({ f }) => ({
    path: f.path,
    rank: f.rank,
    outline: f.symbols
      .slice(0, 30)
      .map((s) => `  L${s.line} ${s.kind} ${s.container ? s.container + '.' : ''}${s.name} — ${s.signature}`)
      .join('\n'),
  }));

  return { repoMap, focusFiles };
}
