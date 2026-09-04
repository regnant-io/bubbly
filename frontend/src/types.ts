export type Provider = 'claude' | 'ollama' | 'gemini' | 'openrouter';
export type ThreadType = 'vibe_coding' | 'spec_session';

export interface Session {
  id: string;
  workspacePath: string;
  status: 'active' | 'running' | 'idle' | 'done' | 'error';
  provider: Provider;
  model: string;
  threadType?: ThreadType;
  threadName?: string;
  specId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  anthropicApiKey: string;
  geminiApiKey: string;
  openrouterApiKey: string;
  ollamaBaseUrl: string;
  defaultProvider: Provider;
  claudeModel: string;
  geminiModel: string;
  openrouterModel: string;
  ollamaModel: string;
  workspacePath: string;
  requireApprovalForWrites: string;
  requireApprovalForShell: string;
  theme: 'light' | 'dark' | 'system';
  ollamaEnableThinking: string;
  ollamaRetryMaxAttempts: string;
  ollamaRetryInitialDelayMs: string;
  ollamaRetryBackoffMultiplier: string;
  ollamaNumCtx: string;
  ollamaAutoNumCtx: string;
  ollamaNumCtxCeiling: string;
  ollamaRequestTimeoutMs: string;
  autoValidate: string;
  multiAgentSpec: string;
  contextTokenBudget: string;
  autoContextMigration: string;
  contextMigrationThreshold: string;
  maxTaskIterations: string;
  editorFontSize: string;
  streamingSpeed: string;
  revealRightPanelOnDiff: string;
  vibeWorkerThreshold: string;
  specDocsAsMarkdown: string;
  terminalFontSize: string;
  tabSize: string;
  wordWrap: string;
  formatOnSave: string;
  autoSave: string;
  mcpServers: string;
  skills: string;
  computerControlEnabled: string;
  browserControlEnabled: string;
  desktopNotifications: string;
  notifyOnCommandFailure: string;
}

export interface FileDiff {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  diff: string;
  additions: number;
  deletions: number;
}

