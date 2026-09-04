import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, type RightContextId } from '../../store';
import { AuditPanel } from '../Chat/AuditPanel';
import { SpecPanel } from '../SpecPanel/SpecPanel';
import { TaskQueue } from '../TaskQueue/TaskQueue';
import { DiffViewer } from '../Shared/DiffViewer';
import { FilePreviewContent } from '../Shared/FilePreviewContent';
import { BubblyPreview } from './BubblyPreview';
import { BackgroundProcessesPanel } from './BackgroundProcessesPanel';
import { WatchersPanel } from './WatchersPanel';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { PlansPanel } from '../Chat/PlansPanel';
import { ArtifactsPanel } from '../Artifacts/ArtifactsPanel';
import {
  Monitor, Server, GitBranch, Terminal, ClipboardList, CheckCircle, Clock,
  X, ChevronDown, ListTree, FileBox, File, Eye,
} from '../Shared/icons';

function DiffView() {
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  return (
    <div className="h-full overflow-y-auto p-3">
      <DiffViewer diffs={pendingDiffs} />
    </div>
  );
}

function FilePreviewView() {
  const filePreview = useStore((s) => s.filePreview);
  if (!filePreview) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <p className="text-sm text-text-dim text-center">
          No file open. Click a file name in the conversation to see it here.
        </p>
      </div>
    );
  }
  return <FilePreviewContent {...filePreview} />;
}

export const RIGHT_PANEL_META: Record<RightContextId, { label: string; icon: typeof Monitor; render: () => React.ReactNode }> = {
  preview: { label: 'Preview', icon: Monitor, render: () => <BubblyPreview /> },
  background: { label: 'Background', icon: Server, render: () => <BackgroundProcessesPanel /> },
  watchers: { label: 'Watchers', icon: Eye, render: () => <WatchersPanel /> },
  diff: { label: 'Changes', icon: GitBranch, render: () => <DiffView /> },
  terminal: { label: 'Terminal', icon: Terminal, render: () => <TerminalPanel /> },
  spec: { label: 'Specs', icon: ClipboardList, render: () => <SpecPanel /> },
  tasks: { label: 'Tasks', icon: CheckCircle, render: () => <TaskQueue /> },
  audit: { label: 'Audit', icon: Clock, render: () => <AuditPanel /> },
  plans: { label: 'Plans', icon: ListTree, render: () => <PlansPanel /> },
  artifacts: { label: 'Artifacts', icon: FileBox, render: () => <ArtifactsPanel /> },
  'file-preview': { label: 'File', icon: File, render: () => <FilePreviewView /> },
};

/** Header height of a collapsed card, in px. Must match the h-8 below. */
const HEADER_PX = 32;
const GAP_PX = 8;
/** No card may be squeezed below this — under it, nothing is readable. */
const MIN_CARD_PX = 96;

/**
 * Right-side context STACK, with REAL vertical sizing.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every card used to be `flex-1`, so four open panels each got a quarter of the
 * height whether or not that made sense. A terminal with two visible rows, a
 * diff showing three lines, a preview too short to render its own toolbar —
 * everything technically present and nothing usable, which is what "content all
 * over each other" looks like in practice. And there was no way to fix it: the
 * only control was closing panels.
 *
 * Cards now carry an explicit weight, dragged from the divider between them and
 * remembered per panel. A collapsed card costs only its header, so collapsing
 * one genuinely gives its space to the others. Weights are clamped so no card
 * can be dragged into uselessness, and a stack that has never been touched
 * still divides evenly — the default behaviour is unchanged, it is just no
 * longer the only behaviour.
 */
