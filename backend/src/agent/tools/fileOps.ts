/**
 * Explorer file operations — the CRUD behind the tree's right-click menu.
 *
 * These are USER actions, not agent ones, and the difference matters. The agent
 * writes files as part of work the user asked for and every change lands in the
 * Changes panel where it can be reviewed and reverted. A user right-clicking
 * "Delete" gets no such review, so the safety has to be in the operation
 * itself: nothing is destroyed, it is moved to the OS trash and stays
 * recoverable from outside Bubbly entirely.
 *
 * Every path goes through resolveSafePath, so none of it can address anything
 * outside the workspace.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { resolveSafePath } from './filesystem';
import { logger } from '../../utils/logger';

export interface OpResult {
  ok: boolean;
  error?: string;
  /** Workspace-relative path the operation produced, when it made something. */
  path?: string;
}

/** Reject names that would silently mean something else on the filesystem. */
function validateName(name: string): string | null {
  if (!name || !name.trim()) return 'A name is required.';
  if (name.includes('/') || name.includes('\\')) return 'A name cannot contain a path separator.';
  if (name === '.' || name === '..') return `"${name}" is not a usable name.`;
  // Windows refuses these outright, and on other platforms a file with one of
  // these names is a trap when the project is later opened on Windows.
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return 'A name cannot contain < > : " | ? * or control characters.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return `"${name}" is a reserved device name on Windows.`;
  return null;
}

/** Turn an absolute path back into the workspace-relative form the UI uses. */
function toRelative(workspacePath: string, abs: string): string {
  return path.relative(path.resolve(workspacePath), abs).replace(/\\/g, '/');
}

export function createEntry(
  workspacePath: string,
  parentDir: string,
  name: string,
  type: 'file' | 'directory',
): OpResult {
  const bad = validateName(name);
  if (bad) return { ok: false, error: bad };
  try {
    const parent = resolveSafePath(workspacePath, parentDir || '.');
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      return { ok: false, error: `"${parentDir}" is not a folder.` };
    }
    const target = path.join(parent, name);
    // Guard the join too: `name` is validated, but resolveSafePath is the one
    // place that decides what "inside the workspace" means.
    resolveSafePath(workspacePath, path.join(parentDir || '.', name));
    if (fs.existsSync(target)) return { ok: false, error: `"${name}" already exists here.` };

    if (type === 'directory') fs.mkdirSync(target, { recursive: false });
    // 'wx' fails if it exists — closes the race between the check above and here.
    else fs.writeFileSync(target, '', { flag: 'wx' });

    logger.info('Explorer created entry', { type, path: target });
    return { ok: true, path: toRelative(workspacePath, target) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function renameEntry(workspacePath: string, from: string, newName: string): OpResult {
  const bad = validateName(newName);
  if (bad) return { ok: false, error: bad };
  try {
    const src = resolveSafePath(workspacePath, from);
    if (!fs.existsSync(src)) return { ok: false, error: `"${from}" no longer exists.` };
    const target = path.join(path.dirname(src), newName);
    resolveSafePath(workspacePath, path.join(path.dirname(from), newName));

    // A case-only rename ("readme.md" → "README.md") is a real rename the user
    // means, but on Windows and macOS the source and target are the SAME file,
    // so the existence check below would reject it. Go via a temp name.
    const caseOnly = src.toLowerCase() === target.toLowerCase() && src !== target;
    if (!caseOnly && fs.existsSync(target)) return { ok: false, error: `"${newName}" already exists here.` };
    if (caseOnly) {
      const tmp = `${src}.rename-${Date.now()}`;
      fs.renameSync(src, tmp);
      fs.renameSync(tmp, target);
    } else {
      fs.renameSync(src, target);
    }

    logger.info('Explorer renamed entry', { from: src, to: target });
    return { ok: true, path: toRelative(workspacePath, target) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** "file.ts" → "file copy.ts" → "file copy 2.ts". Never overwrites. */
function nextCopyName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 500; n++) {
    const candidate = n === 1 ? `${base} copy${ext}` : `${base} copy ${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} copy ${Date.now()}${ext}`;
}

export function duplicateEntry(workspacePath: string, target: string): OpResult {
  try {
    const src = resolveSafePath(workspacePath, target);
    if (!fs.existsSync(src)) return { ok: false, error: `"${target}" no longer exists.` };
    const dir = path.dirname(src);
    const copyName = nextCopyName(dir, path.basename(src));
    const dest = path.join(dir, copyName);
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    logger.info('Explorer duplicated entry', { from: src, to: dest });
    return { ok: true, path: toRelative(workspacePath, dest) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr || err.message).trim() });
      else resolve({ ok: true });
    });
  });
}

