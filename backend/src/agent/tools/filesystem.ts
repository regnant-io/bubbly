import fs from 'fs';
import path from 'path';
import { createPatch } from 'diff';
import type { FileDiff } from '../../types';
import { logger } from '../../utils/logger';
import {
  verifyFileWrite,
  verifyFileDeleted,
  detectFileType,
  validateFileSize
} from '../../utils/fileVerifier';
import { getProjectDataDir } from '../projectData';
import { recordAgentWrite, forgetFile } from '../fileDrift';

export function resolveSafePath(workspacePath: string, filePath: string): string {
  if (filePath == null || typeof filePath !== 'string') {
    throw new Error(`Invalid path: expected a string, got ${filePath === null ? 'null' : typeof filePath}.`);
  }
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, filePath);

  // Use path.relative rather than a string prefix check. A prefix check
  // (`resolved.startsWith(root)`) is unsafe: a SIBLING like "<root>-evil"
  // starts with "<root>" yet lives outside the workspace. relative() gives ""
  // for the root itself and a "../"-leading path for anything outside it.
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escape detected: ${filePath} is outside the workspace.`);
  }

  // Transparent `.bubbly/…` redirect. The agent still addresses its private
  // state as ".bubbly/specs/…" (its whole mental model, and the system prompt,
  // are unchanged), but the bytes are routed to the project's EXTERNAL data dir
  // so nothing is ever written inside the workspace — which is what keeps a
  // clean-slate scaffold (`npm create vite .`) from failing on a stray folder.
  // Every file tool funnels through here, so read/write/edit/list all agree on
  // the same real location. The escape check above already ran on the
  // workspace-relative form, so `rel` cannot climb out of the project first.
  const relPosix = rel.replace(/\\/g, '/');
  if (relPosix === '.bubbly' || relPosix.startsWith('.bubbly/')) {
    const sub = relPosix.slice('.bubbly'.length).replace(/^\//, '');
    // SPECS ARE THE EXCEPTION and stay in the project. They are documents about
    // the code, written for a human to read and review, so they belong next to
    // it — browsable in the explorer, diffable in git, committable with the
    // change they describe. Everything else (checkpoints, artifacts, the run
    // config, the index) is machine state with no business in the repo, and is
    // what the redirect was actually protecting scaffolds from.
    if (sub === 'specs' || sub.startsWith('specs/')) return resolved;
    const dataDir = getProjectDataDir(root);
    return sub ? path.join(dataDir, sub) : dataDir;
  }

  return resolved;
}

/**
 * Detect the dominant line ending of an existing text file's content.
 * Returns '\r\n' if CRLF is dominant, otherwise '\n'.
 */
function detectEol(content: string): '\r\n' | '\n' {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Normalize a new string to a target line ending so an edit/write never
 * introduces mixed EOLs into a file (a common "corruption"/noisy-diff cause,
 * especially on Windows where source files are often CRLF).
 */
function normalizeEol(text: string, eol: '\r\n' | '\n'): string {
  // First collapse everything to LF, then expand to the target.
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

export async function readFile(workspacePath: string, filePath: string): Promise<string> {
  const fullPath = resolveSafePath(workspacePath, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Reject directories with a clear, actionable error. Reading a directory as a
  // file throws EISDIR deep inside fs and previously leaked file handles; tell
  // the agent to list it instead.
  if (fs.statSync(fullPath).isDirectory()) {
    throw new Error(`"${filePath}" is a directory, not a file. Use list_directory or get_file_tree to see its contents.`);
  }
  
  logger.debug('Reading file', { path: filePath });
  
  // Detect file type before reading
  const fileType = await detectFileType(fullPath);
  
  if (fileType.type === 'binary') {
    logger.warn('Attempted to read binary file as text', { 
      path: filePath, 
      mimeType: fileType.mimeType 
    });
    throw new Error(
      `Cannot read binary file as text: ${filePath}` +
      (fileType.mimeType ? ` (detected as ${fileType.mimeType})` : '')
    );
  }
  
  const stat = fs.statSync(fullPath);
  
  // Validate file size for large file operations
  const sizeValidation = await validateFileSize(fullPath, { 
    maxSize: 10 * 1024 * 1024 // 10MB max for full read
  });
  
  if (!sizeValidation.valid) {
    logger.warn('File size exceeds maximum for full read', { 
      path: filePath, 
      size: sizeValidation.actualSize,
      error: sizeValidation.error 
    });
  }
  
  if (stat.size > 500_000) {
    // Read first 500KB for large files. CRITICAL: this is a PARTIAL view. We
    // make that unmistakable so a model never writes the truncated content
    // back (which would silently destroy the rest of the file). The previous
    // behavior appended a bare marker that could be round-tripped into a
    // write_file call and corrupt the file.
    logger.info('Reading large file (truncated)', {
      path: filePath,
      size: stat.size,
      truncatedAt: 500_000,
    });
    const buf = Buffer.alloc(500_000);
    const fd = fs.openSync(fullPath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 500_000, 0);
    fs.closeSync(fd);
    const partial = buf.slice(0, bytesRead).toString('utf8');
    const header =
      `⚠️ PARTIAL FILE VIEW — "${filePath}" is ${(stat.size / 1024).toFixed(0)} KB; ` +
      `only the first 500 KB is shown below. This is NOT the complete file.\n` +
      `Do NOT write this content back with write_file — you would destroy the rest of the file. ` +
      `To see more, call read_file with start_line/end_line. To change it, use edit_file on a specific unique snippet.\n` +
      `----- BEGIN PARTIAL CONTENT -----\n`;
    return header + partial + `\n----- END PARTIAL CONTENT (truncated; file continues) -----`;
  }
  
  logger.info('File read successfully', { path: filePath, size: stat.size });
  return fs.readFileSync(fullPath, 'utf8');
}

export async function writeFile(
  workspacePath: string,
  filePath: string,
  content: string
): Promise<{ success: boolean; diff: FileDiff }> {
  const fullPath = resolveSafePath(workspacePath, filePath);
  const dir = path.dirname(fullPath);
  
  logger.debug('Writing file', { path: filePath, size: content.length });

  // Validate file size before writing
  const contentSize = Buffer.byteLength(content, 'utf8');
  if (contentSize > 10 * 1024 * 1024) { // 10MB warning threshold
    logger.warn('Writing large file', { 
      path: filePath, 
      size: contentSize,
      sizeMB: (contentSize / (1024 * 1024)).toFixed(2)
    });
  }
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existed = fs.existsSync(fullPath);
  const oldContent = existed ? fs.readFileSync(fullPath, 'utf8') : '';

  // If overwriting an existing file, preserve its dominant line ending so we
  // don't flip a CRLF file to LF (or vice-versa) and produce a noisy/"corrupt"
  // diff. New files keep the content's own endings.
  const contentToWrite = existed ? normalizeEol(content, detectEol(oldContent)) : content;

  // Atomic write via temp file
  const tmpPath = fullPath + '.bubbly_tmp';
  fs.writeFileSync(tmpPath, contentToWrite, 'utf8');
  fs.renameSync(tmpPath, fullPath);

  // Verify the write was successful using File Verifier
  logger.debug('Verifying file write operation', { path: filePath });
  const verification = await verifyFileWrite(fullPath, contentToWrite);
  
  if (!verification.success) {
    logger.error('File write verification failed', { 
      path: filePath, 
      attempts: verification.attempts,
      error: verification.error 
    });
    throw new Error(`File write failed verification after ${verification.attempts} attempts: ${verification.error}`);
  }

  logger.info('File written and verified successfully', { 
    path: filePath, 
    type: existed ? 'modified' : 'created',
    attempts: verification.attempts 
  });

  const patch = existed
    ? createPatch(filePath, oldContent, contentToWrite, 'before', 'after')
    : createPatch(filePath, '', contentToWrite, 'before', 'after');

  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;

  // Baseline what WE left here, so a later change by the user's own editor is
  // recognisable as theirs rather than silently overwritten. See fileDrift.
  recordAgentWrite(workspacePath, filePath, contentToWrite);

  return {
    success: true,
    diff: {
      path: filePath,
      type: existed ? 'modified' : 'created',
      diff: patch,
      additions,
      deletions,
    },
  };
}

/**
 * Edit a file by replacing a target string with a new string.
 *
 * Models often fail exact-match edits (whitespace, a stray space, tabs vs
 * spaces) and then fall back to rewriting the whole file. To stop that, this
 * tries progressively more forgiving strategies:
 *   1. exact unique match
 *   2. whitespace-normalized match (collapse runs of spaces/tabs)
 *   3. line-trimmed match (ignore leading/trailing whitespace per line)
 * If still ambiguous or not found, it returns a helpful error showing the
 * closest region so the model can correct the anchor — never a silent rewrite.
 */
export async function editFile(
  workspacePath: string,
  filePath: string,
  oldStr: string,
  newStr: string
): Promise<{ success: boolean; diff: FileDiff; message: string }> {
  const fullPath = resolveSafePath(workspacePath, filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}. Use write_file to create a new file.`);
  }

  logger.debug('Editing file', { path: filePath, oldLen: oldStr.length, newLen: newStr.length });

  const oldContent = fs.readFileSync(fullPath, 'utf8');
  const editedContent = applyForgivingEdit(oldContent, oldStr, newStr, filePath);

  // Preserve the file's dominant line ending so an edit never introduces mixed
  // CRLF/LF (a common cause of "corrupted"/noisy diffs, especially on Windows).
  const eol = detectEol(oldContent);
  const newContent = normalizeEol(editedContent, eol);

  // Atomic write via temp file
  const tmpPath = fullPath + '.bubbly_tmp';
  fs.writeFileSync(tmpPath, newContent, 'utf8');
  fs.renameSync(tmpPath, fullPath);

  // Verify the write was successful
  const verification = await verifyFileWrite(fullPath, newContent);
  if (!verification.success) {
    logger.error('File edit verification failed', { path: filePath, error: verification.error });
    throw new Error(`File edit failed verification: ${verification.error}`);
  }

  logger.info('File edited successfully', { path: filePath });
  recordAgentWrite(workspacePath, filePath, newContent);

  const patch = createPatch(filePath, oldContent, newContent, 'before', 'after');
  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;

  return {
    success: true,
    message: `File edited: ${filePath} (+${additions}/-${deletions})`,
    diff: {
      path: filePath,
      type: 'modified',
      diff: patch,
      additions,
      deletions,
    },
  };
}

