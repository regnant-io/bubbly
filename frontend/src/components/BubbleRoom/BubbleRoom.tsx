import React from 'react';
import { ActivityBar } from './ActivityBar';
import { RightPanel } from './RightPanel';
import { EditorSidePanel } from './EditorSidePanel';
import { ChatPanel } from '../Chat/ChatPanel';
import { FileExplorer } from '../FileExplorer/FileExplorer';
import { EditorPanel } from '../FileExplorer/EditorPanel';
import { SettingsPanel } from '../Settings/SettingsPanel';
import { SpecPanel } from '../SpecPanel/SpecPanel';
import { AuditPanel } from '../Chat/AuditPanel';
import { ThreadPanel } from '../ThreadPanel/ThreadPanel';
import { WorkspacePanel } from '../Workspace/WorkspacePanel';
import { ResizablePanel } from '../Shared/ResizablePanel';
import { CommandPalette } from '../Shared/CommandPalette';
import { TitleBar } from './TitleBar';
import { useStore } from '../../store';
import { openThread } from '../../utils/threads';
import { isDesktop } from '../../hooks/useDesktop';
import { ModeTabs } from './ModeTabs';
import { ThemeToggle } from '../Shared/ThemeToggle';
import { ArrowLeft, ArrowRight, PanelLeft } from '../Shared/icons';

