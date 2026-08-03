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
 * dir is requested, anything left in the old in-project `.bubbly/` is MOVED out.
 * That both preserves prior state AND retroactively unblocks the clean-slate
 * tools for old projects.
 *
 * ONE EXCEPTION: `.bubbly/specs/` stays in the project. Specs are documents
 * about the code rather than machine state, so they are meant to be browsed,
 * diffed and committed alongside it — see specs.ts. The migration below skips
 * that entry deliberately.
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
 * Entries of an in-project `.bubbly/` that BELONG there and must never be moved
 * out. Currently just specs: they are documents about the code, written to be
 * read and reviewed by a human, so they live with the code (see specs.ts).
 */
const IN_PROJECT_ENTRIES = new Set(['specs']);

/**
 * Move legacy in-project `.bubbly/` state to the external location, once.
 *
 * This migrates ENTRY BY ENTRY rather than moving the whole directory, and skips
 * anything in IN_PROJECT_ENTRIES. The wholesale move was correct when nothing at
 * all was allowed inside the project; now that specs live there it would drag
 * them out again on every fresh process whose external dir didn't exist yet, and
 * the specs module would immediately move them back — a tug of war over the
 * user's documents, with a window in which they are in neither place.
 *
 * rename() is atomic and cheap on the same volume; across volumes (home on C:,
 * project on D:) it throws EXDEV, so we fall back to a recursive copy + delete.
 */
function migrateIfNeeded(workspacePath: string, dataDir: string): void {
  if (migrated.has(dataDir)) return;
  migrated.add(dataDir);

  const legacy = legacyProjectDir(workspacePath);
  try {
    if (!fs.existsSync(legacy)) return;          // nothing to migrate
    if (!fs.statSync(legacy).isDirectory()) return;

    const entries = fs.readdirSync(legacy, { withFileTypes: true })
      .filter((e) => !IN_PROJECT_ENTRIES.has(e.name));
    if (entries.length === 0) return;

    fs.mkdirSync(dataDir, { recursive: true });

    let moved = 0;
    for (const entry of entries) {
      const from = path.join(legacy, entry.name);
      const to = path.join(dataDir, entry.name);
      // External state already exists for this entry — leave the legacy copy
      // alone rather than risk clobbering newer state with older.
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          if (entry.isDirectory()) copyDirSync(from, to);
          else fs.copyFileSync(from, to);
          fs.rmSync(from, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      moved++;
    }

    // Remove `.bubbly/` only if nothing legitimate is left in it.
    try {
      if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    } catch { /* a non-empty dir simply stays */ }

    if (moved > 0) {
      logger.info('Migrated project state out of the workspace', { workspacePath, from: legacy, to: dataDir, moved });
    }
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
