/**
 * Workspace checkpoints — lightweight snapshot + revert.
 *
 * When the agent is about to do something risky (a big refactor, a rewrite that
 * could truncate, a migration), it can create a CHECKPOINT, then REVERT to it if
 * things go wrong — without resorting to `git checkout` via the shell (which
 * was a failure source in earlier runs). Snapshots copy code/text files into a
 * hidden store under .bubbly/checkpoints. Bounded in size so it stays cheap.
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.bubbly', 'coverage', '.next', '.nuxt']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 50_000_000; // don't snapshot huge trees

function checkpointsDir(workspacePath: string): string {
  return path.join(workspacePath, '.bubbly', 'checkpoints');
}

interface CheckpointMeta {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
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

/** Create a checkpoint snapshotting all tracked files. */
export function createCheckpoint(workspacePath: string, label: string): { ok: boolean; id?: string; fileCount?: number; error?: string } {
  try {
    const root = path.resolve(workspacePath);
    const id = `cp_${Date.now().toString(36)}_${uuidv4().slice(0, 4)}`;
    const dir = path.join(checkpointsDir(root), id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

    const files = collectFiles(root);
    for (const f of files) {
      const rel = path.relative(root, f);
      const dest = path.join(dir, 'files', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
    const meta: CheckpointMeta = { id, label, createdAt: new Date().toISOString(), fileCount: files.length };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    logger.info('Checkpoint created', { id, label, fileCount: files.length });
    return { ok: true, id, fileCount: files.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function listCheckpoints(workspacePath: string): CheckpointMeta[] {
  const dir = checkpointsDir(path.resolve(workspacePath));
  if (!fs.existsSync(dir)) return [];
  const out: CheckpointMeta[] = [];
  for (const id of fs.readdirSync(dir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')) as CheckpointMeta;
      out.push(meta);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revert the workspace to a checkpoint: restores every snapshotted file to its
 * saved content, and removes tracked files that were created after the snapshot
 * (so the state matches the checkpoint). Never touches skipped dirs.
 */
export function revertToCheckpoint(workspacePath: string, id: string): { ok: boolean; restored?: number; removed?: number; error?: string } {
  try {
    const root = path.resolve(workspacePath);
    const dir = path.join(checkpointsDir(root), id);
    const filesDir = path.join(dir, 'files');
    if (!fs.existsSync(filesDir)) return { ok: false, error: `Checkpoint ${id} not found.` };

    // Snapshot's relative file set.
    const snapRel = new Set<string>();
    const collectSnap = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) collectSnap(full);
        else snapRel.add(path.relative(filesDir, full).replace(/\\/g, '/'));
      }
    };
    collectSnap(filesDir);

    // Restore snapshot files.
    let restored = 0;
    for (const rel of snapRel) {
      const src = path.join(filesDir, rel);
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      restored++;
    }

    // Remove tracked files created after the checkpoint (present now, not in snap).
    let removed = 0;
    const currentFiles = collectFiles(root);
    for (const f of currentFiles) {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      if (!snapRel.has(rel)) {
        try { fs.unlinkSync(f); removed++; } catch { /* skip */ }
      }
    }

    logger.info('Reverted to checkpoint', { id, restored, removed });
    return { ok: true, restored, removed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
