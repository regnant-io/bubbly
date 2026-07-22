'use strict';

/**
 * Bubbly Desktop — Electron main process.
 *
 * Responsibilities:
 *  - Boot the compiled Bubbly backend as a child process on a free port.
 *  - Wait for the backend's machine-readable ready signal, then load the UI
 *    it serves (same origin → REST + WebSocket just work).
 *  - Provide a native window, application menus, and OS folder picking.
 *  - Manage a clean lifecycle: single instance, graceful shutdown.
 *
 * The backend is spawned with the *system* Node runtime (not Electron's), so
 * the native better-sqlite3 module keeps working without an Electron rebuild.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const isDev = !app.isPackaged;
const DEV_WORKSPACE_ROOT = path.join(__dirname, '..');

/** Resolve filesystem locations for both dev and packaged layouts. */
function resolvePaths() {
  if (isDev) {
    return {
      backendEntry: path.join(DEV_WORKSPACE_ROOT, 'backend', 'dist', 'index.js'),
      backendCwd: path.join(DEV_WORKSPACE_ROOT, 'backend'),
      frontendDist: path.join(DEV_WORKSPACE_ROOT, 'frontend', 'dist'),
    };
  }
  const res = process.resourcesPath;
  return {
    backendEntry: path.join(res, 'backend', 'dist', 'index.js'),
    backendCwd: path.join(res, 'backend'),
    frontendDist: path.join(res, 'frontend', 'dist'),
  };
}

const PATHS = resolvePaths();

let mainWindow = null;
let backendProc = null;
let backendPort = null;
let isQuitting = false;

// Main-process safety net: a stray exception in an event handler used to take
// the whole app down (appearing as a crash when "running a project"). Log and
// keep running instead.
process.on('uncaughtException', (err) => {
  try { log('Uncaught exception in main process:', err && err.stack ? err.stack : String(err)); } catch (_e) { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try { log('Unhandled rejection in main process:', String(reason)); } catch (_e) { /* ignore */ }
});

/** Per-app log directory under the user's home (~/.bubbly/desktop-logs). */
const LOG_DIR = path.join(os.homedir(), '.bubbly', 'desktop-logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* ignore */
}
const desktopLog = fs.createWriteStream(path.join(LOG_DIR, 'desktop.log'), { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    desktopLog.write(line + '\n');
  } catch {
    /* ignore */
  }
}

/**
 * Locate the system Node executable. The backend depends on a native module
 * (better-sqlite3) built for the system Node ABI, so we must not run it under
 * Electron's bundled Node.
 */
function findNodeExecutable() {
  if (process.env.BUBBLY_NODE_PATH && fs.existsSync(process.env.BUBBLY_NODE_PATH)) {
    return process.env.BUBBLY_NODE_PATH;
  }
  const candidates = [];
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', ['node'], { encoding: 'utf8' });
      out.split(/\r?\n/).forEach((l) => l.trim() && candidates.push(l.trim()));
    } else {
      const out = execFileSync('which', ['node'], { encoding: 'utf8' });
      out.split(/\r?\n/).forEach((l) => l.trim() && candidates.push(l.trim()));
    }
  } catch {
    /* fall through to defaults */
  }
  // Common install locations as a fallback.
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe')
    );
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Poll the backend health endpoint until it responds or we time out. */
function waitForHealth(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
        (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
          } else {
            res.resume();
            retry();
          }
        }
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Backend health check timed out'));
      } else {
        setTimeout(attempt, 300);
      }
    };
    attempt();
  });
}

