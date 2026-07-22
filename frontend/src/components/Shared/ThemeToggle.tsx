import React from 'react';
import { useStore } from '../../store';
import { Sun, Moon } from './icons';

/**
 * Sun/Moon theme toggle for the app header.
 *
 * Flips between light and dark, driving the store's `theme`. The `useTheme`
 * hook applies `data-theme` on <html> and persists the choice to localStorage,
 * so the switch is instant and survives reloads. On first load the app defaults
 * to the OS `prefers-color-scheme` (theme === 'system').
 *
 * The toggle also persists the explicit choice to the backend settings so it
 * stays in sync with the Settings panel.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useStore();
  const isDark = resolvedTheme === 'dark';

  const toggle = () => {
    const next = isDark ? 'light' : 'dark';
    setTheme(next);
    // Best-effort persistence to the backend (mirrors the Settings panel).
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    }).catch(() => { /* localStorage already holds the choice */ });
  };

  return (
    <button
      onClick={toggle}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex items-center justify-center w-7 h-7 rounded-lg text-text-dim hover:text-text hover:bg-surface-3 transition-colors"
      style={{ ['WebkitAppRegion' as any]: 'no-drag' }}
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
