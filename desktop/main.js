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

const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, dialog, ipcMain, shell, safeStorage } = require('electron');
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

/**
 * Every open Bubbly window.
 *
 * There used to be exactly one, held in `mainWindow`, and the whole shell was
 * written against that assumption — which made "Open with Bubbly" on a second
 * folder REPLACE the workspace of the window you were working in. You would
 * right-click a project, and the project you already had open would silently
 * become a different one, taking its thread with it.
 *
 * Windows are now a set. `mainWindow` remains as "the window a global action
 * should target", kept pointing at the most recently focused one, so the many
 * existing call sites (notifications, the menu, the backend restart path) keep
 * working without each needing to answer "which window" for itself.
 */
const windows = new Set();
let mainWindow = null;
let backendProc = null;
let backendPort = null;
let isQuitting = false;

/**
 * THE TRAY, AND WHY CLOSING A WINDOW NO LONGER STOPS THE WORK.
 *
 * Bubbly's agent runs turns that outlive a glance at the screen: a build that
 * takes six minutes, an install, a detached watcher that will wake its thread
 * at some point in the next half hour. Tying all of that to a window meant the
 * most ordinary gesture on a desktop — closing the window you are done looking
 * at — killed work that was mid-flight, silently, with no way to get it back.
 *
 * So the window is a VIEW and the app is a SERVICE. Closing a window hides it;
 * the backend, its threads, its background processes and its watchers all keep
 * running. Quitting is a deliberate act from the tray (or Cmd/Ctrl-Q), and it
 * is the only thing that stops them.
 *
 * The tray menu is rebuilt from /api/status, so it is not decoration: it says
 * how many threads are actually working right now and lets you open one.
 */
let tray = null;
let trayRefreshTimer = null;
let toldUserAboutTray = false;
/** Latest /api/status snapshot, for the tray menu. */
let trayStatus = { running: [], backgroundProcesses: [], watchers: 0 };

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

/**
 * The credential vault's master key, protected by the OS keychain.
 *
 * The backend runs as a separate process and cannot reach Electron's
 * `safeStorage` — but the desktop shell can, and safeStorage is backed by the
 * real platform keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux). So the shell owns the key: it generates one on
 * first run, stores the ENCRYPTED form on disk, and hands the plaintext to the
 * backend in its environment at spawn time.
 *
 * That means the key at rest is protected by the operating system, and the
 * plaintext exists only in the memory of two processes the user already
 * controls. Without this the backend falls back to a key file, which protects
 * against another account on the machine but not against someone with the
 * user's own read access.
 *
 * Returns null when the platform has no usable keychain — the backend then uses
 * its file fallback and says so in Settings, rather than silently pretending to
 * be better protected than it is.
 */
function vaultKey() {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;

    const keyPath = path.join(os.homedir(), '.bubbly', 'vault.masterkey');
    if (fs.existsSync(keyPath)) {
      const decrypted = safeStorage.decryptString(fs.readFileSync(keyPath));
      if (decrypted && decrypted.length >= 40) return decrypted;
      log('Stored master key looks wrong; generating a new one.');
    }

    const key = require('crypto').randomBytes(32).toString('base64');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 });
    log('Created a keychain-protected vault key.');
    return key;
  } catch (err) {
    // A keychain that refuses to co-operate must not stop the app from starting.
    log('Could not use the OS keychain for the vault key:', String(err));
    return null;
  }
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
      // The vault's master key, protected at rest by the OS keychain. See
      // vaultKey() for why the desktop shell is the right place to hold it.
      BUBBLY_VAULT_KEY: vaultKey() || undefined,
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


/* -------------------------------------------------------------------------
 * The tray
 * ---------------------------------------------------------------------- */

