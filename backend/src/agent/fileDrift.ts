/**
 * "Someone else changed this file."
 *
 * THE SITUATION THIS EXISTS FOR
 *
 * Bubbly is not the only thing editing the workspace. The user has the project
 * open in their own editor, a formatter runs on save, a `git checkout` lands, a
 * dev server rewrites a generated file. Any of that can happen between the
 * agent writing a file and the agent reading it back — and until now the agent
 * had no way to find out. It would edit against the version it remembered
 * writing, and its next `edit_file` would either fail on a search string that
 * no longer existed (confusing) or, worse, succeed against a similar-looking
 * region and quietly undo the user's change (much worse).
 *
 * The cheap, honest signal is a stat call. After every write the agent makes we
 * remember the file's size, mtime and a hash of what WE put there. Before every
 * model call the live-state block re-stats those files, and anything that no
 * longer matches is reported as "changed since you wrote it, by someone other
 * than you — re-read it before editing".
 *
 * TWO RULES KEEP THIS HONEST
 *
 *  - The agent's own writes RE-BASELINE the record, so the agent never reports
 *    its own edit as somebody else's.
 *  - A drift is reported ONCE and then re-baselined, so a file the user is
 *    actively typing in doesn't fill the state block with the same line every
 *    turn. The agent is told the moment it matters and then left alone.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface DriftReport {
  /** Workspace-relative path, in forward slashes. */
  path: string;
  kind: 'modified' | 'deleted';
  /** How the file differs from what the agent left there. */
  detail: string;
}

interface Baseline {
  size: number;
  mtimeMs: number;
  hash: string;
  /** When the agent last wrote it — used only for the human-readable detail. */
  writtenAt: number;
}

/** Keyed by resolved workspace + a space + the relative path. */
const baselines = new Map<string, Baseline>();

/** Nothing here is worth unbounded memory; a very long session is capped. */
const MAX_TRACKED = 400;

function key(workspacePath: string, relPath: string): string {
  return `${path.resolve(workspacePath)} ${relPath.replace(/\\/g, '/')}`;
}

function hashOf(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
}

function relativize(workspacePath: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
  return path.relative(path.resolve(workspacePath), abs).replace(/\\/g, '/');
}

/**
 * Remember what the agent just left on disk.
 *
 * `content` is optional: a delete has none, and a caller that does not have the
 * final bytes to hand can pass nothing and still get size/mtime tracking, which
 * catches every realistic external edit on its own.
 */
export function recordAgentWrite(workspacePath: string, filePath: string, content?: string): void {
  try {
    const rel = relativize(workspacePath, filePath);
    if (!rel || rel.startsWith('..')) return;
    const abs = path.resolve(workspacePath, rel);
    const k = key(workspacePath, rel);

    if (!fs.existsSync(abs)) {
      // A deleted file has no baseline to keep. Forgetting it is correct: if it
      // reappears, that is a creation and not a drift.
      baselines.delete(k);
      return;
    }
    const st = fs.statSync(abs);
    if (!st.isFile()) return;

    if (baselines.size >= MAX_TRACKED && !baselines.has(k)) {
      // Drop the oldest entry rather than refusing to track the newest — the
      // file being written right now is the one most likely to matter.
      const oldest = baselines.keys().next().value;
      if (oldest !== undefined) baselines.delete(oldest);
    }
    baselines.set(k, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: content !== undefined ? hashOf(content) : '',
      writtenAt: Date.now(),
    });
  } catch (err) {
    // Tracking is a convenience. It must never be able to fail a write.
    logger.debug('Could not baseline a file for drift detection', { error: String(err) });
  }
}

/** Forget a file entirely — used when the agent deletes it. */
export function forgetFile(workspacePath: string, filePath: string): void {
  try {
    baselines.delete(key(workspacePath, relativize(workspacePath, filePath)));
  } catch { /* ignore */ }
}

/**
 * Which tracked files no longer match what the agent left there.
 *
 * Re-baselines everything it reports, so each external change is announced
 * exactly once. Cheap: one stat per tracked file, and only files the agent has
 * actually written this session are tracked.
 */
export function detectDrift(workspacePath: string, limit = 8): DriftReport[] {
  const prefix = `${path.resolve(workspacePath)} `;
  const out: DriftReport[] = [];

  for (const [k, base] of baselines) {
    if (!k.startsWith(prefix)) continue;
    const rel = k.slice(prefix.length);
    const abs = path.resolve(workspacePath, rel);
    try {
      if (!fs.existsSync(abs)) {
        baselines.delete(k);
        out.push({ path: rel, kind: 'deleted', detail: 'it has been deleted since you wrote it' });
        continue;
      }
      const st = fs.statSync(abs);
      const sizeChanged = st.size !== base.size;
      const timeChanged = Math.abs(st.mtimeMs - base.mtimeMs) > 1_000;
      if (!sizeChanged && !timeChanged) continue;

      // mtime alone lies: a formatter that rewrites identical bytes, or a
      // checkout that restores the same content, both bump it. Confirm with the
      // hash when we have one before accusing anybody of changing anything.
      let detail: string;
      if (base.hash && !sizeChanged) {
        const now = hashOf(fs.readFileSync(abs, 'utf8'));
        if (now === base.hash) {
          baselines.set(k, { ...base, mtimeMs: st.mtimeMs });
          continue;
        }
        detail = 'its contents changed (same length, different bytes)';
      } else {
        const delta = st.size - base.size;
        detail = `it is now ${st.size} bytes (${delta > 0 ? `+${delta}` : delta} from what you wrote)`;
      }

      out.push({ path: rel, kind: 'modified', detail });
      // Re-baseline immediately: reported once, then quiet.
      baselines.set(k, { size: st.size, mtimeMs: st.mtimeMs, hash: '', writtenAt: base.writtenAt });
      if (out.length >= limit) break;
    } catch {
      baselines.delete(k);
    }
  }

  return out;
}

/** Test/reset hook. */
export function resetDriftTracking(): void {
  baselines.clear();
}