/** Unified workspace canvas. Only the right-hand tool stack uses raised cells. */
export function BubbleRoom() {
  const {
    activePanel,
    rightStack,
    leftHidden, setLeftHidden,
    navHidden, setNavHidden,
    uiMode, modeSwitching,
  } = useStore();
  const [sidebarPeek, setSidebarPeek] = React.useState(false);
  const rightPanelOpen = rightStack.length > 0;

  // Ctrl/Cmd+B toggles the whole left region (VS Code's muscle memory).
  // Ctrl/Cmd+Shift+B toggles JUST the icon rail, so you can keep the file tree
  // while reclaiming the nav strip.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'b') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) setNavHidden(!useStore.getState().navHidden);
      else setLeftHidden(!useStore.getState().leftHidden);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLeftHidden, setNavHidden]);

  const handleThreadSelect = (threadId: string) => { void openThread(threadId); };

  // Panels that live in the left sidebar (paired with the main editor/chat area).
  const sidebarPanel = (() => {
    switch (activePanel) {
      case 'files': return <FileExplorer />;
      case 'threads': return <ThreadPanel onThreadSelect={handleThreadSelect} />;
      case 'specs': return <SpecPanel />;
      case 'workspace': return <WorkspacePanel />;
      case 'audit': return <AuditPanel />;
      case 'settings': return null; // settings takes the full main area
      default: return null; // chat: no sidebar, chat fills main
    }
  })();

  // What fills the main (center) area.
  const mainArea = (() => {
    if (activePanel === 'settings') return <SettingsPanel />;
    // In editor mode the center is always the code editor (the AI lives on the
    // right), regardless of which left sidebar panel is active.
    if (uiMode === 'editor') return <EditorPanel />;
    switch (activePanel) {
      case 'files': return <EditorPanel />;
      case 'chat': return <ChatPanel />;
      // For threads/specs/workspace/audit, the content lives in the sidebar and
      // the main area shows the chat (so you can keep talking while browsing).
      default: return <ChatPanel />;
    }
  })();

  const showSidebar = sidebarPanel !== null;

  return (
    <div className="ide-root flex flex-col h-screen bg-surface-0 text-text">
      <CommandPalette onThreadSelect={handleThreadSelect} />

      {/* Draggable title strip (desktop only; replaces the hidden OS title bar) */}
      <TitleBar />

      {/* Browser fallback strip: the desktop TitleBar is hidden in the browser,
          so the same controls live here. */}
      {!isDesktop() && (
        <div className="browser-titlebar">
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setLeftHidden(!leftHidden)}
              className={`titlebar-icon ${leftHidden ? '' : 'titlebar-icon--active'}`}
              title={leftHidden ? 'Show sidebar (Ctrl+B)' : 'Hide sidebar (Ctrl+B)'}
              aria-label={leftHidden ? 'Show sidebar' : 'Hide sidebar'}
              aria-pressed={!leftHidden}
            >
              <PanelLeft size={15} />
            </button>
            <button onClick={() => window.history.back()} className="titlebar-icon" title="Back" aria-label="Back">
              <ArrowLeft size={15} />
            </button>
            <button onClick={() => window.history.forward()} className="titlebar-icon" title="Forward" aria-label="Forward">
              <ArrowRight size={15} />
            </button>
          </div>
          <div className="flex-1 flex justify-center"><ModeTabs /></div>
          <ThemeToggle />
        </div>
      )}

      {/* Body: activity bar + sidebar + main + right panel.
          Navigation and conversation share the page surface. */}
      <div className="workspace-body flex flex-1 min-h-0 relative">
        {/* Mode-switch loading veil — a brief, deliberate transition. */}
        {modeSwitching && (
          /*
            Three bouncing dots said "loading, indefinitely" for what is in fact
            a fixed, very short local re-layout — and bouncing is the loudest
            motion in the vocabulary, spent on the least important wait in the
            app. A breathing dot and the destination's name say the same thing
            in a quarter of the visual noise, and the veil itself carries the
            "hold on" message perfectly well.
          */
          <div className="absolute inset-0 z-30 bg-surface-0/60 backdrop-blur-[1px] flex items-center justify-center motion-appear pointer-events-none">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="motion-breathe w-1.5 h-1.5 rounded-full bg-accent" />
              <span>Switching to {uiMode === 'editor' ? 'Editor' : 'Agent'}…</span>
            </div>
          </div>
        )}

        {leftHidden && (
          <div
            className="sidebar-edge-trigger"
            aria-hidden="true"
            onMouseEnter={() => setSidebarPeek(true)}
          />
        )}
        {(!leftHidden || sidebarPeek) && (
          <div
            className={leftHidden ? 'sidebar-peek' : 'sidebar-pinned'}
            onMouseLeave={() => { if (leftHidden) setSidebarPeek(false); }}
          >
            <ActivityBar onThreadSelect={handleThreadSelect} />
          </div>
        )}
        {!leftHidden && showSidebar && (
          <ResizablePanel defaultWidth={280} minWidth={200} maxWidthPercent={32}
            storageKey="ide-sidebar-width" position="right"
            className="workspace-sidebar overflow-hidden flex flex-col shrink-0">
            {sidebarPanel}
          </ResizablePanel>
        )}

        {/* Center column: the chat/editor. Panels are now accessed via a 3-dot 
            menu in the top right of the chat UI, eliminating the bottom DockBar 
            and maximizing vertical screen space. */}
        <div className="workspace-content flex flex-1 min-w-0 min-h-0 gap-2">
          <div className="workspace-center flex flex-col flex-1 min-w-0 gap-2">
            <div className="workspace-main flex-1 min-h-0 overflow-hidden">
              {mainArea}
            </div>
          </div>

          {/*
            ONE right-hand region, not two.
            
            Editor mode used to put the context panels in their own column
            BESIDE the chat, which on any ordinary screen left the editor with
            about forty characters of width — and gave each panel a quarter of a
            narrow column to render in. Chat and context are now tabs sharing a
            single region (see EditorSidePanel), so opening a panel never takes
            width from the editor and every panel gets the full height.

            Vibe mode keeps the vertical stack: with no editor competing for
            width, seeing several panels at once is exactly what you want there.
          */}
          {(rightPanelOpen || uiMode === 'editor') && (
            <ResizablePanel
              defaultWidth={uiMode === 'editor' ? 540 : 580}
              minWidth={320}
              maxWidthPercent={50}
              storageKey={uiMode === 'editor' ? 'ide-side-bento-width' : 'ide-right-bento-width'}
              position="left"
              className="workspace-right overflow-hidden flex flex-col"
            >
              {uiMode === 'editor' ? <EditorSidePanel /> : <RightPanel />}
            </ResizablePanel>
          )}
        </div>
      </div>

      {/* Status bar removed - timer now appears inline with chat responses */}
    </div>
  );
}