/** Ask the backend what is actually running. Cheap, local, and never fatal. */
function fetchStatus() {
  return new Promise((resolve) => {
    if (!backendPort) return resolve(null);
    const req = http.get(
      { host: '127.0.0.1', port: backendPort, path: '/api/status', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** A window to act on: the focused one, else any hidden one, else a new one. */
function surfaceWindow(options = {}) {
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : [...windows][0];
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  if (backendPort) return createWindow(backendPort, options);
  return null;
}

function buildTrayMenu() {
  const running = Array.isArray(trayStatus.running) ? trayStatus.running : [];
  const procs = Array.isArray(trayStatus.backgroundProcesses) ? trayStatus.backgroundProcesses : [];

  const items = [
    { label: running.length === 0 ? 'Nothing running' : `${running.length} thread${running.length === 1 ? '' : 's'} working`, enabled: false },
  ];

  /*
   * Naming the threads is the whole point. "1 thread working" tells you the app
   * is busy; "Refactor the auth middleware" tells you WHICH piece of work is
   * still going, which is what you actually want to know before you quit.
   */
  for (const t of running.slice(0, 8)) {
    items.push({
      label: `   ${t.title}${t.queued ? `  (${t.queued} queued)` : ''}`,
      click: () => {
        const win = surfaceWindow();
        if (win) win.webContents.send('bubbly:open-thread', t.id);
      },
    });
  }

  if (procs.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: `${procs.length} background process${procs.length === 1 ? '' : 'es'}`, enabled: false });
    for (const p of procs.slice(0, 5)) {
      const label = p.url ? `   ${p.command} — ${p.url}` : `   ${p.command}`;
      items.push({
        label: label.length > 64 ? `${label.slice(0, 63)}…` : label,
        click: () => { if (p.url) shell.openExternal(p.url); else surfaceWindow(); },
      });
    }
  }

  items.push(
    { type: 'separator' },
    { label: 'Open Bubbly', click: () => surfaceWindow() },
    { label: 'New window', click: () => { if (backendPort) createWindow(backendPort, { freshThread: true }); } },
    { type: 'separator' },
    {
      // The ONLY way out. Spelled with what it costs, because quitting with a
      // build half-finished should be a decision rather than a reflex.
      label: running.length > 0
        ? `Quit Bubbly (stops ${running.length} running thread${running.length === 1 ? '' : 's'})`
        : 'Quit Bubbly',
      click: () => { isQuitting = true; app.quit(); },
    },
  );

  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const running = Array.isArray(trayStatus.running) ? trayStatus.running : [];
  tray.setToolTip(running.length > 0 ? `Bubbly — ${running.length} thread${running.length === 1 ? '' : 's'} working` : 'Bubbly');
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray) return tray;
  try {
    const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      log('Tray icon missing at', iconPath, '— tray not created');
      return null;
    }
    // macOS wants a small template image; Windows/Linux want a real 16px icon.
    if (process.platform === 'darwin') {
      image = image.resize({ width: 16, height: 16 });
      image.setTemplateImage(true);
    }
    tray = new Tray(image);
    tray.setToolTip('Bubbly');
    tray.setContextMenu(buildTrayMenu());
    // Left-click is "show me the app" on every platform people expect it on.
    tray.on('click', () => surfaceWindow());
    tray.on('double-click', () => surfaceWindow());

    // Poll rather than push: the tray has no socket, the call is a localhost
    // GET, and eight seconds is well inside "did that finish yet?" patience.
    const tick = async () => {
      const status = await fetchStatus();
      if (status) { trayStatus = status; refreshTray(); }
    };
    void tick();
    trayRefreshTimer = setInterval(tick, 8000);
    if (typeof trayRefreshTimer.unref === 'function') trayRefreshTimer.unref();
    log('Tray created');
    return tray;
  } catch (err) {
    log('Could not create the tray:', err && err.message ? err.message : String(err));
    return null;
  }
}

/**
 * Tell the user, ONCE, that closing the window did not close the app.
 *
 * An app that keeps running after you closed its window is a reasonable
 * design and a nasty surprise. Saying so the first time it happens is the
 * difference between the two.
 */
function announceTrayOnce() {
  if (toldUserAboutTray) return;
  toldUserAboutTray = true;
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Bubbly is still running',
      body: 'Your threads keep working in the background. Quit from the tray icon when you are done.',
      silent: true,
    }).show();
  } catch { /* a missing notification must never block a close */ }
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

/**
 * Open a window.
 *
 * `options.workspace` opens it directly on a folder, and `options.freshThread`
 * asks the renderer to start with a clean slate rather than restoring whatever
 * thread was last open. Both matter for "Open with Bubbly": a folder opened
 * from the file manager should be a NEW window showing a NEW conversation, not
 * someone else's half-finished thread pointed at unfamiliar code.
 */
