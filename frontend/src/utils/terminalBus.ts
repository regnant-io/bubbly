/**
 * Terminal data bus.
 *
 * xterm.js needs the raw PTY byte stream written straight into its instance
 * (it does its own buffering, cursor handling, and ANSI parsing). Routing that
 * stream through React state would re-render on every chunk and corrupt the
 * emulator. So the websocket layer publishes terminal data here, and the xterm
 * component subscribes for the specific terminal id it's showing.
 *
 * We also keep a per-terminal scrollback string so a freshly-mounted xterm (or
 * a tab the user switches back to) can backfill what it missed.
 */

type DataListener = (data: string) => void;

const listeners = new Map<string, Set<DataListener>>();
const scrollback = new Map<string, string>();
const MAX = 400_000;

/** Publish a chunk of output for a terminal id (called by the WS layer). */
export function publishTerminalData(id: string, data: string): void {
  const prev = scrollback.get(id) ?? '';
  const next = (prev + data).slice(-MAX);
  scrollback.set(id, next);
  const set = listeners.get(id);
  if (set) {
    for (const fn of set) {
      try { fn(data); } catch { /* ignore */ }
    }
  }
}

/** Subscribe to live data for a terminal id. Returns an unsubscribe fn. */
export function subscribeTerminalData(id: string, fn: DataListener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(id);
  };
}

/** Everything received so far for a terminal id (for backfill on mount/switch). */
export function getTerminalScrollback(id: string): string {
  return scrollback.get(id) ?? '';
}

/** When a backend id is assigned after creation, migrate any clientRef buffer. */
export function renameTerminalBuffer(fromId: string, toId: string): void {
  if (fromId === toId) return;
  const buf = scrollback.get(fromId);
  if (buf !== undefined) {
    scrollback.set(toId, (scrollback.get(toId) ?? '') + buf);
    scrollback.delete(fromId);
  }
}

export function clearTerminalBuffer(id: string): void {
  scrollback.delete(id);
  listeners.delete(id);
}
