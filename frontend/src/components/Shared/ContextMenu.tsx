import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Optional keyboard hint shown right-aligned. */
  hint?: string;
  /** Render a divider AFTER this item. */
  separatorAfter?: boolean;
}

interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Reusable right-click context menu. A single portal-rendered menu is driven by
 * `useContextMenu()`, which any component uses to attach an `onContextMenu`
 * handler with its own item list. Animated with framer-motion; repositions so it
 * never overflows the viewport; closes on outside click / Escape / scroll.
 */
export function ContextMenuHost({ state, onClose }: { state: OpenState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Reposition to stay on-screen once measured.
  useLayoutEffect(() => {
    if (!state) return;
    const el = ref.current;
    const mw = el?.offsetWidth ?? 220;
    const mh = el?.offsetHeight ?? 0;
    const x = Math.min(state.x, window.innerWidth - mw - 8);
    const y = Math.min(state.y, window.innerHeight - mh - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [state, onClose]);

  return createPortal(
    <AnimatePresence>
      {state && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: -4 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}
          className="min-w-[200px] max-w-[280px] rounded-xl border border-border bg-surface-1 shadow-2xl py-1 text-sm"
          role="menu"
        >
          {state.items.map((item, i) => (
            <React.Fragment key={i}>
              <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { if (!item.disabled) { onClose(); item.onSelect(); } }}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors disabled:opacity-40 ${
                  item.danger ? 'text-red-agent hover:bg-error-bg' : 'text-text-muted hover:bg-surface-3 hover:text-text'
                }`}
              >
                {item.icon && <span className="shrink-0 w-4 flex items-center justify-center">{item.icon}</span>}
                <span className="flex-1 truncate">{item.label}</span>
                {item.hint && <span className="text-[10px] text-text-dim shrink-0">{item.hint}</span>}
              </button>
              {item.separatorAfter && i < state.items.length - 1 && <div className="my-1 border-t border-border" />}
            </React.Fragment>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Hook that owns the single context menu instance. Returns:
 *  - `menu`: render <ContextMenuHost {...menu} /> once (e.g. app root).
 *  - `openMenu(e, items)`: call from any element's onContextMenu.
 *  - `bind(items | () => items)`: convenience — spreads an onContextMenu prop.
 */
export function useContextMenu() {
  const [state, setState] = useState<OpenState | null>(null);
  const close = useCallback(() => setState(null), []);
  const openMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    if (!items.length) return;
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const bind = useCallback(
    (items: ContextMenuItem[] | (() => ContextMenuItem[])) => ({
      onContextMenu: (e: React.MouseEvent) => openMenu(e, typeof items === 'function' ? items() : items),
    }),
    [openMenu],
  );
  return { menu: { state, onClose: close }, openMenu, bind };
}

// --- App-wide provider so any component can open the shared menu ------------

interface ContextMenuApi {
  openMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  bind: (items: ContextMenuItem[] | (() => ContextMenuItem[])) => { onContextMenu: (e: React.MouseEvent) => void };
}

const Ctx = React.createContext<ContextMenuApi | null>(null);

/** Mount once near the app root. Renders the single portal menu. */
export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const { menu, openMenu, bind } = useContextMenu();
  return (
    <Ctx.Provider value={{ openMenu, bind }}>
      {children}
      <ContextMenuHost {...menu} />
    </Ctx.Provider>
  );
}

/** Use inside any component to attach right-click menus. Safe no-op if no provider. */
export function useAppContextMenu(): ContextMenuApi {
  const ctx = React.useContext(Ctx);
  return ctx ?? { openMenu: () => {}, bind: () => ({ onContextMenu: () => {} }) };
}
