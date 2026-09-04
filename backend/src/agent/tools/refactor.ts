/**
 * Refactoring helpers: symbol rename and file move with reference updates.
 *
 * Bubbly's code index uses fast regex heuristics rather than a full LSP, so
 * these are pragmatic, word-boundary based refactors — not semantically perfect,
 * but they cover the common cases (renaming a function/class/var, moving a file
 * and fixing the relative imports that pointed at it). Both report exactly what
 * they changed so the agent can verify and the user can review the diff.
 */

import fs from 'fs';
import path from 'path';
import { createPatch } from 'diff';
import type { FileDiff } from '../../types';
import { logger } from '../../utils/logger';
import { resolveSafePath } from './filesystem';
import { getIndex, invalidateIndex } from '../intelligence/codeIntelligence';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rename a symbol across all indexed code files using word-boundary matching.
 * Returns the set of file diffs. Conservative: only matches whole-word
 * occurrences of `oldName`, so it won't corrupt substrings (e.g. renaming
 * `user` won't touch `username`).
 */
export function renameSymbol(
  workspacePath: string,
  oldName: string,
  newName: string
): { ok: boolean; diffs: FileDiff[]; filesChanged: number; occurrences: number; error?: string } {
  if (!oldName || !newName) return { ok: false, diffs: [], filesChanged: 0, occurrences: 0, error: 'oldName and newName are required.' };
  if (oldName === newName) {
    return { ok: false, diffs: [], filesChanged: 0, occurrences: 0, error: 'oldName and newName are identical — nothing to rename.' };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(oldName)) {
    return { ok: false, diffs: [], filesChanged: 0, occurrences: 0, error: `"${oldName}" is not a valid identifier. rename_symbol renames whole-word identifiers; use edit_file for arbitrary text.` };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
    return { ok: false, diffs: [], filesChanged: 0, occurrences: 0, error: `"${newName}" is not a valid identifier.` };
  }

  const index = getIndex(workspacePath);
  const re = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, 'g');
  const diffs: FileDiff[] = [];
  let occurrences = 0;

  for (const f of index.files.values()) {
    let content: string;
    try { content = fs.readFileSync(f.fullPath, 'utf8'); } catch { continue; }
    if (!re.test(content)) continue;
    re.lastIndex = 0;
    const count = (content.match(re) || []).length;
    const updated = content.replace(re, newName);
    if (updated === content) continue;
    try {
      const tmp = f.fullPath + '.bubbly_tmp';
      fs.writeFileSync(tmp, updated, 'utf8');
      fs.renameSync(tmp, f.fullPath);
    } catch (err) {
      logger.warn('renameSymbol: write failed', { path: f.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    occurrences += count;
    const patch = createPatch(f.path, content, updated, 'before', 'after');
    diffs.push({
      path: f.path, type: 'modified', diff: patch,
      additions: (patch.match(/^\+[^+]/gm) ?? []).length,
      deletions: (patch.match(/^-[^-]/gm) ?? []).length,
    });
  }

  invalidateIndex(workspacePath);
  logger.info('renameSymbol complete', { oldName, newName, filesChanged: diffs.length, occurrences });
  return { ok: true, diffs, filesChanged: diffs.length, occurrences };
}

/** Compute a module specifier (no extension) from one rel path to another. */
function relImportSpecifier(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, toFile).replace(/\\/g, '/');
  rel = rel.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/**
 * Move/rename a file and update relative imports in other files that referenced
 * it. Updates JS/TS-style relative import specifiers. Returns all diffs.
 */
export function moveFile(
  workspacePath: string,
  sourceRel: string,
  destRel: string
): { ok: boolean; diffs: FileDiff[]; importsUpdated: number; error?: string } {
  const srcAbs = resolveSafePath(workspacePath, sourceRel);
  const dstAbs = resolveSafePath(workspacePath, destRel);
  if (!fs.existsSync(srcAbs)) return { ok: false, diffs: [], importsUpdated: 0, error: `Source not found: ${sourceRel}` };
  if (fs.existsSync(dstAbs)) return { ok: false, diffs: [], importsUpdated: 0, error: `Destination already exists: ${destRel}` };

  const srcNorm = path.relative(workspacePath, srcAbs).replace(/\\/g, '/');
  const dstNorm = path.relative(workspacePath, dstAbs).replace(/\\/g, '/');

  // Move the file first.
  const dstDir = path.dirname(dstAbs);
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  const moved = fs.readFileSync(srcAbs, 'utf8');
  fs.writeFileSync(dstAbs, moved, 'utf8');
  fs.unlinkSync(srcAbs);

  const diffs: FileDiff[] = [];
  let importsUpdated = 0;

  // Update relative imports in every other indexed file that pointed at the old path.
  invalidateIndex(workspacePath);
  const index = getIndex(workspacePath);
  const srcNoExt = srcNorm.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$/, '');

  for (const f of index.files.values()) {
    if (f.path === dstNorm) continue;
    let content: string;
    try { content = fs.readFileSync(f.fullPath, 'utf8'); } catch { continue; }
    let changed = content;

    // Match import/require/from specifiers ending in the old (extensionless) path.
    const specifierRe = /(['"])(\.[^'"]+?)(\1)/g;
    changed = changed.replace(specifierRe, (whole, q, spec) => {
      const resolvedTarget = path.normalize(path.join(path.dirname(f.path), spec)).replace(/\\/g, '/').replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$/, '');
      if (resolvedTarget === srcNoExt) {
        importsUpdated++;
        return `${q}${relImportSpecifier(f.path, dstNorm)}${q}`;
      }
      return whole;
    });

    if (changed !== content) {
      const tmp = f.fullPath + '.bubbly_tmp';
      fs.writeFileSync(tmp, changed, 'utf8');
      fs.renameSync(tmp, f.fullPath);
      const patch = createPatch(f.path, content, changed, 'before', 'after');
      diffs.push({
        path: f.path, type: 'modified', diff: patch,
        additions: (patch.match(/^\+[^+]/gm) ?? []).length,
        deletions: (patch.match(/^-[^-]/gm) ?? []).length,
      });
    }
  }

  invalidateIndex(workspacePath);
  logger.info('moveFile complete', { sourceRel, destRel, importsUpdated, filesTouched: diffs.length });

  // Represent the move itself as created+deleted diffs.
  const movedPatch = createPatch(dstNorm, '', moved, 'before', 'after');
  diffs.unshift({
    path: dstNorm, type: 'created', diff: movedPatch,
    additions: (movedPatch.match(/^\+[^+]/gm) ?? []).length, deletions: 0,
  });

  return { ok: true, diffs, importsUpdated };
}
