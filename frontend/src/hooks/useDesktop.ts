import { useEffect } from 'react';
import { useStore } from '../store';
import { initNotificationFocusTracking } from '../utils/notifications';

/** True when running inside the Bubbly Desktop (Electron) shell. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.bubblyDesktop?.isDesktop;
}

/**
 * Wires the native desktop shell into the app:
 *  - menu navigation (File/View accelerators) switches the active panel
 *  - "Open Folder…" from the native menu updates the active workspace
 *  - window focus tracking, so notifications only fire when you've switched away
 *
 * No-op in the browser, so it is always safe to call.
 */
export function useDesktop(): void {
  const setActivePanel = useStore((s) => s.setActivePanel);
  const setWorkspacePath = useStore((s) => s.setWorkspacePath);
  const switchWorkspace = useStore((s) => s.switchWorkspace);

  useEffect(() => {
    const api = window.bubblyDesktop;
    if (!api) return;

    const offFocus = initNotificationFocusTracking();

    const validPanels = ['chat', 'threads', 'files', 'specs', 'audit', 'settings', 'workspace'];

    const offNav = api.onNavigate((panel) => {
      if (validPanels.includes(panel)) {
        setActivePanel(panel as any);
      }
    });

    const offWs = api.onWorkspaceChanged((folderPath) => {
      if (folderPath) {
        switchWorkspace(folderPath);
      }
    });

    /*
     * A window opened fresh — "Open with Bubbly" on a folder, or New Window.
     *
     * Persisted state is restored on load so a reload does not lose your place,
     * and that is precisely the wrong behaviour here: this window is a NEW
     * context, and restoring the last thread would point a half-finished
     * conversation at code it has never seen. Everything per-thread is cleared
     * before the first render the user sees.
     */
    const offNew = api.onNewWindow?.(({ workspace }) => {
      const store = useStore.getState();
      store.resetThreadState();
      store.setCurrentSessionId(null);
      store.setActivePanel('chat');
      if (workspace) store.switchWorkspace(workspace);
      try { window.location.hash = ''; } catch { /* a hash we cannot clear is cosmetic */ }
    });

    return () => {
      offNav();
      offWs();
      offNew?.();
      offFocus();
    };
  }, [setActivePanel, setWorkspacePath, switchWorkspace]);
}
