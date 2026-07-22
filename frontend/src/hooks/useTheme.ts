import { useEffect } from 'react';
import { useStore } from '../store';

/** Convert a computed "rgb(r, g, b)" string to "#rrggbb" for Electron's overlay. */
function rgbToHex(rgb: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) return /^#[0-9a-f]{6}$/i.test(rgb.trim()) ? rgb.trim() : null;
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

export function useTheme() {
  const { theme, resolvedTheme, setResolvedTheme } = useStore();

  useEffect(() => {
    const root = document.documentElement;
    
    const applyTheme = (isDark: boolean) => {
      // Preferred hook for the flat-card theme system.
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
      // Keep the class in sync for Tailwind's class-based `dark:` variant and
      // any legacy `html.dark` selectors.
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
      setResolvedTheme(isDark ? 'dark' : 'light');
    };

    // Save theme to localStorage for instant load
    localStorage.setItem('bubbly-theme', theme);

    if (theme === 'system') {
      // Listen to system preference
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      
      const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
        applyTheme(e.matches);
      };

      // Initial application
      applyTheme(mediaQuery.matches);

      // Listen for changes
      mediaQuery.addEventListener('change', handleChange);
      
      return () => {
        mediaQuery.removeEventListener('change', handleChange);
      };
    } else {
      // Apply explicit theme
      applyTheme(theme === 'dark');
    }
  }, [theme, setResolvedTheme]);

  // Keep the native desktop window-control overlay (min/max/close) colored to
  // match the resolved theme, so it never looks like a dark strip in light mode.
  useEffect(() => {
    const api = (window as any).bubblyDesktop;
    if (!api?.setTitleBarOverlay) return;
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;background:var(--surface-1);color:var(--text)';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const symbolColor = rgbToHex(cs.color);
      document.body.removeChild(probe);
      // Transparent overlay background so the caption buttons blend into the
      // title strip; only the symbol color follows the resolved theme.
      if (symbolColor) api.setTitleBarOverlay({ color: 'rgba(0,0,0,0)', symbolColor });
    } catch { /* overlay unsupported on this platform — ignore */ }
  }, [resolvedTheme]);

  return { theme, resolvedTheme };
}
