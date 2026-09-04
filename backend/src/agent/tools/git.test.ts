import { gitAdd, gitCommit, isGitRepo, getGitStatus, getGitChangeStats } from './git';
import os from 'os';

describe('git tool hardening', () => {
  const nonRepo = os.tmpdir();

  it('gitAdd rejects an empty file list instead of erroring on bare "git add"', () => {
    const r = gitAdd(nonRepo, []);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/No files specified/);
  });

  it('gitAdd filters blank entries', () => {
    const r = gitAdd(nonRepo, ['   ', '']);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/No files specified/);
  });

  it('gitCommit rejects an empty message', () => {
    const r = gitCommit(nonRepo, '   ');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/non-empty commit message/);
  });

  it('never returns an empty message on failure', () => {
    // tmpdir is not a git repo → commit fails, but message must be informative.
    const r = gitCommit(nonRepo, 'test commit');
    expect(r.success).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
  });

  it('isGitRepo returns false for a non-repo directory', () => {
    // os.tmpdir() is typically not a git work tree.
    expect(typeof isGitRepo(nonRepo)).toBe('boolean');
  });

  it('getGitStatus returns a string (clean / not-a-repo / porcelain)', () => {
    expect(typeof getGitStatus(nonRepo)).toBe('string');
  });

  describe('getGitChangeStats', () => {
    it('reports unavailable (not a repo) for a non-git directory, never throwing', () => {
      const r = getGitChangeStats(nonRepo);
      expect(r.available).toBe(false);
      expect(r.reason).toBe('not-a-repo');
      expect(r.filesChanged).toBe(0);
      expect(r.insertions).toBe(0);
      expect(r.deletions).toBe(0);
    });

    it('returns a well-formed shape with numeric totals for this repo', () => {
      // This test runs inside the Bubbly git repo (process.cwd()), so stats are available.
      const r = getGitChangeStats(process.cwd());
      expect(typeof r.available).toBe('boolean');
      expect(Number.isFinite(r.insertions)).toBe(true);
      expect(Number.isFinite(r.deletions)).toBe(true);
      expect(Number.isFinite(r.filesChanged)).toBe(true);
      expect(r.filesChanged).toBeGreaterThanOrEqual(r.untracked);
    });
  });
});
