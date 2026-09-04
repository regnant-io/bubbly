import { useEffect } from 'react';
import { useStore } from '../store';
import { DEFAULT_PALETTE_ID, getPalette } from '../styles/palettes';

/** Convert a computed "rgb(r, g, b)" string to "#rrggbb" for Electron's overlay. */
function rgbToHex(rgb: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) return /^#[0-9a-f]{6}$/i.test(rgb.trim()) ? rgb.trim() : null;
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/**
 * Apply the user's theme to the document.
 *
 * TWO INDEPENDENT AXES, and keeping them independent is the whole design:
 *
 *   data-palette="<id>"   WHICH theme    (slate, ember, moss, classic…)
 *   data-theme="dark"     WHICH mode     (absent or "light" means light)
 *
 * Collapsing them into one attribute — the obvious shortcut — means switching to
 * dark silently changes which theme you are using, and a user who set Ember and
 * then let the OS go dark at sunset finds themselves in a different product.
 * Every palette ships both modes, so the mode switch only ever changes the mode.
 *
 * `html.dark` is still mirrored because Tailwind's class-based `dark:` variant
 * reads it, and there is a lot of existing markup that does.
 */
export function useTheme() {
  const { theme, palette, resolvedTheme, setResolvedTheme } = useStore();

  // --- Palette ---------------------------------------------------------------
  useEffect(() => {
    const id = getPalette(palette || DEFAULT_PALETTE_ID).id;
    document.documentElement.setAttribute('data-palette', id);
    try { localStorage.setItem('bubbly-palette', id); } catch { /* private mode */ }
  }, [palette]);

  // --- Light / dark ----------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
      if (isDark) root.classList.add('dark');
      else root.classList.remove('dark');
      setResolvedTheme(isDark ? 'dark' : 'light');
    };

    try { localStorage.setItem('bubbly-theme', theme); } catch { /* private mode */ }

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent | MediaQueryList) => applyTheme(e.matches);
      applyTheme(mediaQuery.matches);
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    applyTheme(theme === 'dark');
  }, [theme, setResolvedTheme]);

  // Keep the native desktop window-control overlay (min/max/close) coloured to
  // match the resolved theme, so it never looks like a foreign strip bolted to
  // the top of the window.
  useEffect(() => {
    const api = (window as { bubblyDesktop?: { setTitleBarOverlay?: (o: unknown) => void } }).bubblyDesktop;
    if (!api?.setTitleBarOverlay) return;
    // Read the ACTUAL computed values rather than a hard-coded pair, so the
    // overlay follows whichever palette is active without this file having to
    // know anything about palettes.
    const styles = getComputedStyle(document.documentElement);
    const bg = rgbToHex(styles.getPropertyValue('--surface-1').trim())
      ?? (resolvedTheme === 'dark' ? '#1a1a1d' : '#ffffff');
    const symbol = rgbToHex(styles.getPropertyValue('--text-muted').trim())
      ?? (resolvedTheme === 'dark' ? '#a1a1a8' : '#56565c');
    try {
      api.setTitleBarOverlay({ color: bg, symbolColor: symbol, height: 36 });
    } catch { /* the overlay is cosmetic; never let it break the app */ }
  }, [resolvedTheme, palette]);
}
