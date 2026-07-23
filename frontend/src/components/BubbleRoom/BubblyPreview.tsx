import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { isDesktop } from '../../hooks/useDesktop';
import { registerPreviewHandler, PreviewControlResult } from '../../utils/previewController';
import { reportPreviewCapability } from '../../utils/previewHostBus';
import { SNAPSHOT_JS, buildClickJs, buildTypeJs, buildIsReadyJs, formatSnapshot } from '../../utils/browserPageScripts';
import { detectBrowserMeta, saveBrowserMetaPreviewUrl, startPreviewServer, previewServerStatus, stopPreviewServer } from '../../hooks/useApi';
import { Monitor, Smartphone, Tablet, ArrowLeft, ChevronRight, RefreshCw, ExternalLink, ShieldCheck, Play, Square, Loader2, Maximize2 } from '../Shared/icons';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Race a promise against a timeout so a detached / crashed / unfocused webview
 * can never leave a renderer-side promise pending forever. The backend already
 * unblocks the agent via its own per-action timeout, but this keeps the renderer
 * queue clean and lets us surface a proper transport failure.
 */
function wvTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`webview ${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Device presets shared with the agent's browser_control "viewport" action.
const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
  wide: { width: 1680, height: 1050 },
};

/**
 * Bubbly Preview — a live, embedded browser docked in the right panel, AND the
 * browser the agent drives. On desktop it's an Electron <webview> (real
 * Chromium); the agent's browser_control tool sends actions over the WebSocket
 * which are executed here against this exact webview, so its navigation, clicks
 * and typing appear in the same browser the user is watching. In the plain
 * browser build it falls back to an <iframe> (view-only; agent control needs
 * the desktop app).
 */
export function BubblyPreview() {
  const previewUrl = useStore((s) => s.previewUrl);
  const setPreviewUrl = useStore((s) => s.setPreviewUrl);
  const previewFrame = useStore((s) => s.previewFrame);
  const previewFrameSeq = useStore((s) => s.previewFrameSeq);
  const workspacePath = useStore((s) => s.workspacePath);

  const [addr, setAddr] = useState(previewUrl ?? '');
  const [iframeKey, setIframeKey] = useState(0);
  const [browserMeta, setBrowserMeta] = useState<{ enabled: boolean; checked: boolean; previewUrl: string | null; start: string | null; running: boolean; serviceCount: number }>({ enabled: false, checked: false, previewUrl: null, start: null, running: false, serviceCount: 0 });
  // 'idle' | 'starting' | 'running' — lifecycle of the dev server the Start
  // button launches (distinct from whether a URL is merely loaded).
  const [serverState, setServerState] = useState<'idle' | 'starting' | 'running'>('idle');
  // Set when the current preview URL fails to load (e.g. the dev server isn't
  // running). Shows a friendly retry state instead of a blank page + a raw
  // "ERR_CONNECTION_REFUSED" from Electron.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Emulated device viewport. null = fill the panel (responsive to the panel
  // width). A preset/custom size renders the browser at that CSS size, centered,
  // so both the user (via the toolbar) and the agent (via the browser_control
  // "viewport" action) can check responsive layouts.
  const [viewport, setViewport] = useState<{ width: number; height: number; label: string } | null>(null);
  // Fit-to-panel: when an emulated device is larger than the panel, scale the
  // whole frame down so it's fully visible instead of overflowing/scrolling.
  // On by default so the preview NEVER overflows on any panel size.
  const [fitToPanel, setFitToPanel] = useState(true);
  // Live size of the frame viewport area, measured so we can compute the fit scale.
  const [panelSize, setPanelSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<any>(null);
  const consoleLogRef = useRef<string[]>([]);
  const handlerRef = useRef<(action: string, params: Record<string, unknown>) => Promise<PreviewControlResult>>();

  useEffect(() => { setAddr(previewUrl ?? ''); }, [previewUrl]);

  // Track the live size of the frame stage so an emulated device can be scaled
  // to fit it (see fitScale). Keeps the preview flexible + accurate at any panel
  // width, on any host window size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setPanelSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The scale that makes the emulated viewport fit inside the stage. 1 when it
  // already fits (or fitting is off / no device selected) — we never scale UP.
  const STAGE_PAD = 24; // matches the p-3 padding around the framed device
  const fitScale = (viewport && fitToPanel && panelSize.w > 0 && panelSize.h > 0)
    ? Math.min(1, (panelSize.w - STAGE_PAD) / viewport.width, (panelSize.h - STAGE_PAD) / viewport.height)
    : 1;

  // Every new load attempt starts clean; wire the desktop webview's load +
  // console callbacks so a failed load surfaces as our own retry UI, and the
  // agent can read the page's console via the `console` action.
  useEffect(() => {
    setLoadError(null);
    consoleLogRef.current = []; // fresh page → fresh console buffer
    if (!isDesktop()) return;
    const wv = webviewRef.current;
    if (!wv || typeof wv.addEventListener !== 'function') return;
    const onFail = (e: any) => {
      // errorCode -3 is "aborted" (e.g. a superseded navigation) — ignore it.
      if (e?.isMainFrame === false || e?.errorCode === -3) return;
      setLoadError(e?.validatedURL || previewUrl || 'the page');
    };
    const onOk = () => setLoadError(null);
    const onConsole = (e: any) => {
      const level = e?.level === 2 ? 'error' : e?.level === 1 ? 'warn' : 'log';
      const line = `[${level}] ${String(e?.message ?? '').slice(0, 300)}`;
      consoleLogRef.current.push(line);
      if (consoleLogRef.current.length > 200) consoleLogRef.current = consoleLogRef.current.slice(-200);
    };
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('did-finish-load', onOk);
    wv.addEventListener('console-message', onConsole);
    return () => {
      try {
        wv.removeEventListener('did-fail-load', onFail);
        wv.removeEventListener('did-finish-load', onOk);
        wv.removeEventListener('console-message', onConsole);
      } catch { /* ignore */ }
    };
  }, [previewUrl, iframeKey]);

  const detectMeta = async () => {
    if (!workspacePath) return;
    const r = await detectBrowserMeta(workspacePath);
    setBrowserMeta({ enabled: !!r.enabled, checked: true, previewUrl: r.previewUrl ?? null, start: r.start ?? null, running: !!r.running, serviceCount: r.services?.filter((s) => s.start).length ?? 0 });
    if (r.running) setServerState('running');
  };

  // Auto-create + detect the project's meta.json the first time the preview
  // panel is shown for a workspace — so meta exists before anything runs and
  // the placeholder can immediately offer a Start button.
  useEffect(() => {
    setBrowserMeta({ enabled: false, checked: false, previewUrl: null, start: null, running: false, serviceCount: 0 });
    setServerState('idle');
    detectMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  // Persist the URL into meta whenever a real preview URL is loaded, so the
  // next "Start" reopens the same server.
  useEffect(() => {
    if (workspacePath && previewUrl) saveBrowserMetaPreviewUrl(workspacePath, previewUrl);
  }, [workspacePath, previewUrl]);

  // "Start" — if the project declares a start command (meta.start), actually
  // LAUNCH the dev server, wait for it to print its URL, then open it. If
  // there's no start command, fall back to just opening the saved URL (so an
  // already-running external server still works).
  const startPreview = async () => {
    if (!workspacePath || !browserMeta.start) {
      const url = normalize(browserMeta.previewUrl || addr || 'http://localhost:3000');
      if (url) setPreviewUrl(url);
      return;
    }
    setServerState('starting');
    const r = await startPreviewServer(workspacePath).catch(() => ({ ok: false } as any));
    if (!r.ok) {
      setServerState('idle');
      setLoadError(r.error || 'Could not start the dev server.');
      return;
    }
    if (r.url) { setServerState('running'); setPreviewUrl(normalize(r.url)); return; }
    // Poll for the server's URL (it prints it a moment after starting).
    const startedAt = Date.now();
    const poll = async () => {
      if (Date.now() - startedAt > 45000) { setServerState('idle'); setLoadError('The dev server started but never printed a URL. Check the terminal.'); return; }
      const s = await previewServerStatus(workspacePath).catch(() => ({ running: false, url: null }));
      if (!s.running) { setServerState('idle'); setLoadError('The dev server exited before it was ready. Check the terminal for errors.'); return; }
      if (s.url) { setServerState('running'); setPreviewUrl(normalize(s.url)); return; }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 1000);
  };

  // Keep the Start/Stop button honest about the ACTUAL server. The server can
  // die out from under the preview — the agent runs stop_process, the dev
  // server crashes, or the run is stopped — and nothing pushed that to us, so
  // the button used to stay stuck on "Stop" over a server that was already gone.
  // While we believe a server is up, poll its real status; the moment it's no
  // longer running, fall back to idle so the button flips to Start and the dead
  // page stops being presented as live.
  useEffect(() => {
    if (!workspacePath) return;
    if (serverState === 'idle') return;
    let cancelled = false;
    const check = async () => {
      const s = await previewServerStatus(workspacePath).catch(() => null);
      if (cancelled || !s) return;
      if (!s.running && serverState === 'running') {
        setServerState('idle');
        setBrowserMeta((m) => ({ ...m, running: false }));
        setLoadError('The dev server stopped. Press Start to run it again.');
      }
    };
    const t = setInterval(check, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspacePath, serverState]);

  // "Stop" — kill the dev server (if one is running for this project) AND tear
  // down the live preview. The button toggles between Start and Stop.
  const stopPreview = async () => {
    setPreviewUrl(null);
    setServerState('idle');
    if (workspacePath && (browserMeta.running || serverState !== 'idle')) {
      await stopPreviewServer(workspacePath).catch(() => { /* best-effort */ });
      setBrowserMeta((m) => ({ ...m, running: false }));
    }
  };

  const normalize = (raw: string): string => {
    // Strip ANSI escape codes + control chars first — a URL captured from
    // colourised terminal output can carry them and break navigation.
    // eslint-disable-next-line no-control-regex
    const v = String(raw ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f]/g, '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^localhost(:\d+)?/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v)) return `http://${v}`;
    return `https://${v}`;
  };

  // Wait until the webview is mounted and has finished loading.
  const waitForWebview = async (timeout = 10000): Promise<any | null> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const wv = webviewRef.current;
      if (wv && typeof wv.getURL === 'function') {
        try { if (typeof wv.isLoading !== 'function' || !wv.isLoading()) return wv; } catch { return wv; }
      }
      await sleep(150);
    }
    return webviewRef.current;
  };

  // Resolve a viewport preset/custom size from action params → {width,height,label}.
  const resolveViewportParams = (params: Record<string, unknown>): { width: number; height: number; label: string } | null => {
    const preset = typeof params.preset === 'string' ? params.preset.toLowerCase() : '';
    if (preset && VIEWPORT_PRESETS[preset]) {
      const { width, height } = VIEWPORT_PRESETS[preset];
      return { width, height, label: `${preset} (${width}x${height})` };
    }
    const w = Number(params.width), h = Number(params.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 200 && h >= 200 && w <= 4000 && h <= 4000) {
      return { width: Math.round(w), height: Math.round(h), label: `${Math.round(w)}x${Math.round(h)}` };
    }
    return null;
  };

  // --- The agent-driven control handler (desktop webview) -------------------
  handlerRef.current = async (action, params): Promise<PreviewControlResult> => {
    // Viewport resizing works in BOTH the desktop webview and the browser iframe
    // (it's just CSS sizing of the frame), so handle it before the desktop gate.
    if (action === 'viewport') {
      const vp = resolveViewportParams(params);
      if (!vp) return { ok: false, result: 'viewport requires a preset (mobile/tablet/desktop/wide) or width+height (200–4000).' };
      setViewport(vp);
      await sleep(250);
      return { ok: true, result: `Viewport set to ${vp.label}.` };
    }
    if (!isDesktop()) {
      // Non-desktop build: the iframe can't be scripted, so signal a transport
      // failure and let the backend drive its headless browser instead.
      return { ok: false, reason: 'not_capable', result: 'This window is a view-only preview (non-desktop build); the agent should use the headless browser.' };
    }

    if (action === 'open' || action === 'goto') {
      const url = normalize(String(params.url ?? ''));
      if (!url) return { ok: false, result: 'open requires a url.' };
      setPreviewUrl(url);
      const wv = await waitForWebview();
      if (!wv || typeof wv.getURL !== 'function') {
        return { ok: false, reason: 'no_webview', result: 'The preview webview never became ready.' };
      }
      await sleep(400); // brief settle so first paint + hydration begins
      let title = '';
      try { title = await wvTimeout(Promise.resolve(wv.getTitle?.()), 4000, 'getTitle'); } catch { /* ignore */ }
      let image: string | undefined;
      try { image = (await wvTimeout(wv.capturePage(), 6000, 'capturePage') as any).toDataURL(); } catch { /* best-effort frame */ }
      return { ok: true, result: `Navigated to ${url}${title ? ` — ${title}` : ''}`, url: wv.getURL?.() ?? url, image };
    }

    if (action === 'close') {
      setPreviewUrl(null);
      return { ok: true, result: 'Closed the preview.' };
    }

    const wv = webviewRef.current;
    if (!wv || typeof wv.executeJavaScript !== 'function') {
      // No page loaded in the visible webview — signal transport failure so the
      // backend falls back to the headless browser rather than dead-ending.
      return { ok: false, reason: 'no_url', result: 'Nothing is loaded in the visible preview yet — open(url) first, or the agent can use the headless browser.' };
    }

    try {
      switch (action) {
        case 'reload': {
          wv.reload();
          await waitForWebview();
          return { ok: true, result: 'Reloaded.', url: wv.getURL?.() };
        }
        case 'back': { wv.goBack(); await sleep(400); return { ok: true, result: 'Went back.', url: wv.getURL?.() }; }
        case 'forward': { wv.goForward(); await sleep(400); return { ok: true, result: 'Went forward.', url: wv.getURL?.() }; }
        case 'click': {
          const sel = params.selector ? String(params.selector) : '';
          const text = params.text ? String(params.text) : '';
          const res: any = await wvTimeout(wv.executeJavaScript(buildClickJs({ selector: sel, text, x: typeof params.x === 'number' ? params.x : undefined, y: typeof params.y === 'number' ? params.y : undefined }), true), 8000, 'click');
          const parsed: any = typeof res === 'object' && res ? res : { status: String(res) };
          if (parsed.status === 'clicked') {
            let image: string | undefined;
            try { image = (await wvTimeout(wv.capturePage(), 6000, 'capturePage') as any).toDataURL(); } catch { /* frame is best-effort */ }
            return { ok: true, result: `Clicked ${parsed.strategy ? `(${parsed.strategy}) ` : ''}${sel || (text ? `"${text}"` : `(${params.x},${params.y})`)}.`, image, url: wv.getURL?.() };
          }
          const cands = Array.isArray(parsed.candidates) && parsed.candidates.length
            ? ` Closest matches — click one by text: ${parsed.candidates.map((c: any) => `"${c.label}" (${c.tag})`).join(' · ')}`
            : '';
          return { ok: false, result: `Could not click ${sel || `"${text}"`} — ${parsed.status || 'not found'}.${cands}` };
        }
        case 'type': {
          const sel = params.selector ? String(params.selector) : '';
          const text = String(params.text ?? '');
          const res: any = await wvTimeout(wv.executeJavaScript(buildTypeJs({ selector: sel || undefined, text }), true), 8000, 'type');
          const status = typeof res === 'object' && res ? res.status : String(res);
          return { ok: status === 'typed', result: status === 'typed' ? `Typed ${text.length} char(s).` : `Could not type — no editable field found${sel ? ` for "${sel}"` : ''}.` };
        }
        case 'press': {
          const key = String(params.key ?? '');
          try {
            wv.sendInputEvent({ type: 'keyDown', keyCode: key });
            wv.sendInputEvent({ type: 'char', keyCode: key });
            wv.sendInputEvent({ type: 'keyUp', keyCode: key });
          } catch { /* best-effort */ }
          return { ok: true, result: `Pressed ${key}.` };
        }
        case 'scroll': {
          const amount = Number(params.amount ?? 400);
          await wvTimeout(wv.executeJavaScript(`window.scrollBy(0, ${amount});`, true), 5000, 'scroll');
          return { ok: true, result: `Scrolled ${amount}px.` };
        }
        case 'wait': {
          const sel = params.selector ? String(params.selector) : '';
          const text = params.text ? String(params.text) : '';
          const ms = Number(params.amount ?? (sel || text ? 10000 : 1000));
          if (sel || text) {
            const start = Date.now();
            while (Date.now() - start < ms) {
              const ready = await wvTimeout(wv.executeJavaScript(buildIsReadyJs({ selector: sel || undefined, text: text || undefined }), true), 4000, 'wait').catch(() => false);
              if (ready) return { ok: true, result: `"${sel || text}" is visible and ready.` };
              await sleep(200);
            }
            return { ok: false, result: `Timed out waiting for "${sel || text}" to be visible + enabled.` };
          }
          await sleep(Math.min(ms, 15000));
          return { ok: true, result: `Waited ${ms}ms.` };
        }
        case 'snapshot': {
          const snap: any = await wvTimeout(wv.executeJavaScript(SNAPSHOT_JS, true), 10000, 'snapshot');
          return { ok: true, result: formatSnapshot(snap), url: snap.url };
        }
        case 'console': {
          const log = consoleLogRef.current.slice(-80);
          return { ok: true, result: log.length ? `Console log (${log.length} recent entries):\n${log.join('\n')}` : 'Console is empty (no logs, warnings, or errors since the last navigation).' };
        }
        case 'screenshot': {
          const img: any = await wvTimeout(wv.capturePage(), 10000, 'screenshot');
          const dataUrl = img.toDataURL();
          return { ok: true, result: `Captured the current preview (${wv.getURL?.() ?? ''}).`, image: dataUrl, url: wv.getURL?.() };
        }
        default:
          return { ok: false, result: `Unknown preview action "${action}".` };
      }
    } catch (err) {
      return { ok: false, result: `Preview action "${action}" failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  useEffect(() => {
    registerPreviewHandler((a, p) => handlerRef.current!(a, p));
    return () => registerPreviewHandler(null);
  }, []);

  // Advertise to the backend (via the WS layer) whether this window can ACTUALLY
  // drive a browser. Only the desktop build (real Electron webview) is
  // "capable"; the plain-browser iframe is view-only, so the agent's browser
  // tools run in the headless fallback there. Report on mount, whenever a page
  // loads/unloads, on unmount, and as a 10s heartbeat so an idle-but-open panel
  // never goes stale and gets wrongly treated as disconnected.
  useEffect(() => {
    const desktop = isDesktop();
    const report = () => reportPreviewCapability({
      capable: desktop,
      desktop,
      hasWebview: !!useStore.getState().previewUrl,
      url: useStore.getState().previewUrl ?? null,
    });
    report();
    const hb = setInterval(report, 10000);
    return () => {
      clearInterval(hb);
      // On unmount tell the backend we can no longer drive — it falls back
      // immediately instead of routing to a dead handler.
      reportPreviewCapability({ capable: false, desktop, hasWebview: false, url: null });
    };
  }, []);

  // Keep hasWebview/url fresh as pages load.
  useEffect(() => {
    reportPreviewCapability({ capable: isDesktop(), desktop: isDesktop(), hasWebview: !!previewUrl, url: previewUrl ?? null });
  }, [previewUrl]);

  const go = () => { const url = normalize(addr); if (url) setPreviewUrl(url); };
  const back = () => { try { webviewRef.current?.goBack?.(); } catch { /* ignore */ } };
  const forward = () => { try { webviewRef.current?.goForward?.(); } catch { /* ignore */ } };
  const reload = () => {
    if (isDesktop()) { try { webviewRef.current?.reload?.(); } catch { /* ignore */ } }
    else setIframeKey((k) => k + 1);
  };
  const openExternal = () => {
    if (!previewUrl) return;
    const api = (window as any).bubblyDesktop;
    if (isDesktop() && api?.openExternal) api.openExternal(previewUrl);
    else window.open(previewUrl, '_blank', 'noreferrer');
  };

  const hasLive = !!previewUrl;

  // The actual embedded browser (desktop webview or web iframe). Defined once and
  // placed into whichever layout branch is active — only one renders at a time,
  // so the ref binds correctly.
  const frameEl = hasLive ? (
    isDesktop() ? (
      React.createElement('webview', {
        ref: webviewRef,
        src: previewUrl!,
        allowpopups: 'true',
        // Keep the guest scriptable/paintable when the OS window is unfocused.
        webpreferences: 'backgroundThrottling=no',
        style: { width: '100%', height: '100%', border: 'none', display: 'inline-flex' },
      })
    ) : (
      <iframe
        key={iframeKey}
        src={previewUrl!}
        title="Bubbly Preview"
        className="w-full h-full border-0"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      />
    )
  ) : null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Address bar + navigation */}
      <div className="flex items-center gap-1 px-2 h-9 border-b border-border shrink-0">
        <button onClick={back} title="Back" className="p-1.5 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          <ArrowLeft size={14} />
        </button>
        <button onClick={forward} title="Forward" className="p-1.5 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          <ChevronRight size={14} />
        </button>
        <button onClick={reload} title="Reload" className="p-1.5 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          <RefreshCw size={13} />
        </button>
        {/* Start / Starting / Stop — reflects the dev-server lifecycle. */}
        {serverState === 'starting' ? (
          <button disabled title="Starting the dev server…" className="p-1.5 rounded text-accent-bright">
            <Loader2 size={13} className="animate-spin" />
          </button>
        ) : hasLive || serverState === 'running' ? (
          <button
            onClick={stopPreview}
            title={browserMeta.start ? `Stop the dev server (${browserMeta.start})` : 'Stop preview'}
            className="p-1.5 rounded text-red-agent hover:bg-surface-3 transition-colors"
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            onClick={startPreview}
            disabled={!workspacePath}
            title={browserMeta.start ? `Start the dev server (${browserMeta.start})` : browserMeta.previewUrl ? `Open preview (${browserMeta.previewUrl})` : 'Start preview'}
            className="p-1.5 rounded text-green-agent hover:bg-surface-3 transition-colors disabled:opacity-30"
          >
            <Play size={13} />
          </button>
        )}
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          placeholder="Enter a URL (e.g. localhost:3000)"
          className="flex-1 min-w-0 bg-surface-2 border border-border rounded-lg px-2.5 py-1 text-xs text-text placeholder:text-text-dim outline-none focus:border-accent/60"
        />
        {/* Viewport / device-size controls for responsive checks. */}
        <div className="flex items-center gap-0.5 mx-0.5 pl-1 border-l border-border">
          <button
            onClick={() => setViewport(viewport && viewport.width === VIEWPORT_PRESETS.mobile.width ? null : { ...VIEWPORT_PRESETS.mobile, label: 'mobile' })}
            title="Mobile (390×844)"
            className={`p-1.5 rounded transition-colors ${viewport?.width === VIEWPORT_PRESETS.mobile.width ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            <Smartphone size={13} />
          </button>
          <button
            onClick={() => setViewport(viewport && viewport.width === VIEWPORT_PRESETS.tablet.width ? null : { ...VIEWPORT_PRESETS.tablet, label: 'tablet' })}
            title="Tablet (820×1180)"
            className={`p-1.5 rounded transition-colors ${viewport?.width === VIEWPORT_PRESETS.tablet.width ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            <Tablet size={13} />
          </button>
          <button
            onClick={() => setViewport(null)}
            title="Responsive (fill panel)"
            className={`p-1.5 rounded transition-colors ${!viewport ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            <Monitor size={13} />
          </button>
          {/* Auto-fit: scale an emulated device down so it never overflows the
              panel. Disabled (and inert) in responsive mode, which already fills. */}
          <button
            onClick={() => setFitToPanel((v) => !v)}
            disabled={!viewport}
            title={viewport ? (fitToPanel ? 'Auto-fit: on (device scales to fit the panel)' : 'Auto-fit: off (device at 1:1, scroll to see more)') : 'Auto-fit applies to an emulated device size'}
            className={`p-1.5 rounded transition-colors disabled:opacity-30 ${viewport && fitToPanel ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
          >
            <Maximize2 size={13} />
          </button>
        </div>
        <button onClick={openExternal} disabled={!hasLive} title="Open in system browser" className="p-1.5 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors disabled:opacity-30">
          <ExternalLink size={13} />
        </button>
        <button
          onClick={detectMeta}
          disabled={!workspacePath}
          title={
            !workspacePath ? 'Set a workspace first'
            : browserMeta.checked && browserMeta.enabled ? 'Browser control is enabled for this project (.bubbly/browser-meta.json)'
            : browserMeta.checked ? 'Browser control is disabled for this project — see .bubbly/browser-meta.json'
            : 'Detect/enable browser control for this project'
          }
          className={`p-1.5 rounded transition-colors disabled:opacity-30 ${
            browserMeta.checked && browserMeta.enabled ? 'text-green-agent' : browserMeta.checked ? 'text-red-agent' : 'text-text-dim hover:text-text hover:bg-surface-3'
          }`}
        >
          <ShieldCheck size={13} />
        </button>
      </div>

      {/* Emulated-viewport badge */}
      {hasLive && viewport && (
        <div className="flex items-center justify-center gap-2 h-6 shrink-0 bg-surface-2 border-b border-border text-[11px] text-text-dim">
          <span className="font-medium text-text-muted">{viewport.label}</span>
          <span>· {viewport.width}×{viewport.height}</span>
          {fitScale < 1 && <span className="text-accent-bright">· {Math.round(fitScale * 100)}%</span>}
          <button onClick={() => setViewport(null)} className="text-accent-bright hover:underline">reset</button>
        </div>
      )}

      {/* Live browser, agent frame, or placeholder */}
      {/* The stage measures the available area (stageRef) and, when an emulated
          device is active, either scrolls (fit off) or scales the device to fit
          (fit on) so content never overflows the panel on any host size. */}
      <div
        ref={stageRef}
        className={`relative flex-1 min-h-0 bg-surface-0 ${viewport && !fitToPanel ? 'overflow-auto' : 'overflow-hidden'}`}
      >
        {hasLive ? (
          <div className={viewport ? 'w-full h-full flex items-start justify-center p-3' : 'h-full'}>
            {viewport ? (
              // Outer wrapper reserves the SCALED footprint so the framed device
              // stays centered and the stage never has to scroll when fitting.
              <div style={{ width: viewport.width * fitScale, height: viewport.height * fitScale, flex: '0 0 auto' }}>
                <div
                  style={{ width: viewport.width, height: viewport.height, transform: `scale(${fitScale})`, transformOrigin: 'top left' }}
                  className="bg-white rounded-lg overflow-hidden shadow-xl ring-1 ring-border"
                >
                  {frameEl}
                </div>
              </div>
            ) : (
              <div style={{ width: '100%', height: '100%' }}>
                {frameEl}
              </div>
            )}
          </div>
        ) : previewFrame ? (
          <div className="h-full overflow-auto flex items-start justify-center p-2">
            <img
              src={`/api/files/screenshot?file=${encodeURIComponent(previewFrame)}&seq=${previewFrameSeq}`}
              alt="Bubbly Preview — the agent's browser"
              className="max-w-full h-auto rounded-lg border border-border shadow-lg"
            />
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3 text-text-dim">
            <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-border flex items-center justify-center">
              <Monitor size={22} className="text-accent-bright" />
            </div>
            <p className="text-sm font-medium text-text">Bubbly Preview</p>
            <p className="text-xs leading-relaxed max-w-[260px]">
              A live browser the agent drives. The agent's clicks and typing
              happen right in this window.
            </p>
            {browserMeta.checked && browserMeta.enabled ? (
              serverState === 'starting' ? (
                <div className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-surface-2 text-xs text-text-muted">
                  <Loader2 size={13} className="animate-spin" /> Starting{browserMeta.start ? ` · ${browserMeta.start}` : ''}…
                </div>
              ) : (
                <button
                  onClick={startPreview}
                  className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-bright text-white text-xs font-medium transition-colors"
                  title={browserMeta.serviceCount > 1 ? `Runs all ${browserMeta.serviceCount} services (frontend + backend)` : browserMeta.start ? `Runs: ${browserMeta.start}` : undefined}
                >
                  <Play size={13} /> Start{browserMeta.serviceCount > 1 ? ` · ${browserMeta.serviceCount} services` : browserMeta.start ? ` · ${browserMeta.start}` : browserMeta.previewUrl ? ` · ${browserMeta.previewUrl.replace(/^https?:\/\//, '')}` : ''}
                </button>
              )
            ) : workspacePath ? (
              <button
                onClick={detectMeta}
                className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-border hover:border-accent hover:bg-accent/10 text-xs text-text transition-colors"
              >
                <ShieldCheck size={13} /> Enable preview for this project
              </button>
            ) : (
              <p className="text-[11px] text-text-dim">Set a workspace to enable the preview.</p>
            )}
          </div>
        )}

        {/* Load-failure overlay — covers the frame when the URL can't be
            reached (dev server not running), instead of a blank page. */}
        {hasLive && loadError && (
          <div className="absolute inset-0 z-10 bg-surface-0 flex flex-col items-center justify-center text-center px-6 gap-3">
            <div className="w-12 h-12 rounded-2xl bg-error-bg border border-red-agent/30 flex items-center justify-center">
              <Monitor size={22} className="text-red-agent" />
            </div>
            <p className="text-sm font-medium text-text">Couldn&rsquo;t connect</p>
            <p className="text-xs leading-relaxed max-w-[280px] text-text-dim">
              Nothing is responding at <span className="font-mono text-text-muted break-all">{previewUrl}</span>.
              The dev server may not be running yet — start it, then retry.
            </p>
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => { setLoadError(null); reload(); }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-bright text-white text-xs font-medium transition-colors"
              >
                <RefreshCw size={13} /> Retry
              </button>
              <button
                onClick={stopPreview}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-border hover:border-red-agent/50 hover:bg-error-bg text-xs text-text transition-colors"
              >
                <Square size={13} /> Stop
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