function normalizeWs(s: string): string {
  // Collapse runs of horizontal whitespace and trim trailing spaces per line.
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+$/g, ''))
    .join('\n');
}

/** Apply an edit using progressively more forgiving matching. Throws on failure. */
function applyForgivingEdit(content: string, oldStr: string, newStr: string, filePath: string): string {
  if (oldStr === '') {
    throw new Error(`edit_file requires a non-empty old_str. To create a file use write_file.`);
  }

  // Strategy 1: exact match.
  const exactCount = content.split(oldStr).length - 1;
  if (exactCount === 1) {
    return content.replace(oldStr, () => newStr);
  }
  if (exactCount > 1) {
    throw new Error(
      `The text to replace appears ${exactCount} times in ${filePath}. ` +
      `Include more surrounding context (2-3 lines) so old_str is unique.`
    );
  }

  // Strategy 2: whitespace-normalized match over a sliding window of lines.
  const contentLines = content.split('\n');
  const oldLines = oldStr.split('\n');
  const normTarget = normalizeWs(oldStr).trim();

  const windowMatches: number[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    const windowText = contentLines.slice(i, i + oldLines.length).join('\n');
    if (normalizeWs(windowText).trim() === normTarget) {
      windowMatches.push(i);
    }
  }
  if (windowMatches.length === 1) {
    const i = windowMatches[0];
    const before = contentLines.slice(0, i).join('\n');
    const after = contentLines.slice(i + oldLines.length).join('\n');
    const joiner1 = i > 0 ? '\n' : '';
    const joiner2 = i + oldLines.length < contentLines.length ? '\n' : '';
    return before + joiner1 + newStr + joiner2 + after;
  }
  if (windowMatches.length > 1) {
    throw new Error(
      `The text to replace matches ${windowMatches.length} places in ${filePath} (ignoring whitespace). ` +
      `Add more unique surrounding context.`
    );
  }

  // Strategy 3: line-trimmed match (ignore per-line indentation entirely).
  const trimmedTarget = oldLines.map((l) => l.trim()).filter((l) => l.length > 0).join('\n');
  if (trimmedTarget.length > 0) {
    const trimMatches: number[] = [];
    for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
      const windowTrim = contentLines.slice(i, i + oldLines.length).map((l) => l.trim()).filter((l) => l.length > 0).join('\n');
      if (windowTrim === trimmedTarget) trimMatches.push(i);
    }
    if (trimMatches.length === 1) {
      const i = trimMatches[0];
      // Preserve the indentation of the first matched line for the replacement.
      const indentMatch = contentLines[i].match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0] : '';
      const reindentedNew = newStr.split('\n').map((l, idx) => (idx === 0 || l.length === 0 ? l : (l.startsWith(' ') || l.startsWith('\t') ? l : indent + l))).join('\n');
      const before = contentLines.slice(0, i).join('\n');
      const after = contentLines.slice(i + oldLines.length).join('\n');
      const joiner1 = i > 0 ? '\n' : '';
      const joiner2 = i + oldLines.length < contentLines.length ? '\n' : '';
      return before + joiner1 + reindentedNew + joiner2 + after;
    }
  }

  // Strategy 4: high-confidence fuzzy match. Find the window of the same line
  // count whose normalized text is most similar to old_str. We apply it ONLY
  // when the best match is both very strong (≥0.92) AND clearly unambiguous
  // (well ahead of the second-best candidate). This prevents silently editing
  // the WRONG block in files with repetitive structure — a real corruption risk.
  if (oldLines.length >= 2) {
    let best = { score: 0, index: -1 };
    let second = { score: 0, index: -1 };
    for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
      const windowText = normalizeWs(contentLines.slice(i, i + oldLines.length).join('\n')).trim();
      const score = similarity(windowText, normTarget);
      if (score > best.score) {
        second = best;
        best = { score, index: i };
      } else if (score > second.score) {
        second = { score, index: i };
      }
    }
    const strong = best.index >= 0 && best.score >= 0.92;
    const unambiguous = best.score - second.score >= 0.05 || second.index < 0;
    if (strong && unambiguous) {
      const i = best.index;
      const before = contentLines.slice(0, i).join('\n');
      const after = contentLines.slice(i + oldLines.length).join('\n');
      const joiner1 = i > 0 ? '\n' : '';
      const joiner2 = i + oldLines.length < contentLines.length ? '\n' : '';
      logger.info('edit_file: applied high-confidence fuzzy match', { filePath, score: best.score.toFixed(2), margin: (best.score - second.score).toFixed(2) });
      return before + joiner1 + newStr + joiner2 + after;
    }
    if (strong && !unambiguous) {
      throw new Error(
        `Could not safely edit ${filePath}: the text is similar to ${second.index >= 0 ? 'multiple' : 'another'} region(s) ` +
        `(ambiguous fuzzy match). Include more unique surrounding context in old_str so it matches exactly one place.`
      );
    }
  }

  // Nothing matched — give the model a useful hint (closest line) instead of failing blindly.
  const firstLine = oldLines.find((l) => l.trim().length > 0)?.trim() ?? '';
  let hint = '';
  if (firstLine) {
    const near = contentLines.findIndex((l) => l.trim().includes(firstLine.slice(0, Math.min(firstLine.length, 30))));
    if (near >= 0) {
      const from = Math.max(0, near - 1);
      const to = Math.min(contentLines.length, near + 3);
      hint = `\n\nClosest region in the file (lines ${from + 1}-${to}):\n` +
        contentLines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`).join('\n');
    } else {
      hint = `\n\nThat text does not appear in the file at all. The current symbols/lines you may be thinking of are not present — read the file with read_file to see its ACTUAL current contents before editing.`;
    }
  }
  throw new Error(
    `Could not find the text to replace in ${filePath}. ` +
    `The old_str must be copied EXACTLY from the current file contents. ` +
    `Do NOT guess or reuse text from a previous version.${hint}`
  );
}

/** Character-bigram Dice coefficient in [0,1] — robust for near-miss blocks. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const am = bigrams(a);
  const bm = bigrams(b);
  let inter = 0;
  let aTotal = 0;
  for (const [, c] of am) aTotal += c;
  let bTotal = 0;
  for (const [, c] of bm) bTotal += c;
  for (const [bg, c] of am) {
    const bc = bm.get(bg);
    if (bc) inter += Math.min(c, bc);
  }
  return (2 * inter) / (aTotal + bTotal);
}

/**
 * Append content to the end of a file (creating it if needed). This lets a
 * model build a large file INCREMENTALLY instead of regenerating the whole
 * thing with write_file — which is the #1 cause of truncated/corrupted large
 * files on weak local models (the generation gets cut off mid-file). Preserves
 * the existing file's dominant line ending.
 */
export async function appendFile(
  workspacePath: string,
  filePath: string,
  content: string
): Promise<{ success: boolean; diff: FileDiff; message: string }> {
  const fullPath = resolveSafePath(workspacePath, filePath);

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  const oldContent = existed ? fs.readFileSync(fullPath, 'utf8') : '';
  const eol = existed ? detectEol(oldContent) : '\n';

  // Ensure exactly one separating newline between existing content and the
  // appended block (don't glue lines together, don't pile blank lines).
  let prefix = '';
  if (existed && oldContent.length > 0 && !oldContent.endsWith('\n') && !oldContent.endsWith('\r')) {
    prefix = eol;
  }
  const newContent = oldContent + prefix + normalizeEol(content, eol);

  const tmpPath = fullPath + '.bubbly_tmp';
  fs.writeFileSync(tmpPath, newContent, 'utf8');
  fs.renameSync(tmpPath, fullPath);

  const verification = await verifyFileWrite(fullPath, newContent);
  if (!verification.success) {
    throw new Error(`File append failed verification: ${verification.error}`);
  }

  const patch = createPatch(filePath, oldContent, newContent, 'before', 'after');
  const additions = (patch.match(/^\+[^+]/gm) ?? []).length;
  const deletions = (patch.match(/^-[^-]/gm) ?? []).length;

  logger.info('File appended', { path: filePath, added: content.length, type: existed ? 'modified' : 'created' });
  recordAgentWrite(workspacePath, filePath);
  return {
    success: true,
    message: `Appended ${content.length} chars to ${filePath} (+${additions})`,
    diff: { path: filePath, type: existed ? 'modified' : 'created', diff: patch, additions, deletions },
  };
}

export async function deleteFile(workspacePath: string, filePath: string): Promise<{ success: boolean }> {
  const fullPath = resolveSafePath(workspacePath, filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  logger.debug('Deleting file', { path: filePath });
  fs.unlinkSync(fullPath);

  // Verify the deletion was successful using File Verifier
  logger.debug('Verifying file deletion operation', { path: filePath });
  const verification = await verifyFileDeleted(fullPath);
  
  if (!verification.success) {
    logger.error('File deletion verification failed', { 
      path: filePath, 
      attempts: verification.attempts,
      error: verification.error 
    });
    throw new Error(`File deletion failed verification after ${verification.attempts} attempts: ${verification.error}`);
  }
  
  logger.info('File deleted and verified successfully', { 
    path: filePath,
    attempts: verification.attempts 
  });
  forgetFile(workspacePath, filePath);
  
  return { success: true };
}

export function listDirectory(workspacePath: string, dirPath: string = '.'): string[] {
  const fullPath = resolveSafePath(workspacePath, dirPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  return entries.map((e) => {
    const rel = path.join(dirPath === '.' ? '' : dirPath, e.name);
    return e.isDirectory() ? rel + '/' : rel;
  }).filter((e) => !e.startsWith('.git/') && !e.startsWith('node_modules/'));
}

export function getFileTree(workspacePath: string, dirPath: string = '.', depth: number = 3): string {
  const fullPath = resolveSafePath(workspacePath, dirPath);
  if (!fs.existsSync(fullPath)) return '';

  function buildTree(dir: string, currentDepth: number, prefix: string = ''): string {
    if (currentDepth <= 0) return '';
    let result = '';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return '';
    }

    const filtered = entries.filter((e) => {
      const skip = ['.git', 'node_modules', '.bubbly', 'dist', 'build', '__pycache__', '.venv', 'venv'];
      return !skip.includes(e.name) && !e.name.startsWith('.');
    });

    filtered.forEach((entry, idx) => {
      const isLast = idx === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      result += `${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
      if (entry.isDirectory() && currentDepth > 1) {
        result += buildTree(path.join(dir, entry.name), currentDepth - 1, prefix + childPrefix);
      }
    });
    return result;
  }

  const baseName = path.basename(fullPath);
  return `${baseName}/\n` + buildTree(fullPath, depth);
}

