import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordAgentWrite, detectDrift, forgetFile, resetDriftTracking } from './fileDrift';

/**
 * "SOMEONE ELSE CHANGED THIS FILE."
 *
 * Bubbly is not the only thing editing the workspace: the user has their own
 * editor open, a formatter runs on save, a branch gets checked out. When that
 * happens between the agent writing a file and the agent editing it again, the
 * agent's next `edit_file` either fails on an anchor that no longer exists
 * (confusing) or matches a similar-looking region and quietly reverts the
 * user's change while reporting success (much worse).
 *
 * The contract these pin is narrow and has to be exact in both directions:
 * report a change made by someone else, and NEVER report one of the agent's own.
 */
describe('fileDrift', () => {
  let workspace: string;

  beforeEach(() => {
    resetDriftTracking();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-drift-'));
  });

  afterEach(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const write = (rel: string, content: string) => {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
  };

  it('says nothing about a file the agent wrote and nobody has touched since', () => {
    write('a.ts', 'export const a = 1;\n');
    recordAgentWrite(workspace, 'a.ts', 'export const a = 1;\n');
    expect(detectDrift(workspace)).toEqual([]);
  });

  it('reports a file changed by someone else', () => {
    write('a.ts', 'export const a = 1;\n');
    recordAgentWrite(workspace, 'a.ts', 'export const a = 1;\n');

    write('a.ts', 'export const a = 1;\nexport const b = 2;\n');

    const drift = detectDrift(workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0].path).toBe('a.ts');
    expect(drift[0].kind).toBe('modified');
  });

  it('reports each change ONCE, so a file being actively edited does not fill the state block', () => {
    write('a.ts', 'one\n');
    recordAgentWrite(workspace, 'a.ts', 'one\n');
    write('a.ts', 'one\ntwo\n');

    expect(detectDrift(workspace)).toHaveLength(1);
    // Re-baselined on report: the same unchanged state must not be announced
    // again on every single model call for the rest of the turn.
    expect(detectDrift(workspace)).toEqual([]);
  });

  it('never reports the agent’s own subsequent write as somebody else’s', () => {
    write('a.ts', 'one\n');
    recordAgentWrite(workspace, 'a.ts', 'one\n');

    write('a.ts', 'one\ntwo\n');
    recordAgentWrite(workspace, 'a.ts', 'one\ntwo\n');

    expect(detectDrift(workspace)).toEqual([]);
  });

  it('reports a deletion and then forgets the file', () => {
    write('gone.ts', 'x\n');
    recordAgentWrite(workspace, 'gone.ts', 'x\n');
    fs.rmSync(path.join(workspace, 'gone.ts'));

    const drift = detectDrift(workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('deleted');
    // A file that comes back is a creation, not a drift.
    write('gone.ts', 'x\n');
    expect(detectDrift(workspace)).toEqual([]);
  });

  it('does not report a rewrite that produced identical bytes', () => {
    // A formatter that reformats to the same result, or a checkout that
    // restores the same content, both bump mtime. Accusing the user of a change
    // they did not make would send the agent re-reading files for nothing.
    write('same.ts', 'const x = 1;\n');
    recordAgentWrite(workspace, 'same.ts', 'const x = 1;\n');

    const abs = path.join(workspace, 'same.ts');
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(abs, 'const x = 1;\n', 'utf8');
    fs.utimesSync(abs, future, future);

    expect(detectDrift(workspace)).toEqual([]);
  });

  it('forgets a file on request, and ignores paths outside the workspace', () => {
    write('a.ts', 'x\n');
    recordAgentWrite(workspace, 'a.ts', 'x\n');
    forgetFile(workspace, 'a.ts');
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'changed\n', 'utf8');
    expect(detectDrift(workspace)).toEqual([]);

    // A path that escapes the workspace is not tracked at all — the drift
    // report is about THIS project, and a stray absolute path must not put
    // someone else's file into it.
    recordAgentWrite(workspace, path.join(os.tmpdir(), 'elsewhere.txt'), 'x');
    expect(detectDrift(workspace)).toEqual([]);
  });

  it('keeps drift reports scoped to one workspace', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-drift-other-'));
    try {
      write('a.ts', 'x\n');
      recordAgentWrite(workspace, 'a.ts', 'x\n');
      fs.writeFileSync(path.join(workspace, 'a.ts'), 'changed\n', 'utf8');

      expect(detectDrift(other)).toEqual([]);
      expect(detectDrift(workspace)).toHaveLength(1);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