/** Spawn the backend and resolve with the actual port it bound to. */
function startBackend() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PATHS.backendEntry)) {
      reject(
        new Error(
          `Backend not built. Expected: ${PATHS.backendEntry}\n` +
            `Run "npm run build" in the backend folder first.`
        )
      );
      return;
    }

    const nodeExe = findNodeExecutable();
    if (!nodeExe) {
      reject(
        new Error(
          'Could not find Node.js. Install Node 18+ from https://nodejs.org and ensure it is on your PATH.'
        )
      );
      return;
    }

    log('Starting backend with node:', nodeExe);
    log('Backend entry:', PATHS.backendEntry);

    const env = {
      ...process.env,
      // FIXED, deterministic port for the desktop build (was '0' = random). The
      // desktop shell serves everything from this one backend port, so a stable
      // value means the app always lives at the same localhost address. If it's
      // occupied the backend deterministically steps to the next port (see
      // index.ts) and reports the real one back — never a random port. Override
      // with BUBBLY_DESKTOP_PORT if 4620 clashes on a given machine.
      PORT: process.env.BUBBLY_DESKTOP_PORT || '4620',
      NODE_ENV: isDev ? 'development' : 'production',
      BUBBLY_FRONTEND_DIST: PATHS.frontendDist,
      BUBBLY_LOG_DIR: path.join(os.homedir(), '.bubbly', 'logs'),
      // Tell the backend it's running under the Electron shell (spawned with no
      // attached console). node-pty's ConPTY backend calls AttachConsole, which
      // fails in this context and crashes the shell with 0xC0000142. The backend
      // uses this hint to pick a console-independent terminal backend.
      BUBBLY_ELECTRON: '1',
    };

    const child = spawn(nodeExe, [PATHS.backendEntry], {
      cwd: PATHS.backendCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    backendProc = child;
    let settled = false;

    const onReady = (port) => {
      if (settled) return;
      settled = true;
      backendPort = port;
      log('Backend reported ready on port', port);
      waitForHealth(port)
        .then(() => resolve(port))
        .catch(reject);
    };

    // Preferred path: structured IPC message from the backend.
    child.on('message', (msg) => {
      if (msg && msg.type === 'bubbly-ready' && typeof msg.port === 'number') {
        onReady(msg.port);
      }
    });

    // Fallback: parse the BUBBLY_READY line from stdout.
    child.stdout.on('data', (data) => {
      const text = data.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (line.includes('BUBBLY_READY')) {
          const m = line.match(/BUBBLY_READY\s+(\{.*\})/);
          if (m) {
            try {
              const parsed = JSON.parse(m[1]);
              if (typeof parsed.port === 'number') onReady(parsed.port);
            } catch {
              /* ignore parse errors */
            }
          }
        }
      });
      log('[backend]', text.trimEnd());
    });

    child.stderr.on('data', (data) => {
      log('[backend:err]', data.toString().trimEnd());
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      log(`Backend exited (code=${code}, signal=${signal})`);
      backendProc = null;
      if (!settled) {
        settled = true;
        reject(new Error(`Backend exited before becoming ready (code ${code})`));
      } else if (!isQuitting) {
        // Unexpected crash while running — try to recover transparently instead
        // of forcing the user to restart the whole app.
        log('Backend crashed while running — attempting restart');
        restartBackend();
      }
    });
  });
}

function stopBackend() {
  if (backendProc) {
    log('Stopping backend...');
    const proc = backendProc;
    backendProc = null;
    try {
      // The backend spawns child processes (dev servers, build watchers, the
      // agent's run_command/background processes). Killing only the backend PID
      // would orphan that whole tree — a common cause of "the app closed but my
      // dev server is still holding the port". On Windows, taskkill /t kills the
      // entire tree; elsewhere we send SIGTERM then SIGKILL.
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true }); }
        catch { proc.kill(); }
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restart the backend after an unexpected crash, reusing the same window. This
 * turns a single backend hiccup (which used to force-quit the whole app) into a
 * transparent recovery. Bounded so a persistently-broken backend doesn't loop.
 */
