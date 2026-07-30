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
});
