import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { fetchGitStats, type GitChangeStats } from '../../hooks/useApi';
import { GitBranch } from '../Shared/icons';

/** Idle refresh cadence. Edits made outside Bubbly still show up, just not instantly. */
const POLL_MS = 20_000;

/**
 * Live git working-tree counter, sitting next to the workspace pill above the
 * composer. Shows the branch and the +/- line totals against HEAD (untracked
 * files count as additions), so you can see how much the agent has changed
 * without opening the Changes panel — and click through to it.
 *
 * Renders nothing when git isn't installed or the workspace isn't a repo, so a
 * non-git project simply doesn't grow a dead control.
 */
export function GitDiffCounter() {
  const workspacePath = useStore((s) => s.workspacePath);
  const isRunning = useStore((s) => s.isRunning);
  const diffCount = useStore((s) => s.pendingDiffs.length);
  const openRightContext = useStore((s) => s.openRightContext);
  const [stats, setStats] = useState<GitChangeStats | null>(null);
  // Guards against a slow response for a previous workspace overwriting a newer one.
  const requestSeq = useRef(0);

  const refresh = useCallback(() => {
    if (!workspacePath) {
      setStats(null);
      return;
    }
    const seq = ++requestSeq.current;
    fetchGitStats(workspacePath).then((s) => {
      if (seq === requestSeq.current) setStats(s);
    });
  }, [workspacePath]);

  // Refresh on the events that actually change the tree: a new workspace, the
  // agent finishing a run, and each batch of diffs it emits mid-run.
  useEffect(() => { refresh(); }, [refresh, isRunning, diffCount]);

  // Slow background poll, paused while the tab is hidden so a backgrounded
  // window isn't shelling out to git forever.
  useEffect(() => {
    if (!workspacePath) return;
    const tick = () => { if (document.visibilityState === 'visible') refresh(); };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [workspacePath, refresh]);

  if (!stats?.available) return null;

  const { branch, insertions, deletions, filesChanged } = stats;
  const clean = filesChanged === 0;

  return (
    <button
      type="button"
      onClick={() => openRightContext('diff')}
      title={
        clean
          ? `${branch ?? 'git'} · working tree clean`
          : `${branch ?? 'git'} · ${filesChanged} file${filesChanged === 1 ? '' : 's'} changed, ` +
            `+${insertions} −${deletions} — open the Changes panel`
      }
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1
                 text-[11px] text-text-dim hover:text-text hover:border-border-bright
                 shadow-sm transition-colors max-w-[200px]"
    >
      <GitBranch size={11} className="shrink-0 text-text-dim" />
      {branch && <span className="truncate max-w-[80px]">{branch}</span>}
      {clean ? (
        <span className="text-text-dim">clean</span>
      ) : (
        <span className="flex items-center gap-1 tabular-nums shrink-0">
          <span className="text-green-agent">+{insertions.toLocaleString()}</span>
          <span className="text-red-agent">−{deletions.toLocaleString()}</span>
        </span>
      )}
    </button>
  );
}
