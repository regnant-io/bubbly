'use strict';

/**
 * Preload bridge for Bubbly Desktop.
 *
 * Exposes a small, safe API on `window.bubblyDesktop` so the React app can:
 *  - detect that it is running inside the desktop shell
 *  - open the native folder picker
 *  - react to native menu navigation and workspace changes
 *
 * contextIsolation is on and nodeIntegration is off, so nothing else from
 * Node/Electron leaks into the page.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubblyDesktop', {
  isDesktop: true,

  /** Open the OS folder picker; returns the chosen path or null. */
  pickFolder: () => ipcRenderer.invoke('bubbly:pick-folder'),

  /** Get runtime info (platform, version, backend port). */
  getInfo: () => ipcRenderer.invoke('bubbly:get-info'),

  /** Run a native menu action (reload, devtools, logs, about, quit, …). */
  menuAction: (action) => ipcRenderer.invoke('bubbly:menu-action', action),

  /** Recolor the native window-control overlay to match the app theme. */
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('bubbly:set-titlebar-overlay', opts),

  /** Open a URL in the user's default external browser. */
  openExternal: (url) => ipcRenderer.invoke('bubbly:open-external', url),

  /**
   * Empty the preview webview's HTTP cache before a reload.
   *
   * The preview runs in its own in-memory session, which is exactly why it can
   * hold a stale bundle from a dev server that has since rebuilt — a plain
   * reload revalidates and is told 304. This makes "reload" mean "fetch it
   * again", which is the only thing anyone means by it in a preview.
   */
  clearPreviewCache: () => ipcRenderer.invoke('bubbly:clear-preview-cache'),

  /** Open a specific thread — sent when a thread is picked from the tray. */
  onOpenThread: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('bubbly:open-thread', handler);
    return () => ipcRenderer.removeListener('bubbly:open-thread', handler);
  },

  /**
   * Show a native OS notification. The main process suppresses it when the
   * window already has focus (pass `force` to override, e.g. a settings test).
   * Resolves to { shown, reason }.
   */
  notify: (opts) => ipcRenderer.invoke('bubbly:notify', opts),

  /** Whether the app window currently has OS focus. */
  isWindowFocused: () => ipcRenderer.invoke('bubbly:is-focused'),

  /** Subscribe to window focus/blur, to know when the user switched away. */
  onFocusChanged: (callback) => {
    const handler = (_event, focused) => callback(!!focused);
    ipcRenderer.on('bubbly:focus-changed', handler);
    return () => ipcRenderer.removeListener('bubbly:focus-changed', handler);
  },

  /** Subscribe to "navigate to panel" events from the native menu. */
  onNavigate: (callback) => {
    const handler = (_event, panel) => callback(panel);
    ipcRenderer.on('bubbly:navigate', handler);
    return () => ipcRenderer.removeListener('bubbly:navigate', handler);
  },

  /** Subscribe to workspace-folder changes triggered from the native menu. */
  onWorkspaceChanged: (callback) => {
    const handler = (_event, folderPath) => callback(folderPath);
    ipcRenderer.on('bubbly:workspace-changed', handler);
    return () => ipcRenderer.removeListener('bubbly:workspace-changed', handler);
  },

  /**
   * This window was opened fresh — from "Open with Bubbly", or New Window.
   *
   * The renderer persists a good deal of per-thread state so a reload does not
   * lose your place, and that is exactly wrong here: a window opened on a folder
   * from the file manager must not restore someone else's half-finished
   * conversation and point it at unfamiliar code.
   */
  onNewWindow: (callback) => {
    const handler = (_event, payload) => callback(payload ?? {});
    ipcRenderer.on('bubbly:new-window', handler);
    return () => ipcRenderer.removeListener('bubbly:new-window', handler);
  },
});
