import { useEffect } from 'react';
import { useStore } from '../store';

/** True when running inside the Bubbly Desktop (Electron) shell. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.bubblyDesktop?.isDesktop;
}

/**
 * Wires the native desktop shell into the app:
 *  - menu navigation (File/View accelerators) switches the active panel
 *  - "Open Folder…" from the native menu updates the active workspace
 *
 * No-op in the browser, so it is always safe to call.
 */
export function useDesktop(): void {
  const setActivePanel = useStore((s) => s.setActivePanel);
  const setWorkspacePath = useStore((s) => s.setWorkspacePath);

  useEffect(() => {
    const api = window.bubblyDesktop;
    if (!api) return;

    const validPanels = ['chat', 'threads', 'files', 'specs', 'audit', 'settings', 'workspace'];

    const offNav = api.onNavigate((panel) => {
      if (validPanels.includes(panel)) {
        setActivePanel(panel as any);
      }
    });

    const offWs = api.onWorkspaceChanged((folderPath) => {
      if (folderPath) {
        setWorkspacePath(folderPath);
      }
    });

    return () => {
      offNav();
      offWs();
    };
  }, [setActivePanel, setWorkspacePath]);
}
