/**
 * The local workspace, behind the provider interface.
 *
 * This is a thin adapter, on purpose. Every rule about what a path is allowed
 * to be — no escaping the root, no symlink jumps, no absolute paths sneaking in
 * — already lives in `agent/tools/filesystem.ts` and is exercised by its tests.
 * Re-implementing containment here would create a second set of rules to keep
 * in step with the first, and path-containment bugs are exactly the kind you do
 * not discover until they matter.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { resolveSafePath } from '../agent/tools/filesystem';
import { runShell, runShellStreaming } from '../agent/tools/shell';
import type {
  DirEntry, ExecOptions, ExecResult, FileStat,
  StreamingExecCallbacks, WorkspaceProvider,
} from './types';

export class LocalProvider implements WorkspaceProvider {
  readonly kind = 'local' as const;
  readonly pathSep = path.sep as '/' | '\\';

  constructor(readonly root: string) {}

  get label(): string { return this.root; }

  async ensureReady(): Promise<void> { /* the local disk is always ready */ }

  private abs(relPath: string): string {
    return resolveSafePath(this.root, relPath);
  }

  async readFile(relPath: string): Promise<string> {
    return fsp.readFile(this.abs(relPath), 'utf8');
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    return fsp.readFile(this.abs(relPath));
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const full = this.abs(relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
  }

  async deleteFile(relPath: string): Promise<void> {
    await fsp.rm(this.abs(relPath), { recursive: true, force: true });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const to = this.abs(toRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(this.abs(fromRel), to);
  }

  async mkdirp(relPath: string): Promise<void> {
    await fsp.mkdir(this.abs(relPath), { recursive: true });
  }

  async stat(relPath: string): Promise<FileStat> {
    try {
      const s = await fsp.stat(this.abs(relPath));
      return { exists: true, isDirectory: s.isDirectory(), size: s.size, modifiedMs: s.mtimeMs };
    } catch {
      return { exists: false, isDirectory: false, size: 0, modifiedMs: 0 };
    }
  }

  async list(relPath: string): Promise<DirEntry[]> {
    const dir = this.abs(relPath || '.');
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let size = 0;
      let modifiedMs = 0;
      try {
        const s = await fsp.stat(full);
        size = s.size;
        modifiedMs = s.mtimeMs;
      } catch { /* a file can vanish between readdir and stat */ }
      out.push({
        name: e.name,
        path: path.relative(this.root, full).replace(/\\/g, '/'),
        isDirectory: e.isDirectory(),
        size,
        modifiedMs,
      });
    }
    return out;
  }

  async walk(opts: { relPath?: string; maxEntries?: number; includeHidden?: boolean } = {}): Promise<DirEntry[]> {
    const max = opts.maxEntries ?? 5000;
    const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', 'target']);
    const out: DirEntry[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      if (out.length >= max) return;
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= max) return;
        if (skip.has(e.name)) continue;
        if (!opts.includeHidden && e.name.startsWith('.') && e.name !== '.bubbly') continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(this.root, full).replace(/\\/g, '/');
        if (e.isDirectory()) {
          out.push({ name: e.name, path: rel, isDirectory: true, size: 0, modifiedMs: 0 });
          await walkDir(full);
        } else if (e.isFile()) {
          let size = 0;
          let modifiedMs = 0;
          try { const s = await fsp.stat(full); size = s.size; modifiedMs = s.mtimeMs; } catch { /* raced */ }
          out.push({ name: e.name, path: rel, isDirectory: false, size, modifiedMs });
        }
      }
    };

    await walkDir(this.abs(opts.relPath || '.'));
    return out;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const r = runShell(command, this.root, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env });
    return { ...r };
  }

  async execStreaming(
    command: string,
    cb: StreamingExecCallbacks,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    return runShellStreaming(
      command,
      this.root,
      { onStdout: cb.onStdout, onStderr: cb.onStderr },
      { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env },
    );
  }

  async dispose(): Promise<void> { /* nothing to release */ }
}
