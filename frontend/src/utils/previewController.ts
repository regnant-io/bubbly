/**
 * Preview controller registry — the seam between the WebSocket layer and the
 * live Bubbly Preview webview. BubblyPreview registers a handler that knows how
 * to drive the actual <webview>; useWebSocket calls runPreviewControl() when
 * the backend agent sends a `preview_control` request, then ships the result
 * back so the agent's clicks/typing happen in the browser the user is watching.
 *
 * When no handler is registered (panel unmounted / browser build), we return a
 * `reason` so the backend classifies it as a TRANSPORT failure and falls back
 * to the headless browser — rather than treating it as a real page error and
 * making the agent retry (which burns tokens).
 */

export type PreviewFailReason = 'not_capable' | 'no_webview' | 'no_url';

export interface PreviewControlResult {
  ok: boolean;
  result: string;
  /** base64 data URL of a captured frame (for the screenshot action). */
  image?: string;
  /** current URL after the action. */
  url?: string;
  /** Set when the action could not be executed by the renderer (transport failure). */
  reason?: PreviewFailReason;
}

export type PreviewHandler = (action: string, params: Record<string, unknown>) => Promise<PreviewControlResult>;

let handler: PreviewHandler | null = null;

export function registerPreviewHandler(h: PreviewHandler | null): void {
  handler = h;
}

/** Whether a renderer handler with a drivable webview is registered right now. */
export function isPreviewHandlerReady(): boolean {
  return !!handler;
}

export async function runPreviewControl(
  action: string,
  params: Record<string, unknown>,
): Promise<PreviewControlResult> {
  if (!handler) {
    return {
      ok: false,
      reason: 'not_capable',
      result: 'The Bubbly Preview webview is not available in this window (panel closed or non-desktop build).',
    };
  }
  try {
    return await handler(action, params);
  } catch (err) {
    return { ok: false, reason: 'no_webview', result: `Preview action failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
