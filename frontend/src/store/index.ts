import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatMessage, Session, Settings, FileDiff, Spec } from '../types';

/** A context that can be opened as a panel in the right-side stack. */
export type RightContextId = 'preview' | 'background' | 'diff' | 'terminal' | 'spec' | 'tasks' | 'audit';

/**
 * Normalize a spec coming off the wire so array fields are NEVER undefined.
 * The backend may omit `tasks`/`requirements`/`properties` for a staged spec
 * (e.g. one still in the requirements phase), and rendering code reads
 * `.length`/`.map` on them. A missing array previously crashed the whole React
 * tree ("Cannot read properties of undefined (reading 'length')") mid-run.
 */
function normalizeSpec(spec: Spec): Spec {
  return {
    ...spec,
    requirements: spec.requirements ?? [],
    properties: spec.properties ?? [],
    tasks: spec.tasks ?? [],
  };
}

export interface TerminalTab {
  id: string;          // backend terminal id (or temp clientRef before created)
  clientRef: string;   // stable local ref
  title: string;
  cwd: string;
  buffer: string;      // accumulated output
  alive: boolean;
  /** Who owns this terminal: a user-driven shell, or an agent command/process. */
  origin: 'user' | 'agent';
  /** Agent terminals are read-only in the UI (no input line) — they mirror what the agent ran. */
  readOnly?: boolean;
  exitCode?: number | null;
  /** Set when the shell appears blocked waiting for keyboard input. */
  awaitingInput?: { kind: string; prompt: string; suggestedReply?: string } | null;
}

interface AppState {
  // Layout
  activePanel: 'chat' | 'threads' | 'files' | 'specs' | 'audit' | 'settings' | 'workspace';
  /** Top-level workspace layout: 'vibe' = chat-centric, 'editor' = IDE-centric (editor main, AI on the right). */
  uiMode: 'vibe' | 'editor';
  /** True briefly while switching modes, to drive a loading transition. */
  modeSwitching: boolean;
  /** Live editor status for the status bar (cursor, language, EOL, indentation). */
  editorStatus: { language: string; line: number; col: number; eol: 'LF' | 'CRLF'; indent: number } | null;
  /** Latest validation issues, surfaced in the Terminal panel's Problems tab. */
  lastValidation: Array<{ file: string; line?: number; severity: 'error' | 'warning'; message: string }>;
  /** App boot lifecycle: 'loading' until initial settings/sessions are fetched. */
  bootState: 'loading' | 'ready';
  /** Whether the first-run onboarding has been completed/dismissed. */
  onboardingComplete: boolean;
  sidebarOpen: boolean;
  /** Hide the whole left rail (activity bar + sidebar) for a distraction-free view. */
  leftHidden: boolean;
  rightPanelOpen: boolean;
  /** @deprecated kept only for persisted-state compatibility. */
  rightPanelTab: 'spec' | 'audit' | 'tasks';
  /** The right side is a STACK of open context panels. The bottom button bar and
   *  the activity rail toggle these; when several are open they stack vertically. */
  rightStack: RightContextId[];
  /** Latest Bubbly Preview frame (screenshot filename served via the API). */
  previewFrame: string | null;
  /** Monotonic counter so the preview <img> refreshes even on the same file. */
  previewFrameSeq: number;
  /** URL loaded in the live embedded browser (webview/iframe). */
  previewUrl: string | null;
  
  // Panel sizes (in pixels)
  panelSizes: {
    sidebar: number;
    fileExplorer: number;
    rightPanel: number;
  };
  
  // File explorer state
  expandedFolders: string[]; // Array instead of Set for serialization

  // Session
  currentSessionId: string | null;
  currentThreadType: 'vibe_coding' | 'spec_session';
  sessions: Session[];
  isRunning: boolean;
  /** Wall-clock ms when the current run started, for a live-updating runtime readout. Null when idle. */
  runStartedAt: number | null;
  /** Duration of the most recently completed run, frozen once it ends. */
  lastRunDurationMs: number | null;

  // Ollama retry status
  ollamaRetryStatus: {
    isRetrying: boolean;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  } | null;

  // Chat
  messages: ChatMessage[];
  streamingMessageId: string | null;
  streamingContent: string;
  /** Unsent input draft, persisted so a refresh never loses typed content. */
  chatDraft: string;

  // Workspace
  workspacePath: string;
  /** Recently-opened workspace paths (most recent first), for the input dropdown. */
  recentWorkspaces: string[];
  /** Per-prompt workspace checkpoints (newest first), for "undo last N prompts". */
  promptCheckpoints: Array<{ id: string; prompt: string; createdAt: string }>;
  openFile: string | null;
  openFileContent: string | null;
  /** Open editor tabs (multi-file). content is null until loaded/rehydrated. */
  editorTabs: Array<{ path: string; content: string | null; dirty?: boolean }>;
  activeEditorPath: string | null;

  // Diffs
  pendingDiffs: FileDiff[];

  // Specs
  specs: Spec[];