/**
 * Delete to the OS trash — never `fs.rm`.
 *
 * The point of routing through the Recycle Bin is that recovery does not depend
 * on Bubbly: if the app is closed, or the user later decides the deletion was a
 * mistake, the file is still where every other program on the machine expects
 * deleted files to be. A private trash folder of our own would be a worse
 * promise, because it only works while Bubbly is the tool being used.
 *
 * If no trash mechanism is available we REFUSE rather than quietly falling back
 * to a permanent delete — the user chose "move to trash", and silently doing
 * something less recoverable than they asked for is the wrong failure.
 */
export async function trashEntry(workspacePath: string, target: string): Promise<OpResult> {
  let src: string;
  try {
    src = resolveSafePath(workspacePath, target);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!fs.existsSync(src)) return { ok: false, error: `"${target}" no longer exists.` };
  if (path.resolve(src) === path.resolve(workspacePath)) {
    return { ok: false, error: 'Refusing to delete the workspace root.' };
  }

  const isDir = fs.statSync(src).isDirectory();

  if (process.platform === 'win32') {
    // VisualBasic.FileSystem is the documented way to reach the Recycle Bin
    // from a script; .NET's own File.Delete bypasses it entirely.
    const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
    const extra = isDir ? ", 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException'" : ", 'OnlyErrorDialogs', 'SendToRecycleBin'";
    const script =
      `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${JSON.stringify(src)}${extra})`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!r.ok) return { ok: false, error: `Could not move to the Recycle Bin: ${r.error}` };
    logger.info('Explorer trashed entry', { path: src });
    return { ok: true, path: toRelative(workspacePath, src) };
  }

  if (process.platform === 'darwin') {
    const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(src)}`;
    const r = await run('osascript', ['-e', script]);
    if (!r.ok) return { ok: false, error: `Could not move to the Trash: ${r.error}` };
    return { ok: true, path: toRelative(workspacePath, src) };
  }

  // Linux: gio is part of GLib and present on every mainstream desktop.
  const r = await run('gio', ['trash', src]);
  if (!r.ok) {
    return {
      ok: false,
      error: `Could not move to the trash (gio trash failed: ${r.error}). Install glib2 / gvfs, or delete the file outside Bubbly.`,
    };
  }
  return { ok: true, path: toRelative(workspacePath, src) };
}

/** Show the entry in the OS file manager (Explorer, Finder, the desktop's). */
export async function revealEntry(workspacePath: string, target: string): Promise<OpResult> {
  try {
    const src = resolveSafePath(workspacePath, target);
    if (!fs.existsSync(src)) return { ok: false, error: `"${target}" no longer exists.` };
    if (process.platform === 'win32') {
      // explorer.exe returns a non-zero exit code even on success, so its
      // result is deliberately not checked.
      execFile('explorer.exe', ['/select,', src], { windowsHide: true }, () => { /* see above */ });
      return { ok: true };
    }
    if (process.platform === 'darwin') {
      const r = await run('open', ['-R', src]);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    const r = await run('xdg-open', [path.dirname(src)]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