export function RightPanel() {
  const rightStack = useStore((s) => s.rightStack);
  const closeRightContext = useStore((s) => s.closeRightContext);
  const pendingDiffs = useStore((s) => s.pendingDiffs);
  const watchers = useStore((s) => s.watchers);
  const panelWeights = useStore((s) => s.rightPanelWeights);
  const setPanelWeight = useStore((s) => s.setRightPanelWeight);
  const [collapsed, setCollapsed] = React.useState<Set<RightContextId>>(new Set());
  const containerRef = React.useRef<HTMLDivElement>(null);
  /** Live height of the stack, watched so the weights can be re-clamped. */
  const [containerHeight, setContainerHeight] = React.useState(0);

  const toggleCollapse = (id: RightContextId) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const expanded = React.useMemo(
    () => rightStack.filter((id) => !collapsed.has(id)),
    [rightStack, collapsed],
  );

  /** Space the expanded cards actually get to share, in px. */
  const availablePx = React.useMemo(() => {
    const chrome =
      (rightStack.length - expanded.length) * (HEADER_PX + GAP_PX) +
      Math.max(0, expanded.length - 1) * GAP_PX;
    return Math.max(0, containerHeight - chrome);
  }, [containerHeight, rightStack.length, expanded.length]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setContainerHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  /**
   * KEEP EVERY CARD USABLE, WHATEVER THE WINDOW DOES.
   *
   * Weights are proportions, and proportions survive a resize — that is why
   * they are weights. What they do NOT survive is the window becoming small
   * enough that a card's SHARE of it is a few pixels: a stack tuned at 900px
   * with one card at 8% has that card rendering four pixels tall at 300px, and
   * "content all over each other" is precisely what that looks like.
   *
   * So after any change to the container or the stack, re-clamp: if a card
   * would fall under MIN_CARD_PX, redistribute. If there is not even enough
   * room for every card to reach the minimum, fall back to an even split —
   * equally cramped is at least legible and predictable, where proportionally
   * cramped is neither.
   */
  React.useEffect(() => {
    if (availablePx <= 0 || expanded.length === 0) return;

    const weights = expanded.map((id) => panelWeights[id] ?? 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    if (availablePx < MIN_CARD_PX * expanded.length) {
      // Not enough room for anyone. Even split, once — guarded so this cannot
      // fight the user's drag on every frame.
      if (weights.some((w) => Math.abs(w - 1) > 0.001)) {
        for (const id of expanded) setPanelWeight(id, 1);
      }
      return;
    }

    const minWeight = (MIN_CARD_PX / availablePx) * total;
    const starved = expanded.filter((id, i) => weights[i] < minWeight);
    if (starved.length === 0) return;

    const healthy = expanded.filter((id) => !starved.includes(id));
    const needed = starved.length * minWeight;
    const healthyTotal = healthy.reduce((sum, id) => sum + (panelWeights[id] ?? 1), 0);
    const remaining = Math.max(total - needed, 0.001);

    for (const id of starved) setPanelWeight(id, minWeight);
    for (const id of healthy) {
      const share = healthyTotal > 0 ? (panelWeights[id] ?? 1) / healthyTotal : 1 / Math.max(healthy.length, 1);
      setPanelWeight(id, Math.max(share * remaining, minWeight));
    }
  }, [availablePx, expanded, panelWeights, setPanelWeight]);

  /**
   * Drag a divider: move weight between the card above it and the one below.
   *
   * Weights rather than pixels, so the split survives the window being resized
   * — a stack tuned at one height stays proportionally right at another.
   */
  const startDrag = (e: React.PointerEvent, aboveId: RightContextId, belowId: RightContextId) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const startY = e.clientY;
    const totalPx = availablePx;
    if (totalPx <= 0) return;

    const wAbove = panelWeights[aboveId] ?? 1;
    const wBelow = panelWeights[belowId] ?? 1;
    const totalWeight = expanded.reduce((sum, id) => sum + (panelWeights[id] ?? 1), 0);
    const pxPerWeight = totalPx / Math.max(totalWeight, 0.0001);
    const minWeight = MIN_CARD_PX / Math.max(pxPerWeight, 0.0001);
    // The pair's combined weight is fixed for the whole drag: whatever one card
    // gains the other loses, so no other card in the stack is disturbed.
    const pairWeight = wAbove + wBelow;

    const onMove = (ev: PointerEvent) => {
      const deltaWeight = (ev.clientY - startY) / Math.max(pxPerWeight, 0.0001);
      // CLAMP rather than bail out. The old code returned early once either
      // side hit its minimum, which meant dragging fast past the limit left the
      // divider stuck wherever the last in-range frame put it — and dragging
      // back did nothing until the pointer caught up with the stale position.
      const nextAbove = Math.min(Math.max(wAbove + deltaWeight, minWeight), pairWeight - minWeight);
      if (!Number.isFinite(nextAbove) || pairWeight - minWeight < minWeight) return;
      setPanelWeight(aboveId, nextAbove);
      setPanelWeight(belowId, pairWeight - nextAbove);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  if (rightStack.length === 0) return null;

  const META = RIGHT_PANEL_META;
  const liveWatchers = watchers.filter((w) => !w.settled).length;

  const badgeFor = (id: RightContextId): number | null => {
    if (id === 'diff') return pendingDiffs.length || null;
    if (id === 'watchers') return liveWatchers || null;
    return null;
  };

  /*
   * ONE SEPARATOR BETWEEN EVERY PAIR OF CARDS, ALWAYS.
   *
   * Spacing used to come from a margin on the card — `mt-2` when the card did
   * NOT show a divider — which is the wrong card and the wrong condition. The
   * gap between A and B was decided by whether B had a divider under IT, so
   * collapsing a card in the middle of the stack removed a gap two rows away.
   * A separator element between each pair puts the decision where it belongs:
   * draggable when there is space on both sides to trade, a plain spacer when
   * there is not.
   */
  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      <AnimatePresence initial={false}>
        {rightStack.map((id, index) => {
          const meta = META[id];
          if (!meta) return null;
          const isCollapsed = collapsed.has(id);
          const Icon = meta.icon;
          const badge = badgeFor(id);

          // The next EXPANDED card below this one, which is what a divider
          // dragged here trades space with.
          const belowId = rightStack.slice(index + 1).find((x) => !collapsed.has(x));
          const draggable = !isCollapsed && !!belowId;
          const isLast = index === rightStack.length - 1;

          return (
            <React.Fragment key={id}>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8, height: 0 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                /*
                 * flexBasis:0 + flexGrow is what makes the weights mean
                 * something; minHeight:0 is what stops a card with tall content
                 * from refusing to shrink and pushing the ones below it off the
                 * bottom of the stack — the single most common way this layout
                 * came apart.
                 */
                style={isCollapsed ? undefined : { flexGrow: panelWeights[id] ?? 1, flexBasis: 0, minHeight: MIN_CARD_PX }}
                className={`card bg-surface-1 overflow-hidden flex flex-col min-w-0 ${isCollapsed ? 'shrink-0' : 'min-h-0'}`}
              >
                {/* Card header */}
                <div className="flex items-center gap-2 px-3 h-8 border-b border-border shrink-0 bg-surface-1">
                  <Icon size={13} className="text-text-dim shrink-0" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted flex-1 truncate">
                    {meta.label}
                  </span>
                  {badge !== null && (
                    <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-accent/20 text-accent-bright text-[9px] font-bold flex items-center justify-center tabular-nums">
                      {badge}
                    </span>
                  )}
                  <button
                    onClick={() => toggleCollapse(id)}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                    className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors"
                  >
                    <ChevronDown size={13} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                  <button
                    onClick={() => closeRightContext(id)}
                    title="Close"
                    className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
                {/* min-w-0 as well as min-h-0: a panel with a wide table must
                    scroll inside itself rather than widening the whole stack. */}
                {!isCollapsed && <div className="flex-1 min-h-0 min-w-0 overflow-hidden">{meta.render()}</div>}
              </motion.div>

              {!isLast && (
                draggable ? (
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize ${meta.label}`}
                    onPointerDown={(e) => startDrag(e, id, belowId!)}
                    onDoubleClick={() => { setPanelWeight(id, 1); setPanelWeight(belowId!, 1); }}
                    title="Drag to resize · double-click to even out"
                    className="group h-2 shrink-0 cursor-row-resize flex items-center justify-center touch-none"
                  >
                    <div className="h-[2px] w-8 rounded-full bg-border group-hover:bg-accent/60 transition-colors" />
                  </div>
                ) : (
                  <div className="h-2 shrink-0" aria-hidden />
                )
              )}
            </React.Fragment>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
