// Core types shared across the backend

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** An image attached to a tool result so vision models can SEE it (e.g. a
 *  Bubbly Preview screenshot). `data` is raw base64 (no data: prefix). */
export interface ToolResultImage {
  mediaType: string;
  data: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; images?: ToolResultImage[] };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  result: string;
  isError?: boolean;
}

export interface ModelResponse {
  textContent: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Reasoning/thinking content emitted by the model, if any. Never shown as answer text. */
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type ModelProvider = 'claude' | 'ollama' | 'gemini' | 'openrouter';

export interface AgentConfig {
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  /** Google Gemini API key (used when provider === 'gemini'). */
  geminiApiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ollama context window (num_ctx). Defaults to 16384 if unset. */
  numCtx?: number;
  /** Memory-safe ceiling when auto-sizing num_ctx to the model's reported max. */
  autoNumCtxCeiling?: number;
  /**
   * The Ollama model's REAL operative context window, resolved once per run from
   * /api/show (see resolveNumCtx). Cloud models keep their full, uncapped window.
   * Context-pressure and migration are measured against this — not a fixed
   * 16k/32k guess — so large-window models don't migrate to a fresh thread early.
   */
  resolvedContextTokens?: number;
}

export type ThreadType = 'vibe_coding' | 'spec_session';

/** A single step in the agent's working plan (update_plan). */
export interface PlanStep {
  title: string;
  status: 'todo' | 'in_progress' | 'done';
}

/** A record of a file change made during a thread/session. */
export interface SessionChange {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  /** The unified diff patch, so the Changes panel is fully restorable on reload. */
  diff?: string;
  at: string;
}

export interface Session {
  id: string;
  workspacePath: string;
  status: 'active' | 'running' | 'idle' | 'done' | 'error';
  provider: ModelProvider;
  model: string;
  threadType: ThreadType;
  threadName?: string;
  parentSessionId?: string;
  firstMessage?: string;
  specId?: string;
  /** Persisted working plan (update_plan), restored on reopen. */
  plan?: PlanStep[];
  /** Persisted list of file changes made during this thread. */
  sessionChanges?: SessionChange[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetadata {
  id: string;
  threadType: ThreadType;
  specId?: string;
  firstMessage: string;
  messageCount: number;
  provider: ModelProvider;
  model: string;
  status: Session['status'];
  threadName?: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  tool: string;
  args: string;
  preview?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  eventType: string;
  tool?: string;
  args?: string;
  resultSummary?: string;
  tokensUsed?: number;
  createdAt: string;
}

export interface Spec {
  id: string;
  projectId?: string;
  title: string;
  type: 'feature' | 'bugfix' | 'refactor' | 'research';
  status: 'draft' | 'in_progress' | 'done' | 'cancelled';
  /**
   * Staged authoring phase for the three-document workflow. The spec is built
   * one document at a time, each gated by user approval:
   *   requirements → design → tasks → ready
   * The agent must not skip ahead: design reads requirements, tasks read both.
   */
  phase?: SpecPhase;
  /**
   * Human-readable requirement summaries (kept for backward compatibility and
   * quick display). When the elevated spec system is used, `properties` holds
   * the structured, testable version of these.
   */
  requirements: string[];
  /**
   * Structured, testable acceptance properties in EARS-style form. These are
   * the "contract" the implementation must satisfy and what the verifier checks
   * against. Optional so older specs still load.
   */
  properties?: SpecProperty[];
  /**
   * Design document (markdown): architecture, components, data models,
   * sequencing, and decisions. Authored AFTER requirements are approved.
   */
  design?: string;
  tasks: SpecTask[];
  notes?: string;
  /** Per-phase approval flags so the UI/agent know what's been signed off. */
  approvals?: { requirements?: boolean; design?: boolean; tasks?: boolean };
  createdAt: string;
  updatedAt: string;
}

/** Authoring phase for the staged requirements → design → tasks workflow. */
export type SpecPhase = 'requirements' | 'design' | 'tasks' | 'ready';

/**
 * A single testable acceptance criterion, expressed in EARS form
 * ("WHEN <trigger> THE SYSTEM SHALL <response>"). Properties are how the dream's
 * "spec as control layer" becomes verifiable rather than vague prose.
 */
export interface SpecProperty {
  id: string;
  /** EARS-style statement: when/where/then the system shall ... */
  statement: string;
  /** Optional category to aid organization. */
  kind?: 'functional' | 'constraint' | 'invariant' | 'edge_case';
  /** Concrete, checkable signal that this property holds. */
  acceptance?: string;
}

export interface SpecTask {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  agent?: string;
  /** Files this task is expected to create or modify (relative paths). */
  targetFiles?: string[];
  /** IDs of tasks that must complete before this one can start. */
  dependsOn?: string[];
  /** IDs of the spec properties this task is responsible for satisfying. */
  satisfiesProperties?: string[];
  /** Concrete, checkable definition of done for this task. */
  acceptance?: string;
  /** The exact command that proves this task works (e.g. "npm test src/foo"). */
  verifyWith?: string;
  /** How the verifier reasoned about this task on its last check. */
  verificationNote?: string;
  /** Optional ordered sub-tasks — a task can be broken into smaller units. */
  subTasks?: SpecSubTask[];
}

/** A smaller unit of work nested under a SpecTask. */
export interface SpecSubTask {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  acceptance?: string;
}

export interface Settings {
  anthropicApiKey: string;
  geminiApiKey: string;
  ollamaBaseUrl: string;
  defaultProvider: ModelProvider;
  claudeModel: string;
  geminiModel: string;
  ollamaModel: string;
  workspacePath: string;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  theme: 'light' | 'dark' | 'system';
  ollamaEnableThinking: boolean;
  ollamaRetryMaxAttempts: number;
  ollamaRetryInitialDelayMs: number;
  ollamaRetryBackoffMultiplier: number;
}

// WebSocket protocol
export type WSClientMessage =
  | {
      type: 'chat';
      message: string;
      sessionId?: string;
      workspacePath: string;
      threadType?: ThreadType;
      specId?: string;
      /**
       * Where this thread's work happens. Sent on the FIRST message of a thread
       * and recorded against the session, so reopening it later still resolves
       * files on the right machine. Absent means a local directory.
       */
      source?:
        | { kind: 'local'; path: string }
        | { kind: 'ssh'; connectionId: string; remotePath: string }
        | { kind: 'git'; url: string; branch?: string; localPath: string; forge?: string; host?: string; owner?: string; repo?: string };
      /**
       * A slash-command workflow to run instead of sending `message` verbatim.
       * The workflow expands into the real prompt on the server, so the CLI and
       * the desktop app cannot drift apart about what `/fix` means.
       */
      workflow?: { command: string; args: Record<string, string>; openFiles?: string[] };
    }
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
  /** Result of a preview_control action executed against the live webview. */
  | { type: 'preview_result'; id: string; ok: boolean; result: string; image?: string; url?: string; reason?: string }
  /** Renderer advertising whether it can actually drive a live webview right now. */
  | { type: 'preview_ready'; capable: boolean; desktop: boolean; hasWebview: boolean; url?: string | null }
  /** "This window is now looking at thread X." Lets a detached watcher's
   *  wake-up stream into the right window instead of every connected one. */
  | { type: 'focus_session'; sessionId: string | null }
  | { type: 'ping' };

/**
 * Every event carries a monotonically increasing sequence number, assigned at
 * the moment it is sent. The client uses it to render strictly in emission
 * order — without it, a burst of parallel tool calls could paint a result above
 * the call it belongs to, because the result was appended to the end of the
 * transcript rather than placed next to its call.
 */
export interface WSEventEnvelope {
  seq?: number;
}

export type WSServerEvent =
  | { type: 'session_created'; sessionId: string }
  /** A run has BEGUN. Emitted for every start, including the automatic wake-up
   *  after a detached watcher settles — which is how the client knows to put the
   *  Stop button back. Before this existed, a woken thread streamed output with
   *  no way to interrupt it. */
  | { type: 'run_started'; sessionId: string; trigger: 'user' | 'watcher' | 'loop' | 'resume'; detail?: string }
  /** A /loop workflow began. The client shows a round counter and a budget. */
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
  /** The live watcher table, pushed whenever it changes, for the Watchers panel. */
  | {
      type: 'watchers_updated';
      watchers: Array<{
        id: string; label: string; kind: string; settled: boolean;
        outcome?: 'met' | 'timeout' | 'failed' | 'cancelled';
        ageMs: number; detached: boolean; remainingMs: number; sessionId: string | null;
      }>;
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
  /** Ask the renderer to drive the live Bubbly Preview webview and reply with preview_result. */
  | { type: 'preview_control'; id: string; action: string; params: Record<string, unknown> }
  /** Reveal the Bubbly Preview panel because a browser tool is about to run. */
  | { type: 'preview_activate' }
  /** A registered wait finished. Informational — a DETACHED one also restarts
   *  the thread automatically (see the settle listener in index.ts). */
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
  | { type: 'plan_updated'; steps: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>; owner?: 'main' | 'worker' }
  // An agent-authored document was created or revised. Carries the content so
  // the panel can render it without fetching what we just sent.
  | {
      type: 'artifact';
      id: string;
      title: string;
      kind: 'markdown' | 'html' | 'code' | 'svg' | 'mermaid' | 'json';
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
  // Interactive terminal session events (IDE-style integrated terminal)
  | { type: 'term_created'; terminalId: string; title: string; cwd: string; clientRef?: string }
  | { type: 'term_data'; terminalId: string; data: string }
  | { type: 'term_exit'; terminalId: string; code: number | null }
  // Emitted when a terminal appears to be blocked waiting for keyboard input.
  | { type: 'term_input_required'; terminalId: string; kind: string; prompt: string; suggestedReply?: string }
  | { type: 'pong' };

export interface FileDiff {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  diff: string;
  additions: number;
  deletions: number;
}

// Tool definitions shared format
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