export interface Spec {
  id: string;
  title: string;
  type: 'feature' | 'bugfix' | 'refactor' | 'research';
  status: 'draft' | 'in_progress' | 'done' | 'cancelled';
  phase?: 'requirements' | 'design' | 'tasks' | 'ready';
  requirements: string[];
  properties?: SpecProperty[];
  design?: string;
  tasks: SpecTask[];
  notes?: string;
  approvals?: { requirements?: boolean; design?: boolean; tasks?: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface SpecProperty {
  id: string;
  statement: string;
  kind?: 'functional' | 'constraint' | 'invariant' | 'edge_case';
  acceptance?: string;
}

export interface SpecSubTask {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  acceptance?: string;
}

export interface SpecTask {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  targetFiles?: string[];
  dependsOn?: string[];
  satisfiesProperties?: string[];
  acceptance?: string;
  /** The exact command that proves this task works, from "Verify with:" in tasks.md. */
  verifyWith?: string;
  verificationNote?: string;
  subTasks?: SpecSubTask[];
}

// Chat message types
export type ChatMessage =
  | {
      id: string;
      type: 'user';
      content: string;
      timestamp: number;
      /** Prompt checkpoint snapshotted before this message — enables per-prompt revert. */
      checkpointId?: string;
    }
  | {
      id: string;
      type: 'assistant';
      content: string;
      timestamp: number;
      streaming?: boolean;
    }
  | {
      id: string;
      type: 'thinking';
      content: string;
      timestamp: number;
      streaming?: boolean;
    }
  | {
      id: string;
      type: 'tool_call';
      tool: string;
      args: Record<string, unknown>;
      callId: string;
      timestamp: number;
      /** Live stats while the call's arguments are still streaming in. */
      progress?: { path?: string; bytes: number; lines: number };
      /**
       * What the agent said it was DOING when it made this call.
       *
       * Stamped at creation time from the last `phase` event, so it is a
       * permanent property of the step rather than a global that would be wrong
       * the moment you scrolled up. This is what lets a burst of twenty steps
       * render as "Building the backend · 6 steps / Finding the failure · 4
       * steps / Fixing it · 5 steps" instead of one undifferentiated run.
       */
      phase?: { label: string; detail?: string; source: 'agent' | 'plan' };
    }
  /**
   * A card from BUBBLY, not from the model.
   *
   * `/status`, `/context`, `/cost` and `/help` produce real answers that belong
   * in the transcript where they were asked — but attributing them to the
   * assistant would be a lie, and folding them into a `status` line loses the
   * formatting that makes them readable. So they get their own type, labelled
   * as the app speaking.
   */
  | {
      id: string;
      type: 'notice';
      title: string;
      /** Markdown. */
      content: string;
      timestamp: number;
    }
  | {
      id: string;
      type: 'tool_result';
      tool: string;
      result: string;
      callId: string;
      diff?: FileDiff[];
      timestamp: number;
    }
  | {
      id: string;
      type: 'terminal';
      terminalId: string;
      command: string;
      output: Array<{ stream: 'stdout' | 'stderr'; content: string }>;
      exitCode?: number;
      startTime: number;
      duration?: number;
      expanded?: boolean;
      timestamp: number;
    }
  | {
      id: string;
      type: 'approval_preparing';
      tool: string;
      args: Record<string, unknown>;
      timestamp: number;
    }
  | {
      id: string;
      type: 'approval';
      approvalId: string;
      tool: string;
      args: Record<string, unknown>;
      preview?: string;
      status: 'pending' | 'approved' | 'rejected' | 'expired';
      timestamp: number;
    }
  | {
      id: string;
      type: 'status';
      content: string;
      timestamp: number;
    }
  | {
      id: string;
      type: 'error';
      content: string;
      recoverable?: boolean;
      suggestions?: string[];
      timestamp: number;
    }
  | {
      id: string;
      type: 'context_migrated';
      fromSessionId: string;
      toSessionId: string;
      reason: 'context_limit' | 'model_downgrade';
      summary: string;
      timestamp: number;
    }
  | {
      id: string;
      type: 'delegation';
      delegationId: string;
      instruction: string;
      targetFiles?: string[];
      acceptance?: string;
      phase: string; // dispatched | gathering_context | working | validating | done | error
      detail?: string;
      report?: string;
      filesTouched?: string[];
      validationOk?: boolean;
      timestamp: number;
    }
  | {
      id: string;
      type: 'parallel_group';
      batchId: string;
      lanes: ParallelLane[];
      timestamp: number;
    }
  // The card that stands in for an agent-authored document. The document itself
  // lives in the artifacts store; the card carries only what it takes to
  // identify it, so revising an artifact updates one card rather than adding a
  // second one for the same document.
  | {
      id: string;
      type: 'artifact';
      artifactId: string;
      timestamp: number;
    };

export type ArtifactKind = 'markdown' | 'html' | 'code' | 'svg' | 'mermaid' | 'json';

export interface ArtifactVersion {
  version: number;
  content: string;
  createdAt: number;
  note?: string;
}

/** An agent-authored document. Versions accumulate; nothing is overwritten. */
export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  createdAt: number;
  updatedAt: number;
  versions: ArtifactVersion[];
}

export interface ParallelLane {
  lane: string;
  laneIndex: number;
  instruction: string;
  targetFiles?: string[];
  acceptance?: string;
  phase: string; // gathering_context | working | validating | repairing | done | error
  lastTool?: string;
  activity?: string;
  report?: string;
  filesTouched?: string[];
  validationOk?: boolean;
}

// WS client messages
export type WSClientMessage =
  | { type: 'chat'; message: string; sessionId?: string; workspacePath: string; threadType?: ThreadType; specId?: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string }
  | { type: 'answer'; questionId: string; answer: string }
  | { type: 'stop'; sessionId: string }
  /** A message typed while the thread was already working. Queued rather than
   *  refused, and delivered to the running loop at its next safe boundary. */
  | { type: 'queue_message'; sessionId: string; message: string }
  /** "Stop waiting for this" — settles one live watcher immediately. The agent
   *  is told a human skipped it, so it moves on instead of reading a failure. */
  | { type: 'skip_watch'; watcherId: string }
  | { type: 'term_create'; workspacePath: string; title?: string; clientRef?: string; cols?: number; rows?: number }
  | { type: 'term_input'; terminalId: string; data: string }
  | { type: 'term_resize'; terminalId: string; cols: number; rows: number }
  | { type: 'term_kill'; terminalId: string }
  | { type: 'preview_result'; id: string; ok: boolean; result: string; image?: string; url?: string; reason?: string }
  | { type: 'preview_ready'; capable: boolean; desktop: boolean; hasWebview: boolean; url?: string | null }
  /** "This window is now looking at thread X." Lets a detached watcher's
   *  wake-up stream into the right window instead of every connected one. */
  | { type: 'focus_session'; sessionId: string | null }
  | { type: 'ping' };

// WS events from backend
/** Where a thread's work happens. Mirrors the backend's WorkspaceSource. */
export type WorkspaceSource =
  | { kind: 'local'; path: string }
  | { kind: 'ssh'; connectionId: string; remotePath: string; hostLabel?: string }
  | {
      kind: 'git';
      url: string;
      branch?: string;
      localPath: string;
      forge?: 'github' | 'gitlab' | 'other';
      host?: string;
      owner?: string;
      repo?: string;
    };

/** A saved SSH connection, as the API reports it. Never carries a secret. */
export interface SshConnectionSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'agent' | 'key' | 'password';
  privateKeyPath?: string;
  defaultPath?: string;
  fromSshConfig?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

/** A saved GitHub/GitLab account. Never carries a secret. */
export interface ForgeAccountSummary {
  id: string;
  forge: 'github' | 'gitlab';
  host: string;
  username?: string;
  tokenSource: 'vault' | 'gh-cli' | 'glab-cli' | 'environment' | 'git-credential';
  createdAt: string;
  lastUsedAt?: string;
}

/** A watcher as reported by the live table, for the Watchers panel. */
export interface WatcherRow {
  id: string;
  label: string;
  kind: string;
  settled: boolean;
  outcome?: 'met' | 'timeout' | 'failed' | 'cancelled';
  ageMs: number;
  detached: boolean;
  remainingMs: number;
  sessionId: string | null;
}

export type WSServerEvent =
  | { type: 'session_created'; sessionId: string }
  /** A run has BEGUN — from a user message, a watcher wake-up or a loop tick.
   *  This is what restores the Stop control for runs the user did not start. */
  | { type: 'run_started'; sessionId: string; trigger: 'user' | 'watcher' | 'loop' | 'resume'; detail?: string }
  | { type: 'watchers_updated'; watchers: WatcherRow[] }
  | { type: 'loop_started'; loopId: string; goal: string; maxIterations: number; maxMinutes: number }
  | { type: 'loop_iteration'; loopId: string; iteration: number; maxIterations: number; remainingMinutes: number }
  | {
      type: 'loop_finished';
      loopId: string;
      status: 'met' | 'exhausted' | 'stalled' | 'stopped' | 'failed';
      iterations: number;
      elapsedMinutes: number;
      summary: string;
    }
  | { type: 'status'; content: string }
  | { type: 'thinking'; content: string; lane?: string; laneIndex?: number }
  | { type: 'text_delta'; content: string; lane?: string; laneIndex?: number }
  | { type: 'message'; content: string; sessionId: string; lane?: string; laneIndex?: number }
  | { type: 'tool_started'; id: string; tool: string; lane?: string; laneIndex?: number }
  | { type: 'tool_progress'; id: string; tool: string; path?: string; bytes: number; lines: number; lane?: string; laneIndex?: number }
  | { type: 'context_usage'; usedTokens: number; usableTokens: number; windowTokens: number; model: string; source: string }
  | { type: 'tool_call'; id: string; tool: string; args: Record<string, unknown>; lane?: string; laneIndex?: number }
  | { type: 'tool_result'; id: string; tool: string; result: string; diff?: FileDiff[]; lane?: string; laneIndex?: number }
  | { type: 'terminal_start'; id: string; command: string; startTime: number }
  | { type: 'terminal_output'; id: string; stream: 'stdout' | 'stderr'; content: string }
  | { type: 'terminal_end'; id: string; exitCode: number; duration: number }
  | { type: 'approval_preparing'; tool: string; args: Record<string, unknown> }
  | { type: 'approval_required'; approvalId: string; tool: string; args: Record<string, unknown>; preview?: string }
  | { type: 'approval_timeout'; approvalId: string }
  | { type: 'diff'; files: FileDiff[]; lane?: string; laneIndex?: number }
  | { type: 'diagnostics'; issues: Array<{ file: string; line?: number; severity: 'error' | 'warning'; message: string }> }
  | { type: 'browser_screenshot'; content: string }
  | { type: 'preview_url'; url: string }
  | { type: 'preview_control'; id: string; action: string; params: Record<string, unknown> }
  | { type: 'preview_activate' }
  /** A registered wait finished. A DETACHED one also restarts the thread. */
  | { type: 'watcher_settled'; id: string; label: string; outcome: 'met' | 'timeout' | 'failed' | 'cancelled'; detail: string }
  /* --- Messages sent while the agent was already working ----------------
     A run is single-flight, so a second chat for a busy thread is QUEUED
     rather than refused. These three events are the whole contract:
     accepted (with the depth, so the composer can show "2 queued"),
     refused (with a reason worth reading), and delivered (so the client can
     paint the user bubble at the point the agent actually read it). */
  | { type: 'message_queued'; sessionId: string; message: string; depth: number }
  | { type: 'message_queue_rejected'; sessionId: string; message: string; reason: string; depth: number }
  | { type: 'queued_message_delivered'; sessionId: string; message: string }
  /* --- What the agent is DOING right now, in its own words ---------------
     A burst of twenty tool calls is not twenty things; it is usually three or
     four: build the thing, find out why it broke, fix it, check. The agent
     names those phases itself with set_phase (and implicitly whenever it moves
     to a new in-progress plan step), and the transcript groups the burst by
     them instead of presenting one undifferentiated run of steps. */
  | { type: 'phase'; label: string; detail?: string; source: 'agent' | 'plan' }
  | { type: 'spec_created'; spec: Spec }
  | { type: 'spec_updated'; spec: Spec }
  | { type: 'task_dispatched'; specId: string; taskId: string; taskTitle: string; index: number; total: number }
  | { type: 'task_progress'; specId: string; taskId: string; phase: string; detail?: string }
  | { type: 'task_completed'; specId: string; taskId: string; verified: boolean; summary?: string }
  | { type: 'delegation_started'; delegationId: string; instruction: string; targetFiles?: string[]; acceptance?: string; lane?: string; laneIndex?: number; parallel?: boolean; batch?: string }
  | { type: 'delegation_progress'; delegationId: string; phase: string; detail?: string; lane?: string; laneIndex?: number }
  | { type: 'delegation_completed'; delegationId: string; report: string; filesTouched: string[]; validationOk: boolean; lane?: string; laneIndex?: number }
  | { type: 'context_compacted'; tokensBefore: number; tokensAfter: number }
  | { type: 'context_migrated'; fromSessionId: string; toSessionId: string; reason: 'context_limit' | 'model_downgrade'; summary: string }
  | {
      type: 'plan_updated';
      steps: Array<{ id?: string; title: string; status: 'todo' | 'in_progress' | 'done' | 'blocked'; note?: string }>;
      owner?: 'main' | 'worker';
    }
  | {
      type: 'artifact';
      id: string;
      title: string;
      kind: ArtifactKind;
      language?: string;
      version: number;
      versionCount: number;
      note?: string;
      body: string;
      updatedAt: number;
    }
  | { type: 'prompt_checkpoint'; id: string; prompt: string; createdAt: string }
  | { type: 'question_asked'; questionId: string; question: string; options?: string[] }
  | { type: 'ollama_retry'; attempt: number; maxAttempts: number; delayMs: number; error: string }
  | { type: 'error'; message: string; recoverable?: boolean; suggestions?: string[] }
  | { type: 'done'; sessionId: string }
  | { type: 'term_created'; terminalId: string; title: string; cwd: string; clientRef?: string }
  | { type: 'term_data'; terminalId: string; data: string }
  | { type: 'term_exit'; terminalId: string; code: number | null }
  | { type: 'term_input_required'; terminalId: string; kind: string; prompt: string; suggestedReply?: string }
  | { type: 'pong' };

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  expanded?: boolean;
}

