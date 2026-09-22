import { useEffect, useRef } from 'react';
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
 * Cross-fade the app between two palettes.
 *
 * The colour transition is a CLASS on <html> (see styles/motion.css) rather
 * than a permanent rule on the universal selector, so it has to be added for
 * the length of the swap and taken off again. Everything is timer-based rather
 * than transitionend-based on purpose: `transitionend` fires once per property
 * per element, which on a full app is thousands of events for one swap.
 *
 * Nothing calls this on the FIRST paint — a page that fades in from the wrong
 * colours is worse than one that simply starts correct.
 */
let themeTransitionTimer: ReturnType<typeof setTimeout> | undefined;
function withThemeTransition(apply: () => void) {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  apply();
  clearTimeout(themeTransitionTimer);
  themeTransitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 320);
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

  /**
   * Is this the first run of the effects below?
   *
   * The initial application of the theme happens with the screen already
   * painted in the right colours (index.html does it inline before React
   * loads), so animating it would be a fade from correct to correct — visible
   * work for no information. Every LATER change is a real change and gets the
   * cross-fade.
   */
  const firstApply = useRef(true);

  // --- Palette ---------------------------------------------------------------
  useEffect(() => {
    const id = getPalette(palette || DEFAULT_PALETTE_ID).id;
    const apply = () => document.documentElement.setAttribute('data-palette', id);
    if (firstApply.current) apply();
    else withThemeTransition(apply);
    try { localStorage.setItem('bubbly-palette', id); } catch { /* private mode */ }
  }, [palette]);

  // --- Light / dark ----------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      const apply = () => {
        root.setAttribute('data-theme', isDark ? 'dark' : 'light');
        if (isDark) root.classList.add('dark');
        else root.classList.remove('dark');
      };
      if (firstApply.current) { apply(); firstApply.current = false; }
      else withThemeTransition(apply);
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
    const bg = rgbToHex(styles.getPropertyValue('--bg-page').trim())
      ?? (resolvedTheme === 'dark' ? '#1a1a1d' : '#ffffff');
    const symbol = rgbToHex(styles.getPropertyValue('--text-muted').trim())
      ?? (resolvedTheme === 'dark' ? '#a1a1a8' : '#56565c');
    try {
      api.setTitleBarOverlay({ color: bg, symbolColor: symbol, height: 40 });
    } catch { /* the overlay is cosmetic; never let it break the app */ }
  }, [resolvedTheme, palette]);
}
