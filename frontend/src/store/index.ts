import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatMessage, Session, Settings, FileDiff, Spec, ContextUsage, Artifact, ArtifactKind, WatcherRow, WorkspaceSource } from '../types';
import { DEFAULT_PALETTE_ID } from '../styles/palettes';

/** File preview data for the right panel */
export interface FilePreview {
  path: string;
  content: string;
  type: 'read' | 'write' | 'edit' | 'delete' | 'create';
  lineRange?: { start: number; end: number };
  /** True while the real file content is being fetched. */
  loading?: boolean;
  /** Set when the file could not be read (deleted, permission, outside root). */
  error?: string;
  /** The change this tool call made, when it made one. */
  diff?: FileDiff;
  /** One line describing what the tool call did, for non-read operations. */
  summary?: string;
  /** Which tool produced this preview, for the header. */
  tool?: string;
}

/** A context that can be opened as a panel in the right-side stack. */
export type RightContextId =
  | 'preview' | 'background' | 'watchers' | 'diff' | 'terminal' | 'spec' | 'tasks' | 'audit'
  | 'plans' | 'artifacts' | 'file-preview';

/** Every RightContextId, for validating what comes back out of persistence. */
export const RIGHT_CONTEXT_IDS: RightContextId[] = [
  'preview', 'background', 'watchers', 'diff', 'terminal', 'spec', 'tasks', 'audit',
  'plans', 'artifacts', 'file-preview',
];

export type PlanStep = {
  /** Assigned by the server and stable across updates. Older persisted plans
   *  have none, which is why it stays optional. */
  id?: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  note?: string;
};

/** One plan as it appeared in the thread. `owner` is the MAIN/AGENT tag. */
export interface PlanRecord {
  id: string;
  owner: 'main' | 'agent';
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
  /** Chat message this plan was announced at, for the inline anchor. */
  anchorMessageId: string | null;
}

/**
 * Identity of a plan.
 *
 * Prefer the server-assigned step IDS, which are stable across every update —
 * that is the whole point of them. Titles are the fallback for plans persisted
 * before ids existed, joined on a character that cannot occur in a title so two
 * different plans can never collide by concatenation.
 *
 * Using titles alone was half of the "the plan keeps restarting" bug: a model
 * that retyped one word produced a signature the UI read as a DIFFERENT plan,
 * so the old one froze at 2/8 and a new one appeared at 3/8 beside it.
 */
const UNIT = String.fromCharCode(31);
const planSignature = (steps: PlanStep[]) =>
  steps.every((s) => s.id)
    ? steps.map((s) => s.id).join(UNIT)
    : steps.map((s) => s.title).join(UNIT);

/**
 * Fold a plan update into the history: progress on the owner's latest plan if
 * the steps are the same ones, otherwise a new plan appended after it.
 */
