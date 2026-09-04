import React, { useEffect } from 'react';
import { BubbleRoom } from './components/BubbleRoom/BubbleRoom';
import { BootScreen } from './components/Onboarding/BootScreen';
import { Onboarding } from './components/Onboarding/Onboarding';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { ContextMenuProvider } from './components/Shared/ContextMenu';
import { useStore } from './store';
import { fetchSettings, fetchSessions } from './hooks/useApi';
import { useTheme } from './hooks/useTheme';
import { useDesktop } from './hooks/useDesktop';
import { loadThread } from './utils/messageReconstruction';
import type { Settings, Session } from './types';

const VALID_PANELS = ['chat', 'threads', 'files', 'specs', 'audit', 'settings', 'workspace'];

/**
 * Parse the location hash into a route.
 *   #/chat                  → panel route
 *   #/thread/<sessionId>    → open a specific thread (survives refresh)
 */
function parseHash(): { panel?: string; threadId?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return {};
  const parts = raw.split('/');
  if (parts[0] === 'thread' && parts[1]) return { threadId: parts[1], panel: 'chat' };
  if (VALID_PANELS.includes(parts[0])) return { panel: parts[0] };
  return {};
}

export default function App() {
  const { setSettings, setWorkspacePath, setTheme, setActivePanel } = useStore();
  const bootState = useStore((s) => s.bootState);
  const onboardingComplete = useStore((s) => s.onboardingComplete);

  useTheme();
  useDesktop();

  // Open a thread by id: load + reconstruct its messages, set type, sync URL.
  const openThreadById = async (threadId: string) => {
    const store = useStore.getState();
    if (store.currentSessionId === threadId && store.messages.length > 0) return;
    try {
      const { messages, plan, sessionChanges, error } = await loadThread(threadId);
      if (error) throw new Error(error);
      store.clearMessages();
      store.clearDiffs();
      store.loadMessages(messages);
      // Restore persisted plan + file-change list so a refresh reopens the
      // thread exactly as it was.
      store.setAgentPlan(plan ?? []);
      if (sessionChanges && sessionChanges.length > 0) store.addDiff(sessionChanges);
      store.setCurrentSessionId(threadId);
      // Resolve the thread type from the loaded session list for a persistent badge.
      const sess = store.sessions.find((s) => s.id === threadId);
      if (sess?.threadType) store.setCurrentThreadType(sess.threadType);
      store.setActivePanel('chat');

      /*
       * IS THIS THREAD ACTUALLY RUNNING RIGHT NOW?
       *
       * `isRunning` is a property of the window, not of the thread, and threads
       * outlive the window looking at them: with the app living in the system
       * tray, a turn started an hour ago may still be going. Opening it without
       * asking got it wrong in both directions — a running thread showed a Send
       * button whose message the server would refuse, and a thread opened after
       * a different one had been running showed a Stop button for a run that
       * was not happening here.
       *
       * `activeSessions` on the backend is the only truth about this, and
       * /api/status is how it is asked. Failing quietly leaves the composer
       * usable, which is the safer of the two wrong answers.
       */
      try {
        const status = await fetch('/api/status').then((r) => r.json()) as {
          running?: Array<{ id: string }>;
        };
        const live = (status.running ?? []).some((t) => t.id === threadId);
        store.setIsRunning(live);
        if (live) store.beginRun('resume');
        else store.stopRunTimer();
      } catch {
        store.setIsRunning(false);
      }
    } catch (err) {
      console.warn('Could not open thread from URL:', err);
    }
  };

  /*
   * A thread picked from the system-tray menu.
   *
   * The tray is the only place that can name a running thread while no window
   * is showing it, so this is how "that build I started an hour ago" gets back
   * on screen. Routed through the hash so it behaves like every other way of
   * opening a thread — back/forward keep working, and a second tray click on
   * the thread already open is a no-op rather than a reload.
   */
  useEffect(() => {
    const off = window.bubblyDesktop?.onOpenThread?.((sessionId) => {
      if (!sessionId) return;
      try { window.location.hash = `/thread/${sessionId}`; } catch { /* ignore */ }
      void openThreadById(sessionId);
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Routing: react to hash changes (back/forward) and set initial route.
  useEffect(() => {
    const apply = () => {
      const { panel, threadId } = parseHash();
      if (threadId) {
        openThreadById(threadId);
      } else if (panel) {
        setActivePanel(panel as any);
      }
    };
    if (!window.location.hash) {
      // Seed the URL: if we have a persisted session, deep-link to it.
      const sid = useStore.getState().currentSessionId;
      window.location.hash = sid ? `/thread/${sid}` : `/${useStore.getState().activePanel}`;
    }
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load settings + sessions on startup, then restore any persisted thread.
  useEffect(() => {
    let settingsDone = false;
    let sessionsDone = false;
    const markReady = () => {
      if (settingsDone && sessionsDone) useStore.getState().setBootState('ready');
    };

    fetchSettings()
      .then((s: Settings) => {
        setSettings(s);
        if (s.workspacePath) setWorkspacePath(s.workspacePath);
        if (s.theme) setTheme(s.theme);
        // Don't show onboarding to users who already have a working setup
        // (provider configured + workspace chosen) but predate the flag.
        const store = useStore.getState();
        if (!store.onboardingComplete) {
          const hasProvider = !!(s.anthropicApiKey || s.geminiApiKey || (s.defaultProvider === 'ollama' && s.ollamaModel));
          if (hasProvider && s.workspacePath) store.setOnboardingComplete(true);
        }
      })
      .catch((err) => console.warn('Could not load settings from backend:', err))
      .finally(() => { settingsDone = true; markReady(); });

    fetchSessions()
      .then((sessions: Session[]) => {
        if (Array.isArray(sessions)) {
          useStore.getState().setSessions(sessions);
          // Now that sessions are known, restore the thread from the URL/persisted id.
          const { threadId } = parseHash();
          const persistedId = useStore.getState().currentSessionId;
          const idToOpen = threadId || persistedId;
          if (idToOpen) openThreadById(idToOpen);
        }
      })
      .catch(() => { /* non-critical */ })
      .finally(() => { sessionsDone = true; markReady(); });

    // Safety net: never get stuck on the boot screen if a request hangs.
    const t = setTimeout(() => useStore.getState().setBootState('ready'), 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSettings, setWorkspacePath, setTheme]);

  if (bootState === 'loading') {
    return <BootScreen />;
  }

  return (
    <ErrorBoundary label="the app">
      <ContextMenuProvider>
        <BubbleRoom />
        {!onboardingComplete && <Onboarding />}
      </ContextMenuProvider>
    </ErrorBoundary>
  );
}
