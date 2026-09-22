/**
 * Threads: the list the sidebar shows, and the ONE way a thread is opened.
 *
 * There used to be two openers — the sidebar's, which reset the window fully
 * but never asked whether the thread was still running, and the URL router's,
 * which asked but only half-reset (a pending question or a worker plan from the
 * previous thread leaked through). Every entry point — sidebar, command
 * palette, deep link, tray — now goes through `openThread`.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../store';
import { loadThread } from './messageReconstruction';
import { fetchPromptCheckpoints } from '../hooks/useApi';
import type { ThreadType } from '../types';

export interface ThreadRow {
  id: string;
  threadType: ThreadType;
  threadName?: string;
  firstMessage: string;
  messageCount: number;
  workspacePath?: string;
  /** Live from the backend's orchestrator, not the stored status column. */
  running?: boolean;
  createdAt: string;
  updatedAt: string;
}

const LIST_LIMIT = 40;
let rows: ThreadRow[] | null = null;
let failed = false;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let queued = false;

function emit(): void {
  for (const l of listeners) l();
}

/** Re-read the thread list. Concurrent calls coalesce into at most one follow-up. */
export function refreshThreads(): Promise<void> {
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = fetch(`/api/sessions/threads?limit=${LIST_LIMIT}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((data: unknown) => {
      rows = Array.isArray(data) ? (data as ThreadRow[]) : [];
      failed = false;
    })
    .catch(() => { failed = rows === null; })
    .finally(() => {
      inflight = null;
      emit();
      if (queued) { queued = false; void refreshThreads(); }
    });
  return inflight;
}

export function threadMeta(id: string): ThreadRow | undefined {
  return rows?.find((r) => r.id === id);
}

/** A thread's display title: its generated name, else its first line. */
export function threadTitle(row: Pick<ThreadRow, 'threadName' | 'firstMessage'>): string {
  if (row.threadName?.trim()) return row.threadName.trim();
  const first = row.firstMessage.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  return first || 'Untitled thread';
}

/**
 * The thread list, kept fresh by what actually changes it: a thread being
 * created, titled, started or finished in this window, the window regaining
 * focus, and — only while something is running in the background — a slow
 * poll so another thread's spinner stops when it finishes.
 */
export function useThreadList(): { threads: ThreadRow[] | null; failed: boolean } {
  const threads = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => rows,
  );

  const currentSessionId = useStore((s) => s.currentSessionId);
  const isRunning = useStore((s) => s.isRunning);
  const title = useStore((s) => s.currentThreadTitle);
  useEffect(() => {
    const t = setTimeout(() => { void refreshThreads(); }, rows === null ? 0 : 250);
    return () => clearTimeout(t);
  }, [currentSessionId, isRunning, title]);

  const anyRunning = !!threads?.some((t) => t.running);
  useEffect(() => {
    const onFocus = () => { void refreshThreads(); };
    window.addEventListener('focus', onFocus);
    const poll = anyRunning ? setInterval(onFocus, 8000) : null;
    return () => {
      window.removeEventListener('focus', onFocus);
      if (poll) clearInterval(poll);
    };
  }, [anyRunning]);

  return { threads, failed };
}

/** "now", "4m", "3h", "2d", then a short date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let openGeneration = 0;

/**
 * Open a thread in this window.
 *
 * Clicking thread A then quickly thread B used to be able to finish A's load
 * last and paint A under B's selection. Each open takes a generation number and
 * a superseded load is dropped on arrival.
 */
export async function openThread(threadId: string, opts: { force?: boolean } = {}): Promise<void> {
  const store = useStore.getState();
  if (!opts.force && store.currentSessionId === threadId && store.messages.length > 0) {
    if (store.uiMode !== 'editor') store.setActivePanel('chat');
    return;
  }
  const generation = ++openGeneration;
  store.setThreadLoading(true);
  try {
    const [loaded, status] = await Promise.all([
      loadThread(threadId),
      fetch('/api/status').then((r) => r.json() as Promise<{ running?: Array<{ id: string }> }>).catch(() => null),
      // A cold deep link (a reload, the tray) can arrive before the list has
      // loaded, and the list is where the title and the workspace come from.
      threadMeta(threadId) ? null : refreshThreads(),
    ]);
    if (generation !== openGeneration) return;
    if (loaded.error) throw new Error(loaded.error);

    const s = useStore.getState();
    // A thread belongs to its project. Opening one from another workspace
    // brings the window along, so the file tree, the terminal and the next
    // reply all point at the code this conversation is actually about.
    const home = threadMeta(threadId)?.workspacePath;
    if (home && home !== s.workspacePath && !home.startsWith('ssh://')) s.switchWorkspace(home);
    // Wipe ALL of the previous thread's state first — a field the old thread
    // set but this one doesn't (a pending question, a worker plan, a preview
    // frame) otherwise leaks across.
    s.resetThreadState();
    s.loadMessages(loaded.messages);
    s.setAgentPlan(loaded.plan ?? []);
    if (loaded.sessionChanges && loaded.sessionChanges.length > 0) s.addDiff(loaded.sessionChanges);
    s.setCurrentSessionId(threadId);

    const meta = threadMeta(threadId);
    const session = s.sessions.find((x) => x.id === threadId);
    const type = meta?.threadType ?? session?.threadType;
    if (type === 'vibe_coding' || type === 'spec_session') s.setCurrentThreadType(type);
    s.setCurrentThreadTitle(meta ? threadTitle(meta) : session?.threadName ?? null);
    // In the editor layout the conversation already lives on the right, and
    // the left column is the file tree — do not close it to "show the chat".
    if (useStore.getState().uiMode !== 'editor') s.setActivePanel('chat');

    // `isRunning` belongs to the window; threads outlive windows (the app
    // lives in the tray). Only the backend knows whether this one is working.
    if (status?.running?.some((t) => t.id === threadId)) s.beginRun('resume');

    if (window.location.hash !== `#/thread/${threadId}`) {
      try { window.location.hash = `/thread/${threadId}`; } catch { /* cosmetic */ }
    }

    // Per-prompt revert buttons, relinked to their user messages.
    const ws = useStore.getState().workspacePath;
    if (ws) {
      fetchPromptCheckpoints(ws, threadId)
        .then((cps) => {
          if (generation !== openGeneration) return;
          const list = cps.map((c) => ({ id: c.id, prompt: c.prompt, createdAt: c.createdAt }));
          const st = useStore.getState();
          st.setPromptCheckpoints(list);
          st.linkCheckpointsToMessages(list);
        })
        .catch(() => { /* checkpoints are best-effort */ });
    }
  } catch (err) {
    console.warn('Could not open thread:', err);
  } finally {
    if (generation === openGeneration) useStore.getState().setThreadLoading(false);
  }
}

/** Leave the current thread for a clean new one. */
export function startNewThread(): void {
  const s = useStore.getState();
  s.resetThreadState();
  s.setCurrentSessionId(null);
  s.setCurrentThreadType('vibe_coding');
  s.setActivePanel('chat');
  try { window.location.hash = '/chat'; } catch { /* cosmetic */ }
}
