/**
 * Per-prompt workspace checkpoints — "undo the last N prompts".
 *
 * Before the agent acts on a user prompt, we snapshot the workspace and tag the
 * snapshot with the prompt text + session. The user can then roll the workspace
 * back to the state it was in BEFORE any given prompt — effectively undoing
 * everything the agent did across one or several recent prompts, without git.
 *
 * This builds on the same file-snapshot mechanism as manual checkpoints but
 * keeps its own metadata + a bounded ring (most recent N per workspace) so the
 * store never grows without limit.
 */

import fs from 'fs';
import path from 'path';
import { getProjectDataPath } from './projectData';
import { logger } from '../utils/logger';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.bubbly', 'coverage', '.next', '.nuxt', '.turbo']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 60_000_000;
/** Keep at most this many prompt checkpoints per workspace. */
const MAX_CHECKPOINTS = 12;

export interface PromptCheckpoint {
  id: string;
  sessionId: string;
  /** The user prompt this checkpoint was taken BEFORE. */
  prompt: string;
  createdAt: string;
  fileCount: number;
}

function baseDir(workspacePath: string): string {
  return getProjectDataPath(workspacePath, 'prompt-checkpoints');
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE_BYTES) continue;
        total += st.size;
        if (total > MAX_TOTAL_BYTES) return;
        out.push(full);
      } catch { /* skip */ }
    }
  };
  walk(root);
  return out;
}

/** Prune to the most recent MAX_CHECKPOINTS, deleting older snapshot dirs. */
function prune(root: string): void {
  const all = listPromptCheckpoints(root);
  if (all.length <= MAX_CHECKPOINTS) return;
  const toRemove = all.slice(MAX_CHECKPOINTS); // list is newest-first
  for (const cp of toRemove) {
    try { fs.rmSync(path.join(baseDir(root), cp.id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Snapshot the workspace BEFORE a prompt. Returns the checkpoint id, or null if
 * snapshotting failed (never throws — a checkpoint failure must not block the run).
 */
export function createPromptCheckpoint(workspacePath: string, sessionId: string, prompt: string): PromptCheckpoint | null {
  try {
    const root = path.resolve(workspacePath);
    const id = `pcp_${Date.now().toString(36)}`;
    const dir = path.join(baseDir(root), id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

    const files = collectFiles(root);
    for (const f of files) {
      const rel = path.relative(root, f);
      const dest = path.join(dir, 'files', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.copyFileSync(f, dest); } catch { /* skip unreadable */ }
    }
    const meta: PromptCheckpoint = {
      id,
      sessionId,
      prompt: prompt.slice(0, 280),
      createdAt: new Date().toISOString(),
      fileCount: files.length,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    prune(root);
    logger.info('Prompt checkpoint created', { id, sessionId, fileCount: files.length });
    return meta;
  } catch (err) {
    logger.warn('Failed to create prompt checkpoint', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** List prompt checkpoints (newest first), optionally filtered to a session. */
export function listPromptCheckpoints(workspacePath: string, sessionId?: string): PromptCheckpoint[] {
  const dir = baseDir(path.resolve(workspacePath));
  if (!fs.existsSync(dir)) return [];
  const out: PromptCheckpoint[] = [];
  for (const id of fs.readdirSync(dir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')) as PromptCheckpoint;
      if (!sessionId || meta.sessionId === sessionId) out.push(meta);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revert the workspace to the state captured by a prompt checkpoint: restores
 * every snapshotted file and removes tracked files created afterwards. This
 * undoes everything the agent changed from that prompt onward.
 */
export function revertToPromptCheckpoint(workspacePath: string, id: string): { ok: boolean; restored?: number; removed?: number; error?: string } {
  try {
    const root = path.resolve(workspacePath);
    const dir = path.join(baseDir(root), id);
    const filesDir = path.join(dir, 'files');
    if (!fs.existsSync(filesDir)) return { ok: false, error: `Checkpoint ${id} not found.` };

    const snapRel = new Set<string>();
    const collectSnap = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) collectSnap(full);
        else snapRel.add(path.relative(filesDir, full).replace(/\\/g, '/'));
      }
    };
    collectSnap(filesDir);

    let restored = 0;
    for (const rel of snapRel) {
      const src = path.join(filesDir, rel);
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.copyFileSync(src, dest); restored++; } catch { /* skip */ }
    }

    // Remove tracked files created after the checkpoint.
    let removed = 0;
    for (const f of collectFiles(root)) {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      if (!snapRel.has(rel)) {
        try { fs.unlinkSync(f); removed++; } catch { /* skip */ }
      }
    }

    logger.info('Reverted to prompt checkpoint', { id, restored, removed });
    return { ok: true, restored, removed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