function recordPlan(
  state: { plans: PlanRecord[]; messages: ChatMessage[] },
  owner: 'main' | 'agent',
  steps: PlanStep[],
): PlanRecord[] {
  // Defensive on both sides. This runs INSIDE a zustand set(), so anything that
  // throws here takes the whole update down with it — including the agentPlan
  // assignment beside it — and the symptom would be a plan that never appears
  // anywhere, with no error the user could act on.
  const existing = Array.isArray(state.plans) ? state.plans : [];
  if (!Array.isArray(steps) || steps.length === 0) return existing;
  const now = Date.now();
  const idx = [...existing].reverse().findIndex((p) => p.owner === owner);
  const latest = idx === -1 ? null : existing[existing.length - 1 - idx];
  // The same plan, or the same plan with steps added/removed: either way it is
  // an UPDATE. Any shared step id proves continuity — the server never reissues
  // an id, so an overlap cannot happen between two genuinely different plans.
  const sharesIdentity = (a: PlanStep[], b: PlanStep[]) => {
    if (planSignature(a) === planSignature(b)) return true;
    const ids = new Set(a.map((s) => s.id).filter(Boolean));
    return ids.size > 0 && b.some((s) => s.id && ids.has(s.id));
  };
  if (latest && sharesIdentity(latest.steps, steps)) {
    const plans = state.plans.slice();
    plans[state.plans.length - 1 - idx] = { ...latest, steps, updatedAt: now };
    return plans;
  }
  const lastMessage = state.messages[state.messages.length - 1];
  return [
    ...state.plans,
    {
      id: `plan_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      owner,
      steps,
      createdAt: now,
      updatedAt: now,
      anchorMessageId: lastMessage?.id ?? null,
    },
  ];
}

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
  /** Hide the whole left region (activity bar + sidebar) for a distraction-free view. */
  leftHidden: boolean;
  /** Hide ONLY the activity-bar icon rail, keeping the sidebar panel visible.
   *  Independent of leftHidden so the nav can go away without losing the tree. */
  navHidden: boolean;
  rightPanelOpen: boolean;
  /** @deprecated kept only for persisted-state compatibility. */
  rightPanelTab: 'spec' | 'audit' | 'tasks';
  /** The right side is a STACK of open context panels. The bottom button bar and
   *  the activity rail toggle these; when several are open they stack vertically. */
  rightStack: RightContextId[];
  /**
   * Relative height of each stacked right-hand panel. A weight rather than a
   * pixel height, so a split tuned at one window size stays proportionally
   * right at another. Absent means 1 — an untouched stack still divides evenly.
   */
  rightPanelWeights: Partial<Record<RightContextId, number>>;
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
  /**
   * What started the run in flight. A run the user did not start (a watcher
   * wake-up, a loop tick) still needs a Stop button — and the user deserves to
   * know why the agent suddenly began working again.
   */
  runTrigger: 'user' | 'watcher' | 'loop' | 'resume' | null;
  /** Live watcher table, pushed by the backend whenever it changes. */
  watchers: WatcherRow[];
  /**
   * The /loop workflow currently running, if any.
   *
   * A loop looks exactly like a very long normal run from the outside, which is
   * unnerving: the user cannot tell whether it is making progress, how much
   * budget is left, or whether it will ever stop. This is what the composer
   * shows instead.
   */
  activeLoop: {
    loopId: string;
    goal: string;
    iteration: number;
    maxIterations: number;
    maxMinutes: number;
    remainingMinutes: number;
  } | null;
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
  /**
   * Where the current thread's work happens. A local folder unless the user
   * chose an SSH host or a repository; sent with the first message of a thread
   * so the backend records it against the session.
   */
  workspaceSource: WorkspaceSource | null;
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

  // File preview
  filePreview: FilePreview | null;

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
  /**
   * What the agent last said it was doing (set_phase, or a plan step moving to
   * in_progress). Stamped onto each new tool call; never read at render time.
   */
  currentPhase: { label: string; detail?: string; source: 'agent' | 'plan' } | null;
  setCurrentPhase: (phase: { label: string; detail?: string; source: 'agent' | 'plan' } | null) => void;
  /**
   * Messages typed while the agent was already working.
   *
   * A run is single-flight, so these are parked on the server and delivered at
   * the loop's next boundary. They live here between "sent" and "the agent
   * actually read it" so the composer can show them as pending chips — visible,
   * cancellable, and provably not lost.
   */
  pendingMessages: Array<{ id: string; text: string; status: 'queued' | 'rejected'; reason?: string }>;
  /**
   * An attachment handed to the composer from outside it — /paste, a drop on
   * the window, a screenshot action. The composer picks it up and clears it, so
   * this is a one-shot handoff rather than a second source of truth for what is
   * attached.
   */
  pendingAttachment: { name: string; type: string; size: number; content: string; isImage: boolean } | null;
  setPendingAttachment: (a: AppState['pendingAttachment']) => void;
  enqueuePendingMessage: (text: string, depth?: number) => void;
  rejectPendingMessage: (text: string, reason: string) => void;
  deliverPendingMessage: (text: string) => void;
  dismissPendingMessage: (id: string) => void;
  agentPlan: PlanStep[];
  /** A worker sub-agent's own mini-plan, shown separately so it never clobbers the main plan. */
  workerPlan: PlanStep[];
  /** Every plan this thread has produced, in order, tagged MAIN or AGENT. */
  plans: PlanRecord[];
  /** Agent-authored documents for the current workspace, newest first. */
  artifacts: Artifact[];
  /** Which artifact the panel is showing. */
  activeArtifactId: string | null;
  pendingQuestion: { questionId: string; question: string; options?: string[] } | null;

  // Command palette
  commandPaletteOpen: boolean;

  // Settings
  settings: Settings | null;
  settingsLoaded: boolean;

  // Theme
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: 'light' | 'dark';
  /**
   * Which palette is active. Independent of light/dark: every palette ships
   * both modes, so going dark never changes which theme you chose.
   */
  palette: string;

  // Actions
  setActivePanel: (panel: AppState['activePanel']) => void;
  setUiMode: (mode: AppState['uiMode']) => void;
  setEditorStatus: (status: AppState['editorStatus']) => void;
  setLastValidation: (issues: AppState['lastValidation']) => void;
  setBootState: (state: AppState['bootState']) => void;
  setOnboardingComplete: (complete: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setLeftHidden: (hidden: boolean) => void;
  setNavHidden: (hidden: boolean) => void;
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
  /** A run began. Idempotent: safe to receive twice for the same run. */
  beginRun: (trigger: 'user' | 'watcher' | 'loop' | 'resume') => void;
  setWatchers: (watchers: WatcherRow[]) => void;
  setActiveLoop: (loop: AppState['activeLoop']) => void;
  /** Marks a run's start; call once right when a chat message is sent. */
  startRunTimer: () => void;
  /** Freezes the elapsed time into lastRunDurationMs; call on 'done'/'error'. */
  stopRunTimer: () => void;
  setOllamaRetryStatus: (status: AppState['ollamaRetryStatus']) => void;

  addMessage: (msg: ChatMessage) => void;
  /** Create or update a tool_call message keyed by callId. A `tool_started`
   *  event creates it (args unknown yet); the later `tool_call` fills in args. */
  upsertToolCall: (callId: string, tool: string, args?: Record<string, unknown>) => void;
  upsertToolResult: (callId: string, msg: ChatMessage) => void;
  /** Record an artifact write from the agent, and place/refresh its chat card. */
  upsertArtifact: (a: {
    id: string; title: string; kind: ArtifactKind; language?: string;
    version: number; body: string; note?: string; updatedAt: number;
  }) => void;
  /** Replace the artifact list wholesale (from the REST load on workspace open). */
  setArtifacts: (artifacts: Artifact[]) => void;
  setActiveArtifact: (id: string | null) => void;
  removeArtifact: (id: string) => void;
  updateToolProgress: (callId: string, progress: { path?: string; bytes: number; lines: number }) => void;
  /** Live context-window usage for the active model, driven by the agent loop. */
  contextUsage: ContextUsage | null;
  setContextUsage: (usage: ContextUsage | null) => void;
  updateLastAssistantMessage: (content: string, streaming: boolean) => void;
  appendThinking: (delta: string) => void;
  finalizeThinking: () => void;
  setApprovalStatus: (approvalId: string, status: 'approved' | 'rejected' | 'expired') => void;
  removeLastApprovalPreparing: () => void;
  clearMessages: () => void;
  /** Reset ALL per-thread state (messages, diffs, plan, tasks, question, run,
   *  preview frame). Called by every thread switch/new/open/revert path. */
  resetThreadState: () => void;
  loadMessages: (messages: ChatMessage[]) => void;
  attachCheckpointToLastUserMessage: (checkpointId: string) => void;
  linkCheckpointsToMessages: (checkpoints: Array<{ id: string; prompt: string; createdAt: string }>) => void;
  truncateMessagesFrom: (messageId: string) => void;
  setChatDraft: (draft: string) => void;
  appendTerminalOutput: (terminalId: string, stream: 'stdout' | 'stderr', content: string) => void;
  finalizeTerminal: (terminalId: string, exitCode: number, duration: number) => void;
  toggleTerminalExpanded: (terminalId: string) => void;

  setWorkspacePath: (path: string) => void;
  setWorkspaceSource: (source: WorkspaceSource | null) => void;
  /** Switch the active workspace (persists it and records it in recents). */
  switchWorkspace: (path: string) => void;
  /** Clear the recent workspaces list. */
  clearRecentWorkspaces: () => void;
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

  setRightPanelWeight: (id: RightContextId, weight: number) => void;
  setFilePreview: (preview: FilePreview | null) => void;
  /**
   * Open a file in the right-hand preview, fetching its CURRENT content.
   *
   * The old behaviour passed the tool result in as the "content", which is only
   * the file for `read_file`. For a write or an edit the result is a status
   * sentence, so clicking the file chip after an edit showed "Wrote 42 lines to
   * src/app.ts" where the file should have been — the one moment you most want
   * to see what the file now says.
   */
  openFilePreview: (path: string, meta?: { type?: FilePreview['type']; diff?: FileDiff; summary?: string; tool?: string }) => void;

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
  setAgentPlan: (steps: PlanStep[]) => void;
  setWorkerPlan: (steps: PlanStep[]) => void;
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
  setPalette: (palette: string) => void;
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
      navHidden: false,
      contextUsage: null,
      rightPanelOpen: false,
      rightPanelTab: 'tasks',
      rightStack: [],
      rightPanelWeights: {},
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
      runTrigger: null,
      watchers: [],
      activeLoop: null,
      runStartedAt: null,
      lastRunDurationMs: null,
      ollamaRetryStatus: null,

      messages: [],
      streamingMessageId: null,
      streamingContent: '',
      chatDraft: '',

      workspacePath: '',
      workspaceSource: null,
      recentWorkspaces: [],
      promptCheckpoints: [],
      openFile: null,
      openFileContent: null,
      editorTabs: [],
      activeEditorPath: null,

      pendingDiffs: [],
      filePreview: null,
      specs: [],
      settings: null,
      settingsLoaded: false,

      terminals: [],
      activeTerminalId: null,
      bottomPanelOpen: false,
      bottomPanelTab: 'terminal',
      taskProgress: {},
      currentPhase: null,
      pendingMessages: [],
      pendingAttachment: null,
      agentPlan: [],
      workerPlan: [],
      plans: [],
      artifacts: [],
      activeArtifactId: null,
      pendingQuestion: null,
      commandPaletteOpen: false,

      theme: 'system',
      resolvedTheme: 'dark',
      palette: DEFAULT_PALETTE_ID,

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
      setNavHidden: (navHidden) => set({ navHidden }),
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
  setIsRunning: (running) => set({ isRunning: running, ...(running ? {} : { runTrigger: null }) }),

  /**
   * A run started — from any trigger.
   *
   * This exists because a thread woken by a detached watcher streamed its whole
   * turn with no Stop control: `isRunning` was only ever set by the send path,
   * so a run nobody sent looked, to the UI, like nothing was happening. The user
   * could watch the agent edit files and had no way to interrupt it.
   */
  beginRun: (trigger) =>
    set((state) => (state.isRunning && state.runTrigger === trigger
      ? {}
      : { isRunning: true, runTrigger: trigger, runStartedAt: state.runStartedAt ?? Date.now(), lastRunDurationMs: null })),

  setWatchers: (watchers) => set({ watchers }),
  setActiveLoop: (activeLoop) => set({ activeLoop }),
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
          {
            id: nanoid(), type: 'tool_call', tool, args: args ?? {}, callId, timestamp: Date.now(),
            // Stamp the phase ONTO the step. Reading a global at render time
            // would relabel every past step the moment the agent moved on.
            ...(state.currentPhase ? { phase: state.currentPhase } : {}),
          } as ChatMessage,
        ],
      };
    }),

  /**
   * A tool call's result, keyed by the call it belongs to. Upserted rather than
   * appended for the same reason upsertToolCall is: one call must render as one
   * block. A plain append meant a tool_result arriving twice for the same
   * callId — a reconnect replay, or an overlapping run — silently produced two
   * identical result blocks under one call, which reads as the tool having run
   * twice even when it hadn't.
   */
  upsertToolResult: (callId, msg) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.type === 'tool_result' && m.callId === callId);
      if (idx >= 0) {
        const messages = state.messages.slice();
        messages[idx] = { ...messages[idx], ...msg } as ChatMessage;
        return { messages };
      }

      // PLACE THE RESULT NEXT TO ITS CALL, not at the end of the transcript.
      //
      // A single model response can contain several tool calls. All of their
      // placeholders are created while the response streams, and the results
      // arrive later, one at a time, as each executes. Appending meant a
      // response with three calls rendered call-A, call-B, call-C, result-A,
      // result-B, result-C — so the first call's result appeared below the third
      // call, and the transcript claimed an order of events that never happened.
      //
      // Inserting directly after the matching call (and after any result already
      // attached to it) keeps every pair together and preserves emission order.
      const callIdx = state.messages.findIndex((m) => m.type === 'tool_call' && m.callId === callId);
      if (callIdx < 0) return { messages: [...state.messages, msg] };

      let insertAt = callIdx + 1;
      while (
        insertAt < state.messages.length &&
        state.messages[insertAt].type === 'tool_result'
      ) insertAt++;

      const messages = state.messages.slice();
      messages.splice(insertAt, 0, msg);
      return { messages };
    }),

  /**
   * An artifact write from the agent: fold the new version into the document's
   * history, and make sure the transcript has exactly ONE card for it.
   *
   * Revisions are the reason the card is upserted rather than appended. An
   * agent that refines a document four times would otherwise leave four cards
   * for one document, three of them stale — and the user would have to guess
   * which is current. One card, always showing the latest version, is both
   * truthful and what the transcript has room for.
   */
  upsertArtifact: (a) =>
    set((state) => {
      const idx = state.artifacts.findIndex((x) => x.id === a.id);
      const version = { version: a.version, content: a.body, createdAt: a.updatedAt, note: a.note };
      let artifacts: Artifact[];
      if (idx >= 0) {
        const prev = state.artifacts[idx];
        const versions = prev.versions.some((v) => v.version === a.version)
          ? prev.versions.map((v) => (v.version === a.version ? version : v))
          : [...prev.versions, version];
        artifacts = state.artifacts.slice();
        artifacts[idx] = { ...prev, title: a.title, kind: a.kind, language: a.language, updatedAt: a.updatedAt, versions };
      } else {
        artifacts = [
          { id: a.id, title: a.title, kind: a.kind, language: a.language, createdAt: a.updatedAt, updatedAt: a.updatedAt, versions: [version] },
          ...state.artifacts,
        ];
      }

      const hasCard = state.messages.some((m) => m.type === 'artifact' && m.artifactId === a.id);
      const messages = hasCard
        ? state.messages
        : [...state.messages, { id: nanoid(), type: 'artifact' as const, artifactId: a.id, timestamp: Date.now() }];

      return { artifacts, messages, activeArtifactId: a.id };
    }),

  setArtifacts: (artifacts) => set({ artifacts }),
  setActiveArtifact: (id) => set({ activeArtifactId: id }),
  removeArtifact: (id) =>
    set((state) => ({
      artifacts: state.artifacts.filter((a) => a.id !== id),
      messages: state.messages.filter((m) => !(m.type === 'artifact' && m.artifactId === id)),
      activeArtifactId: state.activeArtifactId === id ? null : state.activeArtifactId,
    })),

  /** Live progress for a tool call whose arguments are still streaming. Stored
   *  on the message so a big write_file shows its path and growing line count
   *  instead of an unchanging spinner. */
  updateToolProgress: (callId, progress) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.type === 'tool_call' && m.callId === callId);
      if (idx < 0) return {};
      const messages = state.messages.slice();
      const prev = messages[idx] as Extract<ChatMessage, { type: 'tool_call' }>;
      messages[idx] = { ...prev, progress } as ChatMessage;
      return { messages };
    }),

  setContextUsage: (usage) => set({ contextUsage: usage }),

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
  /**
   * Add reasoning to the current thinking bubble, creating one only when this
   * is genuinely a new reasoning phase.
   *
   * The subtlety is what counts as "new". Appending whenever the tail isn't a
   * live thinking bubble looks right until reasoning arrives LATE — after the
   * answer has already started painting. That produced the worst possible
   * reading of the transcript: one continuous thought split into two blocks
   * with the response wedged between them, as if the model had thought, spoken,
   * and then thought again. The backend now orders the two streams so this
   * should not happen, but the client must not be able to render nonsense if a
   * chunk ever arrives out of order.
   *
   * So we scan back for the reasoning block this delta belongs to, and stop at
   * the things that genuinely END a reasoning phase: the user's turn, or a tool
   * call (after a tool runs, the model really is thinking afresh). Plain
   * assistant prose does NOT end it — that is precisely the case being fixed.
   */
  appendThinking: (delta) =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'thinking') {
          messages[i] = { ...m, content: m.content + delta } as ChatMessage;
          return { messages };
        }
        if (m.type === 'user' || m.type === 'tool_call' || m.type === 'tool_result') break;
      }
      return {
        messages: [
          ...messages,
          { id: nanoid(), type: 'thinking', content: delta, streaming: true, timestamp: Date.now() } as ChatMessage,
        ],
      };
    }),

  /**
   * Mark the live thinking bubble as finished (stops the shimmer).
   *
   * The scan mirrors appendThinking's, and must: reasoning that got merged back
   * into a bubble sitting above the answer would otherwise keep shimmering
   * forever, because the old scan stopped the moment it passed assistant text.
   */
  finalizeThinking: () =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type === 'thinking' && (m as { streaming?: boolean }).streaming) {
          messages[i] = { ...m, streaming: false } as ChatMessage;
          break;
        }
        if (m.type === 'user' || m.type === 'tool_call' || m.type === 'tool_result') break;
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

  // The ONE place that wipes every piece of per-thread state. Switching threads,
  // opening a saved thread, starting a new chat, and reverting the first prompt
  // all used to clear DIFFERENT subsets by hand — so one path would leave the
  // previous thread's plan strip up, another its diffs, another a stale pending
  // question. Anything scoped to a single conversation is reset here, and every
  // entry point calls this instead of hand-picking fields. WORKSPACE-scoped
  // state (settings, workspacePath, the specs list, panel layout) is deliberately
  // left alone — it isn't the thread's.
  /**
   * Clear EVERYTHING that belongs to a thread.
   *
   * "New chat" has to mean a clean slate across the whole window, not just an
   * empty transcript. After a long session the previous thread leaves traces
   * all over the UI — an old file in the preview panel, its diffs in Changes,
   * its terminals, its problems, its checkpoints, a half-typed draft, and a
   * right-hand stack of panels it opened. Starting fresh with someone else's
   * furniture still standing is the state that makes people close the app and
   * reopen it.
   *
   * The rule for what belongs here: if it was produced BY a thread, it goes. If
   * it is a preference (theme, panel widths, workspace, recents), it stays —
   * those belong to the person, not the conversation.
   */
  resetThreadState: () =>
    set({
      messages: [],
      streamingMessageId: null,
      streamingContent: '',
      // A half-typed message for a conversation that no longer exists.
      chatDraft: '',

      pendingDiffs: [],
      currentPhase: null,
      pendingMessages: [],
      pendingAttachment: null,
      agentPlan: [],
      workerPlan: [],
      plans: [],
      artifacts: [],
      activeArtifactId: null,
      taskProgress: {},
      pendingQuestion: null,
      specs: [],
      // Checkpoints are per-prompt, and those prompts are gone.
      promptCheckpoints: [],
      // Problems reported by the previous thread's validation run.
      lastValidation: [],

      // A half-finished run must not appear to continue into the new thread.
      isRunning: false,
      runTrigger: null,
      watchers: [],
      activeLoop: null,
      runStartedAt: null,
      lastRunDurationMs: null,
      ollamaRetryStatus: null,
      contextUsage: null,

      // Panels the previous thread opened, and what they were showing.
      rightStack: [],
      filePreview: null,
      previewFrame: null,
      previewUrl: null,

      // Agent-owned terminals belong to the run that created them. A terminal
      // the USER opened is theirs and survives.
      terminals: get().terminals.filter((t) => t.origin === 'user'),
      activeTerminalId: null,
    }),

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

  setWorkspaceSource: (source) => set({ workspaceSource: source }),
  // Switch the active workspace: persist to backend settings, update local
  // state + recents, and clear the open file (it belongs to the old workspace).
  switchWorkspace: (path) => {
    if (!path) return;
    set((state) => ({
      workspacePath: path,
      // A plain folder switch means a LOCAL source. Leaving a stale ssh/git
      // source behind would send the next thread's tool calls to the machine
      // the user just navigated away from.
      workspaceSource: { kind: 'local' as const, path },
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
  clearRecentWorkspaces: () => set({ recentWorkspaces: [] }),
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
  setRightPanelWeight: (id, weight) =>
    set((state) => ({ rightPanelWeights: { ...state.rightPanelWeights, [id]: Math.max(weight, 0.05) } })),

  setFilePreview: (preview) => set({ filePreview: preview }),

  openFilePreview: (path, meta = {}) => {
    const state = get();
    set({
      filePreview: {
        path,
        content: '',
        type: meta.type ?? 'read',
        loading: true,
        diff: meta.diff,
        summary: meta.summary,
        tool: meta.tool,
      },
    });
    state.openRightContext('file-preview');

    // A deleted file has nothing to fetch; the summary and diff are the story.
    if (meta.type === 'delete') {
      set((s2) => ({ filePreview: s2.filePreview ? { ...s2.filePreview, loading: false } : null }));
      return;
    }

    void fetch(`/api/files/read?workspace=${encodeURIComponent(state.workspacePath)}&path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) {
          // Carry the server's own explanation through. "path escapes the
          // workspace" and "the file is gone" are different problems, and
          // collapsing both into "it may have been deleted" sent people looking
          // for a file that was sitting exactly where they left it.
          const detail = await r.json().then((d: { error?: string }) => d?.error).catch(() => undefined);
          throw new Error(detail || `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ content: string }>;
      })
      .then((data) => set((s2) => (
        s2.filePreview?.path === path
          ? { filePreview: { ...s2.filePreview, content: data.content ?? '', loading: false } }
          : {}
      )))
      .catch((err: unknown) => set((s2) => (
        s2.filePreview?.path === path
          ? {
              filePreview: {
                ...s2.filePreview,
                loading: false,
                error: err instanceof Error && err.message
                  ? `Could not read this file: ${err.message}`
                  : 'This file could not be read — it may have been deleted or moved since.',
              },
            }
          : {}
      )));
  },
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
  setPalette: (palette) => set({ palette }),
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
  //
  // Plans are kept as a HISTORY, not a single current snapshot. A run routinely
  // produces several — the lead's plan, then a worker's, then a revised lead
  // plan after the worker reports — and a single slot meant each one silently
  // overwrote the last. The thread's actual shape of work was unrecoverable
  // five minutes later. `plans` keeps every one, tagged by owner, in the order
  // it appeared, with an anchor into the transcript so you can see WHERE the
  // agent changed its mind.
  //
  // A revision is distinguished from a tick-off by the step TITLES: same
  // titles, new statuses → the same plan progressing, updated in place. New
  // titles → a genuinely new plan, appended.
  setCurrentPhase: (currentPhase) => set({ currentPhase }),
  setPendingAttachment: (pendingAttachment) => set({ pendingAttachment }),

  enqueuePendingMessage: (text) =>
    set((state) => (
      state.pendingMessages.some((m) => m.text === text && m.status === 'queued')
        ? {}
        : { pendingMessages: [...state.pendingMessages, { id: nanoid(), text, status: 'queued' as const }] }
    )),

  rejectPendingMessage: (text, reason) =>
    set((state) => ({
      pendingMessages: [
        ...state.pendingMessages.filter((m) => m.text !== text),
        { id: nanoid(), text, status: 'rejected' as const, reason },
      ],
    })),

  deliverPendingMessage: (text) =>
    set((state) => ({
      pendingMessages: state.pendingMessages.filter((m) => m.text !== text),
      // The bubble appears HERE, where the agent read it — not where it was
      // typed. Claiming it was seen earlier than it was is the one thing a
      // transcript must never do.
      messages: [...state.messages, { id: nanoid(), type: 'user', content: text, timestamp: Date.now() } as ChatMessage],
    })),

  dismissPendingMessage: (id) =>
    set((state) => ({ pendingMessages: state.pendingMessages.filter((m) => m.id !== id) })),
  setAgentPlan: (steps) => set((s) => ({ agentPlan: steps, plans: recordPlan(s, 'main', steps) })),
  setWorkerPlan: (steps) => set((s) => ({ workerPlan: steps, plans: recordPlan(s, 'agent', steps) })),
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
          plans: Array.isArray(p.plans) ? p.plans : current.plans,
          rightPanelTab: validRight.includes(p.rightPanelTab as string) ? p.rightPanelTab! : 'tasks',
          rightStack: Array.isArray(p.rightStack)
            ? (p.rightStack as string[]).filter((x) => (RIGHT_CONTEXT_IDS as string[]).includes(x)) as RightContextId[]
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
        navHidden: state.navHidden,
        rightStack: state.rightStack,
        editorTabs: state.editorTabs.map((t) => ({ path: t.path, content: null })),
        activeEditorPath: state.activeEditorPath,
        rightPanelTab: state.rightPanelTab,
        panelSizes: state.panelSizes,
        expandedFolders: state.expandedFolders,
        theme: state.theme,
        palette: state.palette,
        rightPanelWeights: state.rightPanelWeights,
        currentSessionId: state.currentSessionId,
        currentThreadType: state.currentThreadType,
        activePanel: state.activePanel,
        recentWorkspaces: state.recentWorkspaces,
        workspaceSource: state.workspaceSource,
        chatDraft: state.chatDraft,
      }),
    }
  )
);

// Dev-only: expose the store for debugging from the browser console (and for
// driving UI states that normally require a live agent run). Never in a build.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { useStore?: typeof useStore }).useStore = useStore;
}
