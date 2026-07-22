/**
 * Preview capability bus — the seam between the Bubbly Preview component (which
 * owns the live webview) and the WebSocket layer (which must tell the backend
 * whether the renderer can ACTUALLY drive a browser right now).
 *
 * Why this exists: the backend used to assume any connected socket could drive a
 * webview, so it committed to the preview path and then hung/failed when the
 * panel was closed or on another tab — burning tokens. Now the renderer reports
 * its true capability here; the WS layer forwards it as `preview_ready`, and the
 * backend only routes browser tools to the preview when it's genuinely drivable,
 * otherwise falling straight back to the headless browser.
 */

export interface PreviewCapability {
  /** The renderer can drive a live browser right now (desktop webview + handler). */
  capable: boolean;
  /** Electron desktop (real webview) vs. plain-browser build (view-only iframe). */
  desktop: boolean;
  /** A page is currently loaded in the webview. */
  hasWebview: boolean;
  url: string | null;
}

let current: PreviewCapability = { capable: false, desktop: false, hasWebview: false, url: null };
let sender: ((c: PreviewCapability) => void) | null = null;

/** The WS layer registers how to actually send `preview_ready`; passing null on
 *  disconnect. On (re)connect it immediately re-advertises the current capability. */
export function registerPreviewReadySender(fn: ((c: PreviewCapability) => void) | null): void {
  sender = fn;
  if (fn) fn(current);
}

/** The preview component reports its live capability (mount, page load/unload,
 *  unmount, and a periodic heartbeat). */
export function reportPreviewCapability(c: PreviewCapability): void {
  current = c;
  sender?.(c);
}

export function getPreviewCapability(): PreviewCapability {
  return current;
}