  // Interactive terminals (IDE integrated terminal)
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  bottomPanelOpen: boolean;
  bottomPanelTab: 'terminal' | 'problems' | 'output' | 'preview' | 'background' | 'diff';

  // Live task progress (spec multi-agent dispatch)
  taskProgress: Record<string, { phase: string; detail?: string; taskTitle?: string; index?: number; total?: number }>;

  // Agent plan (model-maintained todo list) and pending question
  agentPlan: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>;
  /** A worker sub-agent's own mini-plan, shown separately so it never clobbers the main plan. */
  workerPlan: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>;
  pendingQuestion: { questionId: string; question: string; options?: string[] } | null;

  // Command palette
  commandPaletteOpen: boolean;

  // Settings
  settings: Settings | null;
  settingsLoaded: boolean;

  // Theme
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: 'light' | 'dark';

  // Actions
  setActivePanel: (panel: AppState['activePanel']) => void;
  setUiMode: (mode: AppState['uiMode']) => void;
  setEditorStatus: (status: AppState['editorStatus']) => void;
  setLastValidation: (issues: AppState['lastValidation']) => void;
  setBootState: (state: AppState['bootState']) => void;
  setOnboardingComplete: (complete: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setLeftHidden: (hidden: boolean) => void;
  /** @deprecated bottom is now a button bar; use openRightContext. */
  revealBottomPanel: (tab: AppState['bottomPanelTab']) => void;
  /** Right-side context stack management (opens a panel on the right). */
  openRightContext: (id: RightContextId) => void;
  closeRightContext: (id: RightContextId) => void;
  toggleRightContext: (id: RightContextId) => void;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelTab: (tab: AppState['rightPanelTab']) => void;
  /** Push a new Bubbly Preview frame and reveal the preview panel. */
  setPreviewFrame: (file: string) => void;
  /** Load a URL in the live embedded browser and reveal the preview panel. */
  setPreviewUrl: (url: string | null) => void;
  
  setPanelSize: (panel: keyof AppState['panelSizes'], size: number) => void;
  toggleFolderExpansion: (path: string) => void;
  setExpandedFolders: (paths: string[]) => void;

  setCurrentSessionId: (id: string | null) => void;
  setCurrentThreadType: (t: 'vibe_coding' | 'spec_session') => void;
  setSessions: (sessions: Session[]) => void;
  setIsRunning: (running: boolean) => void;
  /** Marks a run's start; call once right when a chat message is sent. */
  startRunTimer: () => void;
  /** Freezes the elapsed time into lastRunDurationMs; call on 'done'/'error'. */
  stopRunTimer: () => void;
  setOllamaRetryStatus: (status: AppState['ollamaRetryStatus']) => void;

  addMessage: (msg: ChatMessage) => void;
  /** Create or update a tool_call message keyed by callId. A `tool_started`
   *  event creates it (args unknown yet); the later `tool_call` fills in args. */
  upsertToolCall: (callId: string, tool: string, args?: Record<string, unknown>) => void;
  updateLastAssistantMessage: (content: string, streaming: boolean) => void;
  appendThinking: (delta: string) => void;
  finalizeThinking: () => void;
  setApprovalStatus: (approvalId: string, status: 'approved' | 'rejected' | 'expired') => void;
  removeLastApprovalPreparing: () => void;
  clearMessages: () => void;
  loadMessages: (messages: ChatMessage[]) => void;
  attachCheckpointToLastUserMessage: (checkpointId: string) => void;
  linkCheckpointsToMessages: (checkpoints: Array<{ id: string; prompt: string; createdAt: string }>) => void;
  truncateMessagesFrom: (messageId: string) => void;
  setChatDraft: (draft: string) => void;
  appendTerminalOutput: (terminalId: string, stream: 'stdout' | 'stderr', content: string) => void;
  finalizeTerminal: (terminalId: string, exitCode: number, duration: number) => void;
  toggleTerminalExpanded: (terminalId: string) => void;

  setWorkspacePath: (path: string) => void;
  /** Switch the active workspace (persists it and records it in recents). */
  switchWorkspace: (path: string) => void;
  /** Record a per-prompt checkpoint emitted at the start of a run. */
  addPromptCheckpoint: (cp: { id: string; prompt: string; createdAt: string }) => void;
  setPromptCheckpoints: (cps: Array<{ id: string; prompt: string; createdAt: string }>) => void;
  setOpenFile: (path: string | null, content: string | null) => void;
  setActiveEditorTab: (path: string) => void;
  closeEditorTab: (path: string) => void;
  updateTabContent: (path: string, content: string) => void;
  setTabDirtyContent: (path: string, content: string) => void;
  markTabSaved: (path: string) => void;

  addDiff: (diffs: FileDiff[]) => void;
  clearDiffs: () => void;

  setSpecs: (specs: Spec[]) => void;
  upsertSpec: (spec: Spec) => void;
  setSessionSpecId: (sessionId: string, specId: string) => void;

  // Terminals
  addTerminal: (tab: TerminalTab) => void;
  bindTerminal: (clientRef: string, id: string, title: string, cwd: string) => void;
  appendTerminalData: (id: string, data: string) => void;
  markTerminalExited: (id: string) => void;
  setTerminalAwaitingInput: (id: string, awaitingInput: { kind: string; prompt: string; suggestedReply?: string } | null) => void;
  closeTerminal: (id: string) => void;
  setActiveTerminal: (id: string | null) => void;
  /** Create/append a read-only agent terminal tab (so AI commands aren't a blackbox). */
  upsertAgentTerminal: (id: string, patch: { title?: string; cwd?: string; data?: string; command?: string; alive?: boolean; exitCode?: number | null }) => void;
  setBottomPanelOpen: (open: boolean) => void;
  setBottomPanelTab: (tab: AppState['bottomPanelTab']) => void;

  // Task progress
  setTaskProgress: (taskId: string, p: { phase: string; detail?: string; taskTitle?: string; index?: number; total?: number }) => void;
  clearTaskProgress: () => void;

  // Agent plan + questions
  setAgentPlan: (steps: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>) => void;
  setWorkerPlan: (steps: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>) => void;
  setPendingQuestion: (q: AppState['pendingQuestion']) => void;
  reconcilePlanOnStop: () => void;

  // Delegated worker agents (live cards in the chat)
  upsertDelegation: (d: {
    delegationId: string;
    instruction?: string;
    targetFiles?: string[];
    acceptance?: string;
    phase?: string;
    detail?: string;
    report?: string;
    filesTouched?: string[];
    validationOk?: boolean;
  }) => void;

  // Parallel agent lanes
  registerParallelLane: (batchId: string, lane: import('./../types').ParallelLane) => void;
  updateParallelLane: (lane: string, patch: Partial<import('./../types').ParallelLane>) => void;

  // Command palette
  setCommandPaletteOpen: (open: boolean) => void;

  setSettings: (settings: Settings) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setResolvedTheme: (theme: 'light' | 'dark') => void;
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11);
}