export interface AuditEvent {
  id: string;
  session_id: string;
  event_type: string;
  tool?: string;
  args?: string;
  result_summary?: string;
  tokens_used?: number;
  created_at: string;
}

// Desktop (Electron) bridge exposed via preload. Present only when running
// inside the Bubbly Desktop shell; undefined in the browser.
export interface BubblyDesktopApi {
  isDesktop: true;
  pickFolder: () => Promise<string | null>;
  getInfo: () => Promise<{ isDesktop: boolean; platform: string; version: string; port: number | null }>;
  menuAction: (action: string) => Promise<unknown>;
  onNavigate: (cb: (panel: string) => void) => () => void;
  onWorkspaceChanged: (cb: (folderPath: string) => void) => () => void;
  /** This window was opened fresh (Open with, or New Window) — start clean. */
  onNewWindow?: (cb: (payload: { workspace?: string | null }) => void) => () => void;
  /** Show a native OS notification. Suppressed by the shell when focused, unless `force`. */
  notify: (opts: {
    title: string;
    body: string;
    urgency?: 'normal' | 'critical';
    silent?: boolean;
    /** Also flash the taskbar button until the user returns. */
    attention?: boolean;
    force?: boolean;
  }) => Promise<{ shown: boolean; reason?: string }>;
  isWindowFocused: () => Promise<boolean>;
  onFocusChanged: (cb: (focused: boolean) => void) => () => void;
  /** Empty the preview webview's HTTP cache, so a reload really refetches. */
  clearPreviewCache?: () => Promise<boolean>;
  /** A thread was picked from the system-tray menu — open it in this window. */
  onOpenThread?: (cb: (sessionId: string) => void) => () => void;
  /** Open a URL in the user's default browser. */
  openExternal?: (url: string) => Promise<boolean>;
  /** Recolour the native window-control overlay to match the theme. */
  setTitleBarOverlay?: (opts: { color?: string; symbolColor?: string }) => Promise<boolean>;
}

declare global {
  interface Window {
    bubblyDesktop?: BubblyDesktopApi;
  }
}

/** Live context-window usage for the active model. */
export interface ContextUsage {
  usedTokens: number;
  usableTokens: number;
  windowTokens: number;
  model: string;
  source: string;
}
