/**
 * Where Bubbly keeps a project's private state.
 *
 * The rule: NEVER inside the project folder. Bubbly's own metadata (specs,
 * checkpoints, the run config, the code index, steering files) used to live in a
 * `.bubbly/` directory at the project root, which broke a whole class of real
 * workflows: `npm create vite@latest .`, `create-next-app .`, `git clone` into
 * the folder — anything that demands an empty directory refuses to run when
 * `.bubbly/` is sitting there. A framework scaffold cancelled halfway is the
 * exact scenario the user hit.
 *
 * So each project's state now lives OUTSIDE it, under the user's home:
 *
 *     ~/.bubbly/projects/<basename>-<hash>/
 *
 * The hash is derived from the project's absolute, normalized path, so the
 * mapping is stable (the same project always resolves to the same dir) and
 * collision-safe (two different "web" folders don't share state). The basename
 * prefix keeps the directory human-recognizable when browsing ~/.bubbly.
 *
 * Existing projects are migrated transparently: the first time a project's data
 * dir is requested, if the old in-project `.bubbly/` exists and the new external
 * one does not, the old one is MOVED out. That both preserves prior specs/
 * checkpoints AND retroactively unblocks the clean-slate tools for old projects.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';

/** Root of all per-project external state. Overridable for tests. */
function projectsRoot(): string {
  return process.env.BUBBLY_PROJECTS_ROOT || path.join(os.homedir(), '.bubbly', 'projects');
}

/** Legacy in-project location we migrate away from. */
export function legacyProjectDir(workspacePath: string): string {
  return path.join(workspacePath, '.bubbly');
}

/** A filesystem-safe, human-readable, collision-proof slug for a workspace. */
function slugFor(workspacePath: string): string {
  const abs = path.resolve(workspacePath);
  // Normalize so the SAME project always hashes identically regardless of how it
  // was addressed: drive-letter case and trailing slashes differ on Windows.
  const normalized = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'project';
  return `${base}-${hash}`;
}

/** In-memory guard so migration is attempted at most once per path per process. */
const migrated = new Set<string>();

/**
 * Move a legacy in-project `.bubbly/` to the external location, once.
 *
 * rename() is atomic and cheap on the same volume; across volumes (home on C:,
 * project on D:) it throws EXDEV, so we fall back to a recursive copy + delete.
 * Either way the project folder ends up clean.
 */
function migrateIfNeeded(workspacePath: string, dataDir: string): void {
  if (migrated.has(dataDir)) return;
  migrated.add(dataDir);

  const legacy = legacyProjectDir(workspacePath);
  try {
    if (!fs.existsSync(legacy)) return;          // nothing to migrate
    if (fs.existsSync(dataDir)) return;          // already have external state; leave legacy alone rather than risk clobbering
    if (!fs.statSync(legacy).isDirectory()) return;

    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    try {
      fs.renameSync(legacy, dataDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        copyDirSync(legacy, dataDir);
        fs.rmSync(legacy, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    logger.info('Migrated project state out of the workspace', { workspacePath, from: legacy, to: dataDir });
  } catch (err) {
    // Migration is best-effort. If it fails the caller still gets a usable
    // (fresh) external dir; the legacy one simply lingers until next time.
    logger.warn('Could not migrate legacy .bubbly directory', {
      workspacePath, error: err instanceof Error ? err.message : String(err),
    });
  }
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * The external data directory for a project. Creates it (and migrates legacy
 * state into it) on first request. This is the ONE place that knows where a
 * project's private state lives.
 */
export function getProjectDataDir(workspacePath: string): string {
  const dataDir = path.join(projectsRoot(), slugFor(workspacePath));
  migrateIfNeeded(workspacePath, dataDir);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/** A named subdirectory inside the project's external data dir (specs, etc.). */
export function getProjectDataPath(workspacePath: string, ...segments: string[]): string {
  return path.join(getProjectDataDir(workspacePath), ...segments);
}