// Read initial panel from URL hash
function getInitialPanel(): AppState['activePanel'] {
  // Supports both "#/panel" and "#/thread/<id>" (thread → chat panel).
  const raw = window.location.hash.replace(/^#\/?/, '');
  const validPanels = ['chat', 'threads', 'files', 'specs', 'audit', 'settings', 'workspace'];
  const first = raw.split('/')[0];
  if (first === 'thread') return 'chat';
  if (validPanels.includes(first)) {
    return first as AppState['activePanel'];
  }
  return 'chat';
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      activePanel: getInitialPanel(),
      uiMode: 'vibe',
      modeSwitching: false,
      editorStatus: null,
      lastValidation: [],
      bootState: 'loading',
      onboardingComplete: false,
      sidebarOpen: true,
      leftHidden: false,
      rightPanelOpen: false,
      rightPanelTab: 'tasks',
      rightStack: [],
      previewFrame: null,
      previewFrameSeq: 0,
      previewUrl: null,
      
      panelSizes: {
        sidebar: 64, // Default sidebar width
        fileExplorer: 224, // Default file explorer width (56 * 4 = 224px)
        rightPanel: 384, // Default right panel width
      },
      
      expandedFolders: [],

      currentSessionId: null,
      currentThreadType: 'vibe_coding',
      sessions: [],
      isRunning: false,
      runStartedAt: null,
      lastRunDurationMs: null,
      ollamaRetryStatus: null,

      messages: [],
      streamingMessageId: null,
      streamingContent: '',
      chatDraft: '',

      workspacePath: '',
      recentWorkspaces: [],
      promptCheckpoints: [],
      openFile: null,
      openFileContent: null,
      editorTabs: [],
      activeEditorPath: null,

      pendingDiffs: [],
      specs: [],
      settings: null,
      settingsLoaded: false,

      terminals: [],
      activeTerminalId: null,
      bottomPanelOpen: false,
      bottomPanelTab: 'terminal',
      taskProgress: {},
      agentPlan: [],
      workerPlan: [],
      pendingQuestion: null,
      commandPaletteOpen: false,

      theme: 'system',
      resolvedTheme: 'dark',

      setActivePanel: (panel) => {
        // Keep the URL in sync. When navigating to chat with an active thread,
        // preserve the deep-link form (#/thread/<id>); otherwise use #/<panel>.
        const state = useStore.getState();
        if (panel === 'chat' && state.currentSessionId) {
          window.location.hash = `/thread/${state.currentSessionId}`;
        } else {
          window.location.hash = `/${panel}`;
        }
        set({ activePanel: panel });
      },
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setLeftHidden: (leftHidden) => set({ leftHidden }),
      // Back-compat: map the old bottom-panel reveal onto the right stack.
      revealBottomPanel: (tab) => {
        const id = (tab === 'problems' || tab === 'output') ? 'terminal' : tab;
        set((s) => ({ rightStack: s.rightStack.includes(id as RightContextId) ? s.rightStack : [...s.rightStack, id as RightContextId], rightPanelOpen: true }));
      },
      openRightContext: (id) =>
        set((s) => ({ rightStack: s.rightStack.includes(id) ? s.rightStack : [...s.rightStack, id], rightPanelOpen: true })),
      closeRightContext: (id) =>
        set((s) => {
          const rightStack = s.rightStack.filter((x) => x !== id);
          return { rightStack, rightPanelOpen: rightStack.length > 0 };
        }),
      toggleRightContext: (id) =>
        set((s) => {
          const has = s.rightStack.includes(id);
          const rightStack = has ? s.rightStack.filter((x) => x !== id) : [...s.rightStack, id];
          return { rightStack, rightPanelOpen: rightStack.length > 0 };
        }),
      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
      setBootState: (bootState) => set({ bootState }),
      setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
      setEditorStatus: (editorStatus) => set({ editorStatus }),
      setLastValidation: (lastValidation) => set({ lastValidation }),
      setUiMode: (mode) => {
        const cur = useStore.getState().uiMode;
        if (cur === mode) return;
        // Flip a short "switching" flag so the layout can show a clean loading
        // transition instead of a jarring instant swap.
        set({ modeSwitching: true });
        // Editor mode is IDE-centric: open the file explorer + editor and keep
        // the AI panel docked on the right. Vibe mode is chat-centric.
        if (mode === 'editor') {
          set({ uiMode: 'editor', activePanel: 'files', rightPanelOpen: true });
        } else {
          set({ uiMode: 'vibe', activePanel: 'chat' });
        }
        setTimeout(() => set({ modeSwitching: false }), 280);
      },
      setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
      setPreviewFrame: (file) =>
        set((state) => ({
          previewFrame: file,
          previewFrameSeq: state.previewFrameSeq + 1,
          // Auto-open the Bubbly Preview panel on the right so the user sees the
          // agent's browser actions live.
          rightStack: state.rightStack.includes('preview') ? state.rightStack : [...state.rightStack, 'preview'],
          rightPanelOpen: true,
        })),
      setPreviewUrl: (url) =>
        set((state) => ({
          previewUrl: url,
          // Open the live browser preview panel whenever a URL is loaded.
          ...(url ? { rightStack: state.rightStack.includes('preview') ? state.rightStack : [...state.rightStack, 'preview'], rightPanelOpen: true } : {}),
        })),
      
      setPanelSize: (panel, size) =>
        set((state) => ({
          panelSizes: { ...state.panelSizes, [panel]: size },
        })),
      
      toggleFolderExpansion: (path) =>
        set((state) => {
          const expanded = state.expandedFolders;
          const index = expanded.indexOf(path);
          if (index >= 0) {
            return { expandedFolders: expanded.filter((p) => p !== path) };
          } else {
            return { expandedFolders: [...expanded, path] };
          }
        }),
      
      setExpandedFolders: (paths) => set({ expandedFolders: paths }),

  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  setCurrentThreadType: (t) => set({ currentThreadType: t }),
  setSessions: (sessions) => set({ sessions }),
  setIsRunning: (running) => set({ isRunning: running }),
  startRunTimer: () => set({ runStartedAt: Date.now(), lastRunDurationMs: null }),
  stopRunTimer: () =>
    set((state) => ({
      runStartedAt: null,
      lastRunDurationMs: state.runStartedAt ? Date.now() - state.runStartedAt : state.lastRunDurationMs,
    })),
  setOllamaRetryStatus: (status) => set({ ollamaRetryStatus: status }),

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  upsertToolCall: (callId, tool, args) =>
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.type === 'tool_call' && m.callId === callId
      );
      if (idx >= 0) {
        const messages = state.messages.slice();
        const prev = messages[idx] as Extract<ChatMessage, { type: 'tool_call' }>;
        messages[idx] = { ...prev, tool: tool || prev.tool, args: args ?? prev.args } as ChatMessage;
        return { messages };
      }
      return {
        messages: [
          ...state.messages,
          { id: nanoid(), type: 'tool_call', tool, args: args ?? {}, callId, timestamp: Date.now() } as ChatMessage,
        ],
      };
    }),

  updateLastAssistantMessage: (content, streaming) =>
    set((state) => {
      const messages = [...state.messages];
      // Find the last streaming assistant message
      let idx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'assistant' && (m as {streaming?: boolean}).streaming) {
          idx = i; break;
        }
      }
      if (idx !== -1) {
        messages[idx] = {
          ...messages[idx],
          type: 'assistant',
          content,
          streaming,
        } as ChatMessage;
        return { messages };
      }
      // Create a new streaming message
      const newMsg: ChatMessage = {
        id: nanoid(),
        type: 'assistant',
        content,
        streaming,
        timestamp: Date.now(),
      };
      return { messages: [...messages, newMsg] };
    }),

  // Append a chunk of reasoning to the live thinking bubble. Reasoning is
  // streamed separately from the answer and accumulated into one collapsible
  // bubble per turn so not a single emitted token is lost.
  appendThinking: (delta) =>
    set((state) => {
      const messages = [...state.messages];
      // Reuse the last thinking bubble only if it's still streaming AND no
      // assistant/tool output has been appended after it (i.e. it's the tail).
      const last = messages[messages.length - 1];
      if (last && last.type === 'thinking' && last.streaming) {
        messages[messages.length - 1] = { ...last, content: last.content + delta } as ChatMessage;
        return { messages };
      }
      return {
        messages: [
          ...messages,
          { id: nanoid(), type: 'thinking', content: delta, streaming: true, timestamp: Date.now() } as ChatMessage,
        ],
      };
    }),

  // Mark the live thinking bubble as finished (stops the shimmer).
  finalizeThinking: () =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'thinking' && (m as { streaming?: boolean }).streaming) {
          messages[i] = { ...m, streaming: false } as ChatMessage;
          break;
        }
        // Stop scanning once we pass non-thinking tail content.
        if (m.type === 'assistant' || m.type === 'tool_call') break;
      }
      return { messages };
    }),

  setApprovalStatus: (approvalId, status) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.type === 'approval' && m.approvalId === approvalId
          ? { ...m, status }
          : m
      ),
    })),

  removeLastApprovalPreparing: () =>
    set((state) => {
      // Find and remove the last approval_preparing message
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'approval_preparing') {
          messages.splice(i, 1);
          break;
        }
      }
      return { messages };
    }),

  clearMessages: () => set({ messages: [], streamingMessageId: null, streamingContent: '' }),

  loadMessages: (messages) => set({ messages, streamingMessageId: null, streamingContent: '' }),

  // Attach a prompt checkpoint id to the most recent user message so the UI can
  // offer a per-prompt revert button right next to it.
  attachCheckpointToLastUserMessage: (checkpointId) =>
    set((state) => {
      const idx = [...state.messages].reverse().findIndex((m) => m.type === 'user');
      if (idx === -1) return {};
      const realIdx = state.messages.length - 1 - idx;
      const target = state.messages[realIdx];
      if (target.type !== 'user' || target.checkpointId) return {};
      const messages = state.messages.slice();
      messages[realIdx] = { ...target, checkpointId };
      return { messages };
    }),

  // Link persisted prompt checkpoints to the matching user messages after a
  // thread is loaded from the database (the live link is lost on reload). We
  // match on the stored prompt (which is content.slice(0,280)), consuming each
  // checkpoint once so duplicate prompts still map in order.
  linkCheckpointsToMessages: (checkpoints) =>
    set((state) => {
      if (!checkpoints.length) return {};
      const remaining = [...checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const messages = state.messages.map((m) => {
        if (m.type !== 'user' || m.checkpointId) return m;
        const key = m.content.slice(0, 280);
        const idx = remaining.findIndex((c) => c.prompt === key);
        if (idx === -1) return m;
        const [cp] = remaining.splice(idx, 1);
        return { ...m, checkpointId: cp.id };
      });
      return { messages };
    }),

  // Remove a message and everything after it (used after a per-prompt revert —
  // the workspace is back to before this prompt, so its transcript is dropped).
  truncateMessagesFrom: (messageId) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {};
      return { messages: state.messages.slice(0, idx), streamingMessageId: null, streamingContent: '' };
    }),

  setChatDraft: (draft) => set({ chatDraft: draft }),

  appendTerminalOutput: (terminalId, stream, content) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.type === 'terminal' && m.terminalId === terminalId
          ? { ...m, output: [...m.output, { stream, content }] }
          : m
      ),
    })),

  finalizeTerminal: (terminalId, exitCode, duration) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.type === 'terminal' && m.terminalId === terminalId
          ? { ...m, exitCode, duration }
          : m
      ),
    })),

  toggleTerminalExpanded: (terminalId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.type === 'terminal' && m.terminalId === terminalId
          ? { ...m, expanded: !m.expanded }
          : m
      ),
    })),

  setWorkspacePath: (path) =>
    set((state) => ({
      workspacePath: path,
      recentWorkspaces: path
        ? [path, ...state.recentWorkspaces.filter((p) => p !== path)].slice(0, 8)
        : state.recentWorkspaces,
    })),
  // Switch the active workspace: persist to backend settings, update local
  // state + recents, and clear the open file (it belongs to the old workspace).
  switchWorkspace: (path) => {
    if (!path) return;
    set((state) => ({
      workspacePath: path,
      recentWorkspaces: [path, ...state.recentWorkspaces.filter((p) => p !== path)].slice(0, 8),
      openFile: null,
      openFileContent: null,
      editorTabs: [],
      activeEditorPath: null,
      expandedFolders: [],
    }));
    // Persist to the backend so the agent + file APIs use the new workspace.
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: path }),
    }).catch(() => { /* non-critical */ });
  },
  // Open or focus a file in a tab. (null, null) closes the active tab. This is
  // the back-compat entry point used across the app; it now drives the tabbed
  // editor model so multiple files stay open and never lose state.
  setOpenFile: (path, content) =>
    set((state) => {
      if (path === null) {
        // Close the active tab (legacy "clear editor" behavior).
        const active = state.activeEditorPath;
        if (!active) return { openFile: null, openFileContent: null };
        const tabs = state.editorTabs.filter((t) => t.path !== active);
        const next = tabs[tabs.length - 1] ?? null;
        return {
          editorTabs: tabs,
          activeEditorPath: next?.path ?? null,
          openFile: next?.path ?? null,
          openFileContent: next?.content ?? null,
        };
      }
      const existing = state.editorTabs.find((t) => t.path === path);
      const tabs = existing
        ? state.editorTabs.map((t) => (t.path === path ? { ...t, content } : t))
        : [...state.editorTabs, { path, content }];
      return { editorTabs: tabs, activeEditorPath: path, openFile: path, openFileContent: content };
    }),

  setActiveEditorTab: (path) =>
    set((state) => {
      const tab = state.editorTabs.find((t) => t.path === path);
      if (!tab) return {};
      return { activeEditorPath: path, openFile: path, openFileContent: tab.content };
    }),

  closeEditorTab: (path) =>
    set((state) => {
      const idx = state.editorTabs.findIndex((t) => t.path === path);
      if (idx === -1) return {};
      const tabs = state.editorTabs.filter((t) => t.path !== path);
      let activeEditorPath = state.activeEditorPath;
      if (state.activeEditorPath === path) {
        const neighbor = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1] ?? null;
        activeEditorPath = neighbor?.path ?? null;
      }
      const active = tabs.find((t) => t.path === activeEditorPath) ?? null;
      return {
        editorTabs: tabs,
        activeEditorPath,
        openFile: active?.path ?? null,
        openFileContent: active?.content ?? null,
      };
    }),

  // Update a tab's content from disk truth (realtime agent edits / rehydration).
  // Clears dirty — the on-disk content is now authoritative.
  updateTabContent: (path, content) =>
    set((state) => {
      if (!state.editorTabs.some((t) => t.path === path)) return {};
      const editorTabs = state.editorTabs.map((t) => (t.path === path ? { ...t, content, dirty: false } : t));
      const patch: Partial<AppState> = { editorTabs };
      if (state.activeEditorPath === path) patch.openFileContent = content;
      return patch as any;
    }),

  // Update from a USER edit in the editor — marks the tab dirty (unsaved).
  setTabDirtyContent: (path, content) =>
    set((state) => {
      const tab = state.editorTabs.find((t) => t.path === path);
      if (!tab || tab.content === content) return {};
      const editorTabs = state.editorTabs.map((t) => (t.path === path ? { ...t, content, dirty: true } : t));
      const patch: Partial<AppState> = { editorTabs };
      if (state.activeEditorPath === path) patch.openFileContent = content;
      return patch as any;
    }),

  markTabSaved: (path) =>
    set((state) => ({
      editorTabs: state.editorTabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)),
    })),

  addPromptCheckpoint: (cp) =>
    set((state) => ({ promptCheckpoints: [cp, ...state.promptCheckpoints].slice(0, 20) })),
  setPromptCheckpoints: (cps) => set({ promptCheckpoints: cps }),

  addDiff: (diffs) =>
    set((state) => {
      // Deduplicate: don't add diffs for files that already have the same diff content
      const newDiffs = diffs.filter(d => 
        !state.pendingDiffs.some(existing => 
          existing.path === d.path && existing.diff === d.diff
        )
      );
      if (newDiffs.length === 0) return state;
      // Only auto-reveal the right panel when the user has opted in. This is
      // disabled by default so a flurry of diffs mid-run doesn't keep yanking
      // the panel open. The Changes panel still updates silently in the background.
      const reveal = state.settings?.revealRightPanelOnDiff === 'true';
      return {
        pendingDiffs: [...state.pendingDiffs, ...newDiffs],
        ...(reveal ? { rightStack: state.rightStack.includes('diff') ? state.rightStack : [...state.rightStack, 'diff'], rightPanelOpen: true } : {}),
      };
    }),

  clearDiffs: () => set({ pendingDiffs: [] }),
  setSpecs: (specs) => set({ specs: (specs ?? []).map(normalizeSpec) }),
  upsertSpec: (spec) =>
    set((state) => {
      const normalized = normalizeSpec(spec);
      const existing = state.specs.findIndex((s) => s.id === normalized.id);
      if (existing >= 0) {
        const specs = [...state.specs];
        specs[existing] = normalized;
        return { specs };
      }
      return { specs: [...state.specs, normalized] };
    }),
  setSessionSpecId: (sessionId, specId) =>
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) {
        const sessions = [...state.sessions];
        sessions[idx] = { ...sessions[idx], specId };
        return { sessions };
      }
      // Session not in list yet - add a minimal entry so TaskQueue can resolve specId
      return {
        sessions: [
          ...state.sessions,
          {
            id: sessionId,
            workspacePath: state.workspacePath,
            status: 'running',
            provider: (state.settings?.defaultProvider ?? 'claude'),
            model: '',
            threadType: 'spec_session',
            specId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as Session,
        ],
      };
    }),
  setSettings: (settings) => {
    const theme = settings.theme || 'system';
    set({ settings, settingsLoaded: true, theme });
  },
  setTheme: (theme) => set({ theme }),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),

  // --- Terminals ---
  addTerminal: (tab) =>
    set((state) => ({ terminals: [...state.terminals, { ...tab, origin: tab.origin ?? 'user' }], activeTerminalId: tab.clientRef, rightStack: state.rightStack.includes('terminal') ? state.rightStack : [...state.rightStack, 'terminal'], rightPanelOpen: true })),
  bindTerminal: (clientRef, id, title, cwd) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.clientRef === clientRef ? { ...t, id, title, cwd, alive: true } : t
      ),
      activeTerminalId: state.activeTerminalId === clientRef ? id : state.activeTerminalId,
    })),
  appendTerminalData: (id, data) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id || t.clientRef === id ? { ...t, buffer: (t.buffer + data).slice(-100000) } : t
      ),
    })),
  upsertAgentTerminal: (id, patch) =>
    set((state) => {
      const existing = state.terminals.find((t) => t.id === id || t.clientRef === id);
      if (existing) {
        return {
          terminals: state.terminals.map((t) =>
            t === existing
              ? {
                  ...t,
                  title: patch.title ?? t.title,
                  cwd: patch.cwd ?? t.cwd,
                  buffer: patch.data ? (t.buffer + patch.data).slice(-200000) : t.buffer,
                  alive: patch.alive ?? t.alive,
                  exitCode: patch.exitCode !== undefined ? patch.exitCode : t.exitCode,
                }
              : t
          ),
        };
      }

      // New agent command. To avoid flooding the panel with one tab per command
      // (the per-command history already lives in the chat), REUSE a finished
      // agent terminal if one exists — repurpose it for this command. Only a
      // genuine start (has a command + alive) is allowed to reuse; stray output
      // for an unknown id falls through to creating a tab.
      const header = patch.command ? `❯ ${patch.command}\n` : '';
      const isStart = !!patch.command && (patch.alive ?? true);
      const MAX_AGENT_TERMINALS = 3;
      const agentTabs = state.terminals.filter((t) => t.origin === 'agent');

      if (isStart) {
        // Prefer the most recently finished agent tab; if we're already at the
        // cap and all are alive, repurpose the oldest one regardless.
        const reusable =
          agentTabs.find((t) => !t.alive) ??
          (agentTabs.length >= MAX_AGENT_TERMINALS ? agentTabs[0] : undefined);
        if (reusable) {
          return {
            terminals: state.terminals.map((t) =>
              t === reusable
                ? {
                    ...t,
                    id,
                    clientRef: id,
                    title: patch.title ?? 'Agent',
                    cwd: patch.cwd ?? t.cwd,
                    buffer: header + (patch.data ?? ''),
                    alive: patch.alive ?? true,
                    exitCode: patch.exitCode ?? null,
                    awaitingInput: null,
                  }
                : t
            ),
            activeTerminalId:
              state.activeTerminalId === reusable.id || state.activeTerminalId === reusable.clientRef
                ? id
                : state.activeTerminalId,
          };
        }
      }

      const tab: TerminalTab = {
        id,
        clientRef: id,
        title: patch.title ?? 'Agent',
        cwd: patch.cwd ?? '',
        buffer: header + (patch.data ?? ''),
        alive: patch.alive ?? true,
        origin: 'agent',
        readOnly: true,
        exitCode: patch.exitCode ?? null,
      };
      return {
        terminals: [...state.terminals, tab],
      };
    }),
  markTerminalExited: (id) =>
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, alive: false, awaitingInput: null } : t)),
    })),
  setTerminalAwaitingInput: (id, awaitingInput) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id || t.clientRef === id ? { ...t, awaitingInput } : t
      ),
    })),
  closeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id && t.clientRef !== id);
      const wasActive = state.activeTerminalId === id;
      return {
        terminals,
        activeTerminalId: wasActive ? (terminals[terminals.length - 1]?.id ?? terminals[terminals.length - 1]?.clientRef ?? null) : state.activeTerminalId,
      };
    }),
  setActiveTerminal: (id) => set({ activeTerminalId: id }),
  setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),

  // --- Task progress ---
  setTaskProgress: (taskId, p) =>
    set((state) => ({ taskProgress: { ...state.taskProgress, [taskId]: { ...state.taskProgress[taskId], ...p } } })),
  clearTaskProgress: () => set({ taskProgress: {} }),

  // --- Agent plan + questions ---
  setAgentPlan: (steps) => set({ agentPlan: steps }),
  setWorkerPlan: (steps) => set({ workerPlan: steps }),
  setPendingQuestion: (q) => set({ pendingQuestion: q }),
  // When the agent stops, no plan step should still look "in progress" (stuck
  // spinner). We don't assume completion — revert in_progress steps to todo so
  // they're clearly unfinished and the spinner stops.
  reconcilePlanOnStop: () =>
    set((state) => {
      // A finished run has no active worker — clear its mini-plan.
      const patch: Partial<AppState> = state.workerPlan.length > 0 ? { workerPlan: [] } : {};
      if (!state.agentPlan || state.agentPlan.length === 0) return { ...state, ...patch };
      if (!state.agentPlan.some((s) => s.status === 'in_progress')) return { ...state, ...patch };
      return {
        ...patch,
        agentPlan: state.agentPlan.map((s) =>
          s.status === 'in_progress' ? { ...s, status: 'todo' } : s
        ),
      };
    }),

  // Create or update a delegated-worker card in the message stream. Keyed by
  // delegationId so progress events update the same card in place.
  upsertDelegation: (d) =>
    set((state) => {
      const messages = [...state.messages];
      const idx = messages.findIndex(
        (m) => m.type === 'delegation' && m.delegationId === d.delegationId
      );
      if (idx >= 0) {
        const prev = messages[idx] as Extract<ChatMessage, { type: 'delegation' }>;
        messages[idx] = {
          ...prev,
          instruction: d.instruction ?? prev.instruction,
          targetFiles: d.targetFiles ?? prev.targetFiles,
          acceptance: d.acceptance ?? prev.acceptance,
          phase: d.phase ?? prev.phase,
          detail: d.detail ?? prev.detail,
          report: d.report ?? prev.report,
          filesTouched: d.filesTouched ?? prev.filesTouched,
          validationOk: d.validationOk ?? prev.validationOk,
        } as ChatMessage;
        return { messages };
      }
      return {
        messages: [
          ...messages,
          {
            id: nanoid(),
            type: 'delegation',
            delegationId: d.delegationId,
            instruction: d.instruction ?? '',
            targetFiles: d.targetFiles,
            acceptance: d.acceptance,
            phase: d.phase ?? 'dispatched',
            detail: d.detail,
            report: d.report,
            filesTouched: d.filesTouched,
            validationOk: d.validationOk,
            timestamp: Date.now(),
          } as ChatMessage,
        ],
      };
    }),

  // --- Parallel agent lanes ---
  // Register a lane in its batch's parallel_group message (creating the group
  // on the first lane). Driven by delegation_started events that carry a batch.
  registerParallelLane: (batchId, lane) =>
    set((state) => {
      const messages = [...state.messages];
      const gidx = messages.findIndex((m) => m.type === 'parallel_group' && m.batchId === batchId);
      if (gidx >= 0) {
        const group = messages[gidx] as Extract<ChatMessage, { type: 'parallel_group' }>;
        if (group.lanes.some((l) => l.lane === lane.lane)) return {};
        messages[gidx] = { ...group, lanes: [...group.lanes, lane].sort((a, b) => a.laneIndex - b.laneIndex) };
        return { messages };
      }
      return {
        messages: [
          ...messages,
          { id: nanoid(), type: 'parallel_group', batchId, lanes: [lane], timestamp: Date.now() } as ChatMessage,
        ],
      };
    }),

  // Update a single lane (by lane id) wherever its group lives.
  updateParallelLane: (lane, patch) =>
    set((state) => {
      const messages = state.messages.map((m) => {
        if (m.type !== 'parallel_group') return m;
        if (!m.lanes.some((l) => l.lane === lane)) return m;
        return {
          ...m,
          lanes: m.lanes.map((l) =>
            l.lane === lane
              ? {
                  ...l,
                  ...patch,
                  // Roll a short activity string forward rather than replace blindly.
                  activity: patch.activity !== undefined ? patch.activity : l.activity,
                }
              : l
          ),
        } as ChatMessage;
      });
      return { messages };
    }),

  // --- Command palette ---
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
}),
    {
      name: 'bubbly-ui-state',
      storage: createJSONStorage(() => localStorage),
      // Defensive merge: a persisted payload from an OLDER build can contain
      // stale/missing keys that shallow-merge over our defaults and leave array
      // state as undefined — which crashes render code that reads `.length`.
      // Force the known-array UI fields back to safe defaults on rehydrate.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        // A persisted rightPanelTab from before preview/background/diff moved to
        // the bottom panel would be invalid now — coerce it back to a valid one.
        const validRight = ['spec', 'audit', 'tasks'];
        return {
          ...current,
          ...p,
          agentPlan: Array.isArray(p.agentPlan) ? p.agentPlan : current.agentPlan,
          rightPanelTab: validRight.includes(p.rightPanelTab as string) ? p.rightPanelTab! : 'tasks',
          rightStack: Array.isArray(p.rightStack)
            ? (p.rightStack as string[]).filter((x) => ['preview', 'background', 'diff', 'terminal', 'spec', 'tasks', 'audit'].includes(x)) as RightContextId[]
            : current.rightStack,
        };
      },
      // Only persist UI-related state, not session/message data
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        uiMode: state.uiMode,
        onboardingComplete: state.onboardingComplete,
        leftHidden: state.leftHidden,
        rightStack: state.rightStack,
        editorTabs: state.editorTabs.map((t) => ({ path: t.path, content: null })),
        activeEditorPath: state.activeEditorPath,
        rightPanelTab: state.rightPanelTab,
        panelSizes: state.panelSizes,
        expandedFolders: state.expandedFolders,
        theme: state.theme,
        currentSessionId: state.currentSessionId,
        currentThreadType: state.currentThreadType,
        activePanel: state.activePanel,
        recentWorkspaces: state.recentWorkspaces,
        chatDraft: state.chatDraft,
      }),
    }
  )
);