function createWindow(port, options = {}) {
  const win = new BrowserWindow({
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
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Open external links in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const sameOrigin = url.startsWith(`http://localhost:${port}`) || url.startsWith(`http://127.0.0.1:${port}`);
      if (!sameOrigin) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  win.loadURL(`http://127.0.0.1:${port}/`);

  // "Not responding" hardening. Electron flags a window unresponsive if the
  // main thread is briefly busy (large diffs, big file loads). That does NOT
  // mean it crashed — so we log it and wait, rather than letting the OS prompt
  // the user to kill a healthy app.
  win.on('unresponsive', () => {
    log('Renderer reported unresponsive (likely a busy main thread) — waiting for it to recover.');
  });
  win.on('responsive', () => {
    log('Renderer responsive again.');
  });

  // If the renderer process actually dies (OOM, GPU fault), reload it instead
  // of leaving a blank/frozen window.
  win.webContents.on('render-process-gone', (_e, details) => {
    log('Render process gone:', details.reason);
    if (!isQuitting && details.reason !== 'clean-exit' && backendPort) {
      try { win.reload(); } catch { /* ignore */ }
    }
  });

  win.webContents.on('unresponsive', () => {
    log('webContents unresponsive — not killing; awaiting recovery.');
  });

  if (isDev || process.env.BUBBLY_DESKTOP_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Tell the renderer when the app gains/loses OS focus, so it knows whether
  // the user has switched away and a run-finished toast is warranted.
  const sendFocus = (focused) => {
    if (focused) {
      try { win.flashFrame(false); } catch { /* ignore */ }
    }
    try { win.webContents.send('bubbly:focus-changed', focused); } catch { /* ignore */ }
  };
  win.on('focus', () => sendFocus(true));
  win.on('blur', () => sendFocus(false));

  /*
   * CLOSING A WINDOW HIDES IT.
   *
   * The work behind the window — a turn in flight, a dev server, a detached
   * watcher due to fire in twenty minutes — belongs to the backend, not to this
   * BrowserWindow. Destroying the window used to take all of it down with the
   * app, so "I'm done looking at this" and "abandon everything you were doing"
   * were the same gesture. They are now different: close hides, the tray quits.
   *
   * The LAST window is the only one worth being careful about, because that is
   * where "closed" and "quit" feel identical. It is hidden with a one-time
   * notification; every other window is genuinely destroyed, since a second
   * window is a view and nothing else.
   */
  win.on('close', (event) => {
    if (isQuitting) return;
    const visible = [...windows].filter((w) => !w.isDestroyed() && w.isVisible());
    if (visible.length > 1) return; // let this one really close
    if (!tray) return;              // no tray (icon missing) → behave normally
    event.preventDefault();
    win.hide();
    announceTrayOnce();
    refreshTray();
  });

  win.on('closed', () => {
    windows.delete(win);
    // Keep the "global action target" pointing at a window that still exists.
    if (mainWindow === win) mainWindow = windows.values().next().value ?? null;
  });

  // The most recently focused window is the one a global action means.
  win.on('focus', () => { mainWindow = win; });

  windows.add(win);
  mainWindow = win;

  // Tell the renderer what this window is FOR, before it decides what to show.
  // A window opened on a folder from the file manager must start on a CLEAN
  // thread: restoring the last conversation would point someone else's
  // half-finished work at unfamiliar code.
  win.webContents.once('did-finish-load', () => {
    if (options.freshThread) {
      try { win.webContents.send('bubbly:new-window', { workspace: options.workspace ?? null }); } catch { /* ignore */ }
    }
    if (options.workspace) {
      try { win.webContents.send('bubbly:workspace-changed', options.workspace); } catch { /* ignore */ }
    }
  });

  return win;
}

/** Bring the window back to the front (notification click, taskbar nudge). */
function focusMainWindow() {
  if (!mainWindow) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(false);
  } catch {
    /* ignore */
  }
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
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            if (backendPort) createWindow(backendPort, { freshThread: true });
          },
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const folder = await pickWorkspaceFolder();
            if (folder) await applyWorkspace(folder);
          },
        },
        {
          label: 'Open Folder in New Window…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const folder = await pickWorkspaceFolder();
            if (folder && backendPort) {
              createWindow(backendPort, { workspace: folder, freshThread: true });
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+W',
          click: () => { BrowserWindow.getFocusedWindow()?.close(); },
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
 * Show a native OS notification (Windows Action Center toast, macOS banner).
 *
 * The window's focus state is the gate, and it is checked HERE rather than in
 * the renderer: `document.hasFocus()` can still report true for a background
 * window in some compositors, and a toast for something the user is already
 * watching is pure noise. `force` exists only for the settings "test" button.
 *
 * Clicking the toast raises the window, so a notification is always a way back
 * into the run it is telling you about.
 */
ipcMain.handle('bubbly:notify', (_event, opts) => {
  try {
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };
    const focused = !!(mainWindow && mainWindow.isFocused());
    if (focused && !opts?.force) return { shown: false, reason: 'focused' };

    const notification = new Notification({
      title: String(opts?.title || 'Bubbly'),
      body: String(opts?.body || ''),
      icon: path.join(__dirname, 'assets', 'icon.png'),
      silent: !!opts?.silent,
      urgency: opts?.urgency === 'critical' ? 'critical' : 'normal',
    });
    notification.on('click', focusMainWindow);
    notification.show();

    // Windows only shows a toast for a few seconds; a flashing taskbar button
    // keeps the signal alive until the user actually comes back.
    if (opts?.attention && mainWindow) {
      try { mainWindow.flashFrame(true); } catch { /* ignore */ }
    }
    return { shown: true };
  } catch (err) {
    log('Failed to show notification:', err && err.message ? err.message : String(err));
    return { shown: false, reason: 'error' };
  }
});

/** Whether the app window currently has OS focus (renderer-side gating). */
ipcMain.handle('bubbly:is-focused', () => !!(mainWindow && mainWindow.isFocused()));

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

/**
 * Empty the preview partition's HTTP cache.
 *
 * The preview webview runs in its own in-memory session (see BubblyPreview), and
 * a dev server behind an aggressive cache header will still be served from that
 * cache for the lifetime of the app. Reload calls this first so "reload" means
 * "fetch it again", which is the only thing anybody ever means by it here.
 */
ipcMain.handle('bubbly:clear-preview-cache', async () => {
  try {
    const s = session.fromPartition('bubbly-preview');
    await s.clearCache();
    await s.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] });
    return true;
  } catch (err) {
    log('Could not clear the preview cache:', err && err.message ? err.message : String(err));
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
    case 'hide-to-tray':
      if (mainWindow && tray) { mainWindow.hide(); announceTrayOnce(); refreshTray(); }
      break;
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
    const folder = folderFromArgv(argv);

    // "Open with Bubbly" on a folder, while Bubbly is already running.
    //
    // This used to REPLACE the workspace of the existing window, which meant
    // right-clicking a project silently took away the one you were working on,
    // thread and all. A second folder is a second context: it gets its own
    // window, with a clean slate.
    if (folder && backendPort) {
      createWindow(backendPort, { workspace: folder, freshThread: true });
      return;
    }

    // Launched again with no folder: the user wants the app, so surface it.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (backendPort) {
      createWindow(backendPort, { freshThread: true });
    }
  });

  /*
   * macOS delivers "Open With" through an EVENT, not through argv.
   *
   * Every other platform passes the path on the command line, which is why the
   * argv path above exists — and on macOS that path is simply never taken, so a
   * folder dropped on the dock icon would do nothing at all. The event can also
   * arrive BEFORE the app is ready, so an early one is queued and replayed.
   */
  const pendingOpens = [];
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    try {
      const resolved = path.resolve(filePath);
      const folder = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
      if (app.isReady() && backendPort) {
        createWindow(backendPort, { workspace: folder, freshThread: true });
        void applyWorkspace(folder);
      } else {
        pendingOpens.push(folder);
      }
    } catch (err) {
      log('open-file could not be handled:', String(err));
    }
  });

  // Flaky GPU drivers (common on Windows) can crash Electron's GPU process and
  // make the window look frozen / "not responding". Log and continue on
  // software rendering rather than letting it take the app down.
  app.on('child-process-gone', (_e, details) => {
    log('Child process gone:', details.type, details.reason);
  });

  app.whenReady().then(async () => {
    // Windows ties toast notifications to an Application User Model ID. Without
    // one matching the installed shortcut, toasts are silently dropped (or show
    // up attributed to "electron.app.Electron"). This must match the NSIS
    // appId in package.json.
    if (process.platform === 'win32') {
      try { app.setAppUserModelId('dev.bubbly.desktop'); } catch { /* ignore */ }
    }
    buildMenu();
    try {
      const port = await startBackend();
      // "Open with Bubbly" on a folder from a cold start: the window opens ON
      // that folder with a fresh thread, rather than restoring the last session
      // and then swapping the workspace under it.
      createTray();
      const initialFolder = folderFromArgv(process.argv);
      createWindow(port, initialFolder ? { workspace: initialFolder, freshThread: true } : {});
      if (initialFolder) void applyWorkspace(initialFolder);

      // Replay any macOS open-file events that arrived before we were ready.
      for (const folder of pendingOpens.splice(0)) {
        createWindow(port, { workspace: folder, freshThread: true });
        void applyWorkspace(folder);
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
      // A hidden window is still a window: re-show it rather than opening a
      // second one on top of the thread the user was already reading.
      surfaceWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (trayRefreshTimer) { clearInterval(trayRefreshTimer); trayRefreshTimer = null; }
    if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch { /* ignore */ } }
    tray = null;
    stopBackend();
  });

  app.on('window-all-closed', () => {
    /*
     * No windows is not the same as no app.
     *
     * With a tray, the last window closing is a hide, so this fires only when
     * every window was genuinely destroyed — and even then the backend may be
     * mid-turn on a thread the user expects to find finished. Quitting here
     * would make "close the second window" occasionally kill everything,
     * depending on which window happened to be last.
     *
     * macOS has always worked this way. With the tray, so does everywhere else.
     */
    if (tray && !tray.isDestroyed()) {
      log('All windows closed — staying alive in the tray.');
      return;
    }
    if (process.platform !== 'darwin') {
      stopBackend();
      app.quit();
    }
  });

  process.on('exit', stopBackend);
}