let backendRestarts = 0;
const MAX_BACKEND_RESTARTS = 3;
async function restartBackend() {
  if (isQuitting) return;
  if (backendRestarts >= MAX_BACKEND_RESTARTS) {
    dialog.showErrorBox(
      'Bubbly backend stopped',
      'The Bubbly backend exited repeatedly and could not be recovered. Please restart the app, and check the logs (Help → View Logs).'
    );
    return;
  }
  backendRestarts++;
  log(`Restarting backend (attempt ${backendRestarts}/${MAX_BACKEND_RESTARTS})…`);
  try {
    const port = await startBackend();
    if (mainWindow) {
      mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    }
    setTimeout(() => { backendRestarts = 0; }, 30000);
  } catch (err) {
    log('Backend restart failed:', err && err.stack ? err.stack : String(err));
    setTimeout(restartBackend, 1500);
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1a1614',
    show: false,
    title: 'Bubbly',
    // Clean, frameless-style chrome: hide the OS title bar but keep the native
    // window controls (min/max/close) via an overlay, so we get a seamless look
    // without having to build custom controls. The app's own top strip acts as
    // the drag region (see the renderer's -webkit-app-region styling).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // Transparent overlay background so the min/max/close buttons blend into
      // whatever sits behind them (the app's own title strip). Only the symbols
      // are tinted to stay legible against the theme.
      color: 'rgba(0,0,0,0)',
      symbolColor: '#e8dfce',
      height: 36,
    },
    autoHideMenuBar: true,
    // On Windows use the multi-resolution .ico so the taskbar/window icon
    // renders crisply at every size (a lone 256px frame makes Windows fall
    // back to a generic icon); other platforms use the PNG.
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable <webview> so the Bubbly Preview panel can embed a live browser.
      webviewTag: true,
      // Keep timers/paints running when the OS window loses focus, so the agent
      // can still drive + screenshot the preview webview after the user switches
      // to another window and back (otherwise capturePage/executeJavaScript can
      // stall on an unpainted, throttled renderer).
      backgroundThrottling: false,
    },
  });

  // Hide the application menu bar entirely for a cleaner, modern look. Menu
  // actions remain available via shortcuts; the in-app UI covers navigation.
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const sameOrigin = url.startsWith(`http://localhost:${port}`) || url.startsWith(`http://127.0.0.1:${port}`);
      if (!sameOrigin) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // "Not responding" hardening. Electron flags a window unresponsive if the
  // main thread is briefly busy (large diffs, big file loads). That does NOT
  // mean it crashed — so we log it and wait, rather than letting the OS prompt
  // the user to kill a healthy app.
  mainWindow.on('unresponsive', () => {
    log('Renderer reported unresponsive (likely a busy main thread) — waiting for it to recover.');
  });
  mainWindow.on('responsive', () => {
    log('Renderer responsive again.');
  });

  // If the renderer process actually dies (OOM, GPU fault), reload it instead
  // of leaving a blank/frozen window.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('Render process gone:', details.reason);
    if (!isQuitting && details.reason !== 'clean-exit' && backendPort) {
      try { mainWindow.reload(); } catch { /* ignore */ }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    log('webContents unresponsive — not killing; awaiting recovery.');
  });

  if (isDev || process.env.BUBBLY_DESKTOP_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Open the native folder picker and return the selected absolute path. */
async function pickWorkspaceFolder() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project Folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/**
 * Extract a folder path from process arguments. Used by the "Open with Bubbly"
 * shell integration: Explorer launches `Bubbly.exe "C:\path\to\folder"`, so we
 * scan the args for the first token that resolves to an existing directory.
 * Ignores flags and the electron/exe + script entries.
 */
function folderFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  // In packaged builds argv[0] is the exe; in dev argv[0]=electron, argv[1]=main.js.
  const candidates = argv.slice(isDev ? 2 : 1);
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string' || raw.startsWith('-')) continue;
    try {
      const resolved = path.resolve(raw);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch { /* not a path — keep scanning */ }
  }
  return null;
}