export function searchInFiles(
  workspacePath: string,
  query: string,
  searchPath: string = '.',
  filePattern?: string
): Array<{ file: string; line: number; content: string }> {
  const results: Array<{ file: string; line: number; content: string }> = [];
  const fullSearchPath = resolveSafePath(workspacePath, searchPath);

  // Compile the optional filename filter once, safely — an invalid regex from
  // the model must not abort the whole search.
  let patternRe: RegExp | null = null;
  if (filePattern) {
    try { patternRe = new RegExp(filePattern); } catch {
      logger.warn('searchInFiles: invalid filePattern, ignoring', { filePattern });
      patternRe = null;
    }
  }

  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv']);

  function searchDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (skipDirs.has(entry.name)) continue;

      const fullEntry = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        searchDir(fullEntry);
      } else if (entry.isFile()) {
        if (patternRe && !patternRe.test(entry.name)) continue;
        try {
          const content = fs.readFileSync(fullEntry, 'utf8');
          const lines = content.split('\n');
          const relPath = path.relative(workspacePath, fullEntry);
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              results.push({ file: relPath, line: idx + 1, content: line.trim() });
            }
          });
        } catch {
          // skip binary files
        }
        if (results.length > 100) return;
      }
    }
  }

  searchDir(fullSearchPath);
  return results.slice(0, 100);
}

