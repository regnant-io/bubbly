import { useStore } from '../store';

/**
 * OS notifications for work that finishes while you're looking at something
 * else.
 *
 * Two transports, same contract:
 *  - Bubbly Desktop → a real Windows toast (Action Center) via the Electron
 *    shell, which also owns the focus check and can flash the taskbar.
 *  - Browser → the Web Notifications API, gated on `document.hasFocus()`.
 *
 * Nothing fires while the app is focused: if you can see the run finish, a
 * toast about it is noise. Everything here is best-effort and never throws —
 * a blocked permission or an unsupported platform degrades to silence.
 */

export type NotifyUrgency = 'normal' | 'critical';

export interface NotifyOptions {
  title: string;
  body: string;
  urgency?: NotifyUrgency;
  /** Also flash the taskbar button (desktop only) until the user comes back. */
  attention?: boolean;
  /** Bypass the "app is focused" and settings gates — used by the settings test button. */
  force?: boolean;
}

/** Bursts of events (a run erroring right as a command fails) collapse to one toast. */
const MIN_GAP_MS = 4000;
let lastNotifiedAt = 0;
let lastKey = '';

/** Desktop focus, mirrored from the shell's window focus/blur events. */
let desktopFocused = true;
let focusListenerBound = false;

/**
 * Track the shell window's focus. Called once at app start; harmless in the
 * browser, where `document.hasFocus()` is used instead.
 */
export function initNotificationFocusTracking(): () => void {
  const api = window.bubblyDesktop;
  if (!api?.onFocusChanged || focusListenerBound) return () => { /* no-op */ };
  focusListenerBound = true;
  api.isWindowFocused?.().then((f) => { desktopFocused = f; }).catch(() => { /* ignore */ });
  const off = api.onFocusChanged((focused) => { desktopFocused = focused; });
  return () => {
    focusListenerBound = false;
    off();
  };
}

/** True when the user is currently looking at Bubbly. */
export function appIsFocused(): boolean {
  try {
    if (window.bubblyDesktop && focusListenerBound) return desktopFocused;
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return true; // Unknown → assume focused, i.e. stay quiet.
  }
}

/** Whether the user has notifications turned on (defaults to on). */
export function notificationsEnabled(): boolean {
  return useStore.getState().settings?.desktopNotifications !== 'false';
}

/** Ask the browser for permission once, lazily. No-op in the desktop shell. */
export async function ensureBrowserPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Show a notification if the app is in the background and notifications are
 * enabled. Returns whether one was actually shown.
 */
export async function notifyDesktop(opts: NotifyOptions): Promise<boolean> {
  try {
    if (!opts.force) {
      if (!notificationsEnabled()) return false;
      if (appIsFocused()) return false;

      const now = Date.now();
      const key = `${opts.title}::${opts.body}`;
      if (key === lastKey && now - lastNotifiedAt < MIN_GAP_MS) return false;
      lastKey = key;
      lastNotifiedAt = now;
    }

    const api = window.bubblyDesktop;
    if (api?.notify) {
      const r = await api.notify({
        title: opts.title,
        body: opts.body,
        urgency: opts.urgency ?? 'normal',
        attention: opts.attention,
        force: opts.force,
      });
      return !!r?.shown;
    }

    if (!(await ensureBrowserPermission())) return false;
    const n = new Notification(opts.title, {
      body: opts.body,
      icon: '/bubble.svg',
      tag: 'bubbly-run',
    });
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
    return true;
  } catch {
    return false;
  }
}

/** Compact "2m 14s" / "8s" runtime for notification bodies. */
export function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Trim a message to a single readable notification line. */
export function summarize(text: string | undefined, max = 140): string {
  if (!text) return '';
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