/** Persist the chosen workspace to backend settings and notify the renderer. */
async function applyWorkspace(folderPath) {
  if (!folderPath || !backendPort) return;
  try {
    await fetch(`http://127.0.0.1:${backendPort}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: folderPath }),
    });
  } catch (err) {
    log('Failed to persist workspace path:', String(err));
  }
  if (mainWindow) {
    mainWindow.webContents.send('bubbly:workspace-changed', folderPath);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const folder = await pickWorkspaceFolder();
            if (folder) await applyWorkspace(folder);
          },
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('bubbly:navigate', 'settings');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Chat',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow && mainWindow.webContents.send('bubbly:navigate', 'chat'),
        },
        {
          label: 'Threads',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow && mainWindow.webContents.send('bubbly:navigate', 'threads'),
        },
        {
          label: 'Files',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow && mainWindow.webContents.send('bubbly:navigate', 'files'),
        },
        {
          label: 'Specs',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow && mainWindow.webContents.send('bubbly:navigate', 'specs'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Bubbly on the Web',
          click: () => shell.openExternal('https://github.com'),
        },
        {
          label: 'View Logs',
          click: () => shell.openPath(LOG_DIR),
        },
        {
          label: 'About Bubbly',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Bubbly',
              message: 'Bubbly',
              detail:
                'A local-first AI coding agent, now as a native desktop IDE.\n\n' +
                `Version ${app.getVersion()}\n` +
                `Backend port: ${backendPort ?? 'n/a'}\n` +
                `Electron ${process.versions.electron}, Node ${process.versions.node}`,
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC handlers exposed to the renderer through preload.
ipcMain.handle('bubbly:pick-folder', async () => {
  const folder = await pickWorkspaceFolder();
  if (folder) await applyWorkspace(folder);
  return folder;
});

ipcMain.handle('bubbly:get-info', () => ({
  isDesktop: true,
  platform: process.platform,
  version: app.getVersion(),
  port: backendPort,
}));

/**
 * Recolor the native window-control overlay (min/max/close) so it matches the
 * current app theme instead of a hardcoded dark strip. Called by the renderer
 * whenever the resolved theme changes. No-op where the overlay isn't supported.
 */
ipcMain.handle('bubbly:set-titlebar-overlay', (_event, opts) => {
  if (!mainWindow || typeof mainWindow.setTitleBarOverlay !== 'function') return false;
  try {
    // Keep the overlay background transparent; only the symbol color tracks the theme.
    const color = typeof opts?.color === 'string' ? opts.color : 'rgba(0,0,0,0)';
    const symbolColor = typeof opts?.symbolColor === 'string' ? opts.symbolColor : '#e6e1dc';
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: 36 });
    return true;
  } catch {
    return false;
  }
});

/** Open a URL in the user's default browser (only http/https, for safety). */
ipcMain.handle('bubbly:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

/**
 * Run a native menu action requested from the in-app custom title bar (File /
 * View / Help dropdowns). Keeps native behaviors (reload, devtools, zoom, open
 * folder, logs, about, quit) working even though the OS menu bar is hidden.
 */
ipcMain.handle('bubbly:menu-action', async (_event, action) => {
  const wc = mainWindow && mainWindow.webContents;
  switch (action) {
    case 'open-folder': {
      const folder = await pickWorkspaceFolder();
      if (folder) await applyWorkspace(folder);
      return folder ?? null;
    }
    case 'reload': wc && wc.reload(); break;
    case 'force-reload': wc && wc.reloadIgnoringCache(); break;
    case 'toggle-devtools': wc && wc.toggleDevTools(); break;
    case 'zoom-in': wc && wc.setZoomLevel(wc.getZoomLevel() + 0.5); break;
    case 'zoom-out': wc && wc.setZoomLevel(wc.getZoomLevel() - 0.5); break;
    case 'zoom-reset': wc && wc.setZoomLevel(0); break;
    case 'toggle-fullscreen':
      if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
      break;
    case 'minimize': mainWindow && mainWindow.minimize(); break;
    case 'view-logs': shell.openPath(LOG_DIR); break;
    case 'open-web': shell.openExternal('https://github.com'); break;
    case 'about':
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'About Bubbly',
          message: 'Bubbly',
          detail:
            'A local-first AI coding agent, now as a native desktop IDE.\n\n' +
            `Version ${app.getVersion()}\n` +
            `Backend port: ${backendPort ?? 'n/a'}\n` +
            `Electron ${process.versions.electron}, Node ${process.versions.node}`,
          buttons: ['OK'],
        });
      }
      break;
    case 'quit': isQuitting = true; app.quit(); break;
    default: break;
  }
  return true;
});

// Single-instance lock: focus the existing window instead of starting twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // "Open with Bubbly" on a folder while Bubbly is already running: switch the
    // existing window to that workspace instead of launching a second instance.
    const folder = folderFromArgv(argv);
    if (folder) applyWorkspace(folder);
  });

  // Flaky GPU drivers (common on Windows) can crash Electron's GPU process and
  // make the window look frozen / "not responding". Log and continue on
  // software rendering rather than letting it take the app down.
  app.on('child-process-gone', (_e, details) => {
    log('Child process gone:', details.type, details.reason);
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      const port = await startBackend();
      createWindow(port);
      // "Open with Bubbly" on a folder from a cold start: apply it as the
      // workspace once the renderer has loaded.
      const initialFolder = folderFromArgv(process.argv);
      if (initialFolder && mainWindow) {
        mainWindow.webContents.once('did-finish-load', () => { void applyWorkspace(initialFolder); });
      }
    } catch (err) {
      log('Startup failed:', err && err.stack ? err.stack : String(err));
      dialog.showErrorBox(
        'Bubbly failed to start',
        (err && err.message ? err.message : String(err)) +
          '\n\nMake sure Node.js 18+ is installed and the backend is built.'
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
        createWindow(backendPort);
      }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackend();
  });

  app.on('window-all-closed', () => {
    stopBackend();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  process.on('exit', stopBackend);
}
