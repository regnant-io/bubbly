/**
 * Cheap renderer-side guard against embedding Bubbly in Bubbly.
 *
 * The backend performs the authoritative process/header probe. This catches
 * the one address it cannot discover reliably in development: Vite's random
 * frontend port, which is also the renderer's own origin.
 */
export function isCurrentBubblyOrigin(url: string, currentHref?: string): boolean {
  try {
    const href = currentHref ?? (typeof window !== 'undefined' ? window.location.href : '');
    if (!href) return false;
    return new URL(url, href).origin === new URL(href).origin;
  } catch {
    return false;
  }
}
