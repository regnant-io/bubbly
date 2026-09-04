import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { subscribeTerminalData, getTerminalScrollback } from '../../utils/terminalBus';
import { useStore } from '../../store';

interface XtermViewProps {
  /** Backend terminal id (or clientRef before binding). */
  terminalId: string;
  fontSize: number;
  /** Send a keystroke/data chunk to the backend PTY. */
  onData: (data: string) => void;
  /** Notify the backend of a new size (cols/rows). */
  onResize: (cols: number, rows: number) => void;
}

// Bubbly dark theme for xterm — tuned to the app's surface palette.
const DARK_THEME = {
  background: '#00000000', // transparent; the panel provides the bg
  foreground: '#e6e1dc',
  cursor: '#e6e1dc',
  cursorAccent: '#1a1614',
  selectionBackground: '#3b3833',
  black: '#1a1614',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e6e1dc',
  brightBlack: '#6b6660',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

// Light counterpart. The bright dark-mode ANSI colours are washed out and
// near-illegible on a light surface, so these are the darker, higher-contrast
// variants of the same hues.
const LIGHT_THEME = {
  background: '#00000000', // transparent; the panel provides the bg
  foreground: '#1b1a16',
  cursor: '#1b1a16',
  cursorAccent: '#fffffe',
  selectionBackground: '#d5d0c6',
  black: '#1b1a16',
  red: '#c0392b',
  green: '#4f7a28',
  yellow: '#a56a12',
  blue: '#1f6fb2',
  magenta: '#a03fa0',
  cyan: '#0f7b74',
  white: '#6a655c',
  brightBlack: '#9a958a',
  brightRed: '#dc322f',
  brightGreen: '#5f9430',
  brightYellow: '#bd7d1c',
  brightBlue: '#268bd2',
  brightMagenta: '#c04ec0',
  brightCyan: '#2aa198',
  brightWhite: '#1b1a16',
};

/**
 * A real terminal view backed by xterm.js — the same emulator VS Code uses.
 * One instance per terminal id. It writes the raw PTY stream straight in (via
 * the terminal bus), reports user keystrokes, and keeps the PTY sized to the
 * viewport with the fit addon.
 */
export function XtermView({ terminalId, fontSize, onData, onResize }: XtermViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resolvedTheme = useStore((s) => s.resolvedTheme);
  // Read through a ref inside the create-once effect so a theme change doesn't
  // tear down and recreate the terminal (which would lose scrollback).
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  // Create the terminal once per mounted view.
  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: themeRef.current === 'dark' ? DARK_THEME : LIGHT_THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon()); } catch { /* optional */ }

    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;

    // Initial fit + report size.
    try {
      fit.fit();
      onResize(term.cols, term.rows);
    } catch { /* ignore */ }

    // Backfill anything received before this view mounted.
    const backfill = getTerminalScrollback(terminalId);
    if (backfill) term.write(backfill);

    // Live stream. Guard every write: data can arrive in the same tick the
    // terminal is being disposed (e.g. when the user closes the tab), and
    // writing to a disposed xterm throws "write to disposed terminal".
    const unsub = subscribeTerminalData(terminalId, (data) => {
      if (disposed) return;
      try { term.write(data); } catch { /* terminal disposed mid-write */ }
    });

    // User input → backend PTY.
    const dataDisp = term.onData((data) => { if (!disposed) onData(data); });

    term.focus();

    return () => {
      disposed = true;
      try { unsub(); } catch { /* ignore */ }
      try { dataDisp.dispose(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
    // Recreate only when the terminal id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Repaint on theme change, in place — recreating the terminal would drop the
  // user's scrollback.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
    } catch { /* terminal not ready / disposed */ }
  }, [resolvedTheme]);

  // Keep font size in sync without recreating the terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = fontSize;
      fitRef.current?.fit();
      onResize(term.cols, term.rows);
    } catch { /* terminal not ready / disposed */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // Refit on container resize.
  useEffect(() => {
    if (!hostRef.current) return;
    const ro = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      // Skip when the host is hidden/zero-sized (e.g. tab switched away or
      // closing) — fit() throws on a zero-dimension element.
      if (!hostRef.current || hostRef.current.clientHeight === 0) return;
      try {
        fit.fit();
        onResize(term.cols, term.rows);
      } catch { /* ignore */ }
    });
    ro.observe(hostRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="w-full h-full" />;
}
