import React from 'react';
import { ActivityBar } from './ActivityBar';
import { StatusBar } from './StatusBar';
import { RightPanel } from './RightPanel';
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
import { loadThread } from '../../utils/messageReconstruction';
import { fetchPromptCheckpoints } from '../../hooks/useApi';
import { isDesktop } from '../../hooks/useDesktop';
import { ModeTabs } from './ModeTabs';
import { ThemeToggle } from '../Shared/ThemeToggle';
import { PanelLeft } from '../Shared/icons';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Conventional IDE shell layout (VS Code-style):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ title bar (drag region + brand)               │
 *   ├──┬───────────────┬────────────────────┬───────┤
 *   │A │  primary      │   main area        │ right │
 *   │c │  sidebar      │   (editor/chat)    │ panel │
 *   │t │  (tree/etc)   │                    │       │
 *   │  ├───────────────┴────────────────────┤       │
 *   │  │  bottom panel (terminal)           │       │
 *   ├──┴────────────────────────────────────┴───────┤
 *   │ status bar                                     │
 *   └────────────────────────────────────────────────┘
 *
 * Flush panels with hairline borders — dense and predictable, not floating cards.
 */
export function BubbleRoom() {
  const {
    activePanel, setActivePanel, setCurrentSessionId, clearMessages, loadMessages,
    rightStack,
    leftHidden, setLeftHidden,
    navHidden, setNavHidden,
    uiMode, modeSwitching,
  } = useStore();
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

  const handleThreadSelect = async (threadId: string) => {
    try {
      const { messages, plan, sessionChanges, error } = await loadThread(threadId);
      if (error) throw new Error(error);
      const store = useStore.getState();
      store.clearMessages();
      store.clearDiffs();
      loadMessages(messages);
      // Restore persisted thread metadata so the plan strip and the Changes
      // panel reflect this thread exactly, even after a refresh.
      store.setAgentPlan(plan ?? []);
      if (sessionChanges && sessionChanges.length > 0) store.addDiff(sessionChanges);
      setCurrentSessionId(threadId);
      setActivePanel('chat');
      // Restore per-prompt revert buttons for this loaded thread by linking the
      // workspace's prompt checkpoints back to their user messages.
      try {
        const ws = store.workspacePath;
        if (ws) {
          const cps = await fetchPromptCheckpoints(ws, threadId);
          store.setPromptCheckpoints(cps.map((c) => ({ id: c.id, prompt: c.prompt, createdAt: c.createdAt })));
          store.linkCheckpointsToMessages(cps.map((c) => ({ id: c.id, prompt: c.prompt, createdAt: c.createdAt })));
        }
      } catch { /* checkpoints are best-effort */ }
    } catch (err) {
      console.error('Failed to load thread:', err);
      alert(err instanceof Error ? err.message : 'Failed to load thread');
    }
  };

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
          so surface the Vibe/Editor tabs here too, top-left. */}
      {!isDesktop() && (
        <div className="flex items-center h-9 shrink-0 px-2 gap-2">
          <ModeTabs />
          <div className="flex-1" />
          <ThemeToggle />
        </div>
      )}

      {/* Body: activity bar + sidebar + main + right panel.
          Flat page background with floating cards separated by an 8px gutter. */}
      <div className="flex flex-1 min-h-0 relative gap-2 p-2">
        {/* Mode-switch loading veil — a brief, deliberate transition. */}
        {modeSwitching && (
          <div className="absolute inset-0 z-30 bg-surface-0/60 backdrop-blur-[1px] flex items-center justify-center animate-fade-in pointer-events-none">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
              <span className="ml-1">Switching to {uiMode === 'editor' ? 'Editor' : 'Agents'}…</span>
            </div>
          </div>
        )}

        {/* Left rail (activity bar + sidebar) — hideable for a focused view. */}
        <AnimatePresence initial={false}>
          {!leftHidden && (
            <motion.div
              key="left-rail"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex gap-2 min-h-0 overflow-hidden shrink-0"
            >
              {/* The icon rail hides independently of the sidebar. */}
              <AnimatePresence initial={false}>
                {!navHidden && (
                  <motion.div
                    key="activity-rail"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 'auto', opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                    className="overflow-hidden shrink-0 flex"
                  >
                    <ActivityBar />
                  </motion.div>
                )}
              </AnimatePresence>
              {showSidebar && (
                <ResizablePanel
                  defaultWidth={280}
                  minWidth={200}
                  maxWidthPercent={32}
                  storageKey="ide-sidebar-width"
                  position="right"
                  className="card bg-surface-1 overflow-hidden flex flex-col shrink-0"
                >
                  {sidebarPanel}
                </ResizablePanel>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Floating restore affordance. Covers BOTH hidden states — without it,
            hiding the rail while the sidebar is closed would leave no way back
            except the keyboard. */}
        {(leftHidden || navHidden) && (
          <motion.button
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            onClick={() => { setLeftHidden(false); setNavHidden(false); }}
            title={leftHidden ? 'Show side panel (Ctrl+B)' : 'Show nav rail (Ctrl+Shift+B)'}
            className="absolute left-3 top-3 z-20 p-1.5 rounded-lg bg-surface-2/90 backdrop-blur border border-border shadow-lg text-text-dim hover:text-text transition-colors"
          >
            <PanelLeft size={14} />
          </motion.button>
        )}

        {/* Center column: the chat/editor. The bottom button bar lives BELOW
            this whole body (above the status bar); the panels it opens appear in
            the right stack, not here. */}
        <div className="flex flex-1 min-w-0 min-h-0 gap-2">
          <div className="flex flex-col flex-1 min-w-0 gap-2">
            <div className="flex-1 min-h-0 overflow-hidden card bg-surface-1">
              {mainArea}
            </div>
          </div>

          {/* Right stack. In Vibe mode it holds the open context panels
              (preview/background/changes/specs/tasks/audit, stacked). In Editor
              mode it becomes the docked AI assistant (chat). */}
          {(rightPanelOpen || uiMode === 'editor') && (
            <ResizablePanel
              defaultWidth={uiMode === 'editor' ? 420 : 400}
              minWidth={300}
              maxWidthPercent={45}
              storageKey={uiMode === 'editor' ? 'ide-ai-width' : 'ide-right-width'}
              position="left"
              className={uiMode === 'editor' ? 'card bg-surface-1 overflow-hidden flex flex-col shrink-0' : 'overflow-hidden flex flex-col shrink-0'}
            >
              {uiMode === 'editor' ? <ChatPanel /> : <RightPanel />}
            </ResizablePanel>
          )}
        </div>
      </div>

      {/* Status pill — also hosts the context launcher buttons (Browser,
          Background, Changes, Terminal, Specs, Tasks, Audit). */}
      <div className="shrink-0 card bg-surface-1 mx-2 mb-2 overflow-hidden">
        <StatusBar />
      </div>
    </div>
  );
}