export function createDirectory(workspacePath: string, dirPath: string): { success: boolean } {
  const fullPath = resolveSafePath(workspacePath, dirPath);
  fs.mkdirSync(fullPath, { recursive: true });
  return { success: true };
}

/**
 * Regex-based search across files with line numbers and surrounding context.
 * A proper grep: supports real patterns (e.g. "^import", "function\\s+\\w+"),
 * optional case sensitivity, include/exclude globs, and N lines of context.
 */
export function regexSearchInFiles(
  workspacePath: string,
  pattern: string,
  opts: {
    searchPath?: string;
    includeGlob?: string;
    excludeGlob?: string;
    caseSensitive?: boolean;
    contextLines?: number;
    maxResults?: number;
  } = {}
): { matches: Array<{ file: string; line: number; text: string; context?: string }>; truncated: boolean; error?: string } {
  const fullSearchPath = resolveSafePath(workspacePath, opts.searchPath ?? '.');
  const maxResults = Math.min(opts.maxResults ?? 100, 500);
  const ctx = Math.min(opts.contextLines ?? 0, 5);

  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseSensitive ? '' : 'i');
  } catch (err) {
    return { matches: [], truncated: false, error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
  }

  const globToRe = (glob?: string): RegExp | null => {
    if (!glob) return null;
    // Minimal but correct glob → regex. Critically, "**/" must match ZERO or
    // more leading directories (so "**/*.ts" also matches a top-level "a.ts").
    const g = glob.replace(/\\/g, '/').trim();
    let r = g
      .replace(/[.+^${}()|[\]]/g, '\\$&') // escape regex specials (keep * ? /)
      .replace(/\*\*\//g, '\u0000')        // **/  → zero+ dirs (placeholder)
      .replace(/\*\*/g, '\u0001')          // **   → anything (placeholder)
      .replace(/\*/g, '[^/]*')             // *    → one path segment
      .replace(/\?/g, '[^/]')              // ?    → single char
      .replace(/\u0000/g, '(?:.*/)?')      // restore **/
      .replace(/\u0001/g, '.*');           // restore **
    try { return new RegExp('^' + r + '$'); } catch { return null; }
  };
  const includeRe = globToRe(opts.includeGlob);
  const excludeRe = globToRe(opts.excludeGlob);

  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.bubbly', 'coverage']);
  const matches: Array<{ file: string; line: number; text: string; context?: string }> = [];
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (includeRe && !includeRe.test(rel)) continue;
        if (excludeRe && excludeRe.test(rel)) continue;
        let content: string;
        try {
          const st = fs.statSync(full);
          if (st.size > 2_000_000) continue; // skip very large files
          content = fs.readFileSync(full, 'utf8');
        } catch { continue; }
        if (content.includes('\u0000')) continue; // binary
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const m: { file: string; line: number; text: string; context?: string } = {
              file: rel, line: i + 1, text: lines[i].slice(0, 400),
            };
            if (ctx > 0) {
              const from = Math.max(0, i - ctx);
              const to = Math.min(lines.length, i + ctx + 1);
              m.context = lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`).join('\n').slice(0, 1200);
            }
            matches.push(m);
            if (matches.length >= maxResults) { truncated = true; return; }
          }
        }
      }
    }
  };

  walk(fullSearchPath);
  return { matches, truncated };
}

/**
 * Fuzzy filename search: find files whose path loosely matches a query, without
 * walking the tree manually. Ranks by subsequence match quality + path brevity.
 */
export function fuzzyFileSearch(
  workspacePath: string,
  query: string,
  limit = 20
): Array<{ path: string; score: number }> {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.bubbly', 'coverage']);
  const q = query.toLowerCase().replace(/[\\/]/g, '');
  const results: Array<{ path: string; score: number }> = [];

  const subsequenceScore = (hay: string): number => {
    // Returns a score if all chars of q appear in order in hay; else -1.
    if (q.length === 0) return 0;
    let qi = 0;
    let lastIdx = -1;
    let gaps = 0;
    for (let i = 0; i < hay.length && qi < q.length; i++) {
      if (hay[i] === q[qi]) {
        if (lastIdx >= 0) gaps += i - lastIdx - 1;
        lastIdx = i;
        qi++;
      }
    }
    if (qi < q.length) return -1;
    // Lower gaps + shorter path = higher score.
    return 1000 - gaps - hay.length * 0.5;
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const hay = rel.toLowerCase().replace(/\//g, '');
        const score = subsequenceScore(hay);
        if (score >= 0) results.push({ path: rel, score });
      }
    }
  };
  walk(resolveSafePath(workspacePath, '.'));
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
