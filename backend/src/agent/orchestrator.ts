import { v4 as uuidv4 } from 'uuid';
import { callModel } from '../models/index';
import { TOOL_DEFINITIONS, executeTool, checkRequiresApproval } from './tools/index';

/**
 * Tools the LEAD agent is allowed to use, by mode:
 *  - SPEC mode: the lead is a tech lead, not a doer. It plans and delegates and
 *    physically CANNOT mutate the workspace — those tools are reserved for
 *    worker agents spawned via delegate_task.
 *  - VIBE mode: the lead is hands-on. It keeps the read-only navigation + plan +
 *    delegate tools AND gets direct-work tools (edit/write/run/...) so small,
 *    well-scoped changes are made directly without paying the cost of spinning
 *    up a worker. Big jobs still go through delegate_task.
 * This constant lists the always-available lead tools (planning, delegation,
 * human input, read-only navigation, spec authoring). leadToolsForThread()
 * filters/extends it per mode.
 */
/**
 * Read progress out of a tool call's PARTIALLY streamed JSON arguments.
 *
 * The JSON is incomplete by definition — we are reading it mid-flight — so this
 * never attempts a parse. It scrapes the two facts worth showing while a large
 * file is being generated: WHICH file (available almost immediately, since
 * "path" is emitted before the bulky "content"), and HOW MUCH of it exists so
 * far. Escaped newlines in the JSON string are the file's real line breaks, so
 * counting them gives a live line count that tracks the file as it is written.
 */
export function describeToolProgress(partialJson: string): { path?: string; bytes: number; lines: number } {
  let filePath: string | undefined;
  // Matches "path": "…" (and file_path/target) with escapes, before the value
  // is necessarily followed by anything else.
  const m = /"(?:path|file_path|target)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialJson);
  if (m) {
    try { filePath = JSON.parse(`"${m[1]}"`) as string; } catch { filePath = m[1]; }
  }
  // Count escaped newlines — these are the content's own line breaks. A file
  // still on its first line reports 1, not 0, which reads correctly.
  //
  // The escape must be CONSUMED whatever it is, not just when it's \n. Scanning
  // naively for a backslash followed by 'n' misreads the pair `\\n` (an escaped
  // backslash, then a literal n) as a line break — which inflates the count for
  // any file containing `\n` in prose, and worse, for every Windows path whose
  // next segment starts with n ("src\\newdir\\x.ts").
  let lines = 0;
  for (let i = 0; i < partialJson.length - 1; i++) {
    if (partialJson[i] !== '\\') continue;
    if (partialJson[i + 1] === 'n') lines++;
    i++; // skip the escaped character regardless of what it was
  }
  return { path: filePath, bytes: partialJson.length, lines: lines + 1 };
}

const LEAD_TOOL_NAMES = new Set<string>([
  // Planning + delegation + human input
  'update_plan',
  'delegate_task',
  'delegate_parallel',
  'ask_user',
  // Read-only orientation / navigation
  'read_file',
  'read_files',
  'list_directory',
  'get_file_tree',
  'search_in_files',
  'grep_search',
  'find_files',
  'get_repo_map',
  'find_symbol',
  'find_references',
  'get_file_outline',
  'gather_context',
  'read_config',
  'validate_changes',
  // Waiting on slow work is needed in EVERY mode — a spec lead watching a test
  // run should no more poll for it than a vibe lead should.
  'watch',
  // Spec authoring (read + structure only; no code mutation)
  'create_spec',
  'read_spec',
  'list_specs',
  'update_spec_status',
  'add_spec_task',
  'update_task_status',
  'get_next_task',
  'set_spec_design',
  'approve_spec_phase',
  'add_sub_tasks',
]);

const LEAD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => LEAD_TOOL_NAMES.has(t.name));

/** Spec-authoring tools — ONLY available in spec_session threads. */
const SPEC_TOOL_NAMES = new Set<string>([
  'create_spec', 'read_spec', 'list_specs', 'update_spec_status', 'add_spec_task',
  'update_task_status', 'get_next_task', 'set_spec_design', 'approve_spec_phase', 'add_sub_tasks',
]);

/**
 * Mutating "do the work directly" tools. In VIBE mode the lead is allowed to use
 * these so small, well-scoped changes don't have to pay the cost of spinning up
 * a worker sub-agent (which burns extra tokens and time). Big jobs still go
 * through delegate_task. In SPEC mode these stay off the lead — spec work is
 * always delegated/structured.
 */
const DIRECT_WORK_TOOL_NAMES = new Set<string>([
  'write_file', 'edit_file', 'append_file', 'delete_file', 'create_directory',
  'run_command', 'run_background', 'get_process_output', 'list_processes', 'stop_process', 'watch',
  'git_status', 'git_diff', 'git_add_and_commit', 'git_log',
  'create_checkpoint', 'list_checkpoints', 'revert_to_checkpoint', 'rename_symbol',
  // preview_config travels with browser_control: the agent cannot preview
  // without a run config, so it must be able to author one wherever it browses.
  'computer_control', 'browser_control', 'preview_config',
]);

const DIRECT_WORK_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => DIRECT_WORK_TOOL_NAMES.has(t.name));

/**
 * The lead's toolset for a given thread type. Hard separation of modes:
 *   - vibe_coding: planning (update_plan) + delegation + read-only navigation
 *     PLUS direct-work tools so the lead can make minimal edits itself without
 *     elevating to a worker. NO spec tools — a spec must NEVER be created here.
 *   - spec_session: planning-free (specs ARE the plan), delegation + read-only
 *     navigation + spec-authoring tools. No direct-work tools (spec work is
 *     always structured/delegated).
 * delegate_task is available in BOTH modes.
 */
function leadToolsForThread(threadType?: ThreadType) {
  if (threadType === 'spec_session') {
    // Everything in the lead set except update_plan (specs ARE the plan here).
    return LEAD_TOOL_DEFINITIONS.filter((t) => t.name !== 'update_plan');
  }
  // Vibe coding (default): drop spec-authoring tools, but ADD direct-work tools
  // so the lead can handle small edits directly (only delegating big tasks).
  const base = LEAD_TOOL_DEFINITIONS.filter((t) => !SPEC_TOOL_NAMES.has(t.name));
  const have = new Set(base.map((t) => t.name));
  return [...base, ...DIRECT_WORK_TOOL_DEFINITIONS.filter((t) => !have.has(t.name))];
}

import { loadSteeringContext, loadReadme, detectProjectType } from '../steering/loader';
import { logger } from '../utils/logger';
import { sendErrorEvent } from '../utils/errorHandler';
import {
  createSession,
  updateSessionStatus,
  saveMessage,
  saveTurn,
  getMessages,
  logAuditEvent,
  updateFirstMessage,
  updateSessionSpecId,
  getSession,
  saveSessionPlan,
  recordSessionChanges,
} from '../session/manager';
import { 
  lockSpecToSession, 
  getNextTask, 
  updateTaskStatus, 
  areAllTasksComplete,
  updateSpec,
  readSpec,
} from './tools/specs';
import { getAllSettings } from '../db/index';
import { StreamBuffer } from '../models/streamBuffer';
import { verifyTaskCompletion } from './verifier';
import { getIndex, buildRepoMap } from './intelligence/codeIntelligence';
import { runValidation, formatIssuesForRepair } from './intelligence/validator';
import { compactHistory, sanitizeHistory, estimateTotalTokens } from './contextManager';
import { getContextLimit, usableInputTokens, estimateTextTokens } from './contextLimits';
import { resolveNumCtx } from '../models/ollama';
import { runSpecToCompletion } from './specOrchestrator';
import {
  shouldMigrateForPressure,
  detectModelDowngrade,
  migrateToFreshThread,
} from './contextMigration';
import type { Message, AgentConfig, WSServerEvent, FileDiff, ModelResponse, ThreadType } from '../types';

// Pending approvals: approvalId → { resolve }
const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    logger.warn('Approval resolution failed: not found', { approvalId });
    return false;
  }
  pending.resolve(approved);
  pendingApprovals.delete(approvalId);
  logger.info('Approval resolved', { approvalId, approved });
  return true;
}

// Pending user questions (ask_user tool): questionId → { resolve }
const pendingQuestions = new Map<string, { resolve: (answer: string) => void }>();

export function resolveQuestion(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId);
  if (!pending) {
    logger.warn('Question resolution failed: not found', { questionId });
    return false;
  }
  pending.resolve(answer);
  pendingQuestions.delete(questionId);
  logger.info('Question answered', { questionId });
  return true;
}

// Active sessions that can be stopped
const activeSessions = new Map<string, { stop: () => void }>();

export function stopSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    logger.info('Session stop requested', { sessionId });
    session.stop();
    activeSessions.delete(sessionId);
  } else {
    logger.warn('Session stop failed: not found', { sessionId });
  }
}

/**
 * Request human approval for a tool call. Persists the pending approval, emits
 * the UI events, and resolves when the user decides (or after a 5-minute
 * timeout → declined). Shared by the main loop and the spec task agents.
 */
async function requestApprovalShared(params: {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview?: string;
  onEvent: (event: WSServerEvent) => void;
}): Promise<boolean> {
  const { sessionId, toolName, args, preview, onEvent } = params;
  const approvalId = uuidv4();

  onEvent({ type: 'approval_preparing', tool: toolName, args });
  onEvent({ type: 'approval_required', approvalId, tool: toolName, args, preview });

  try {
    const db = (await import('../db/index')).getDb();
    db.prepare(
      `INSERT INTO approvals (id, session_id, tool, args, preview, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(approvalId, sessionId, toolName, JSON.stringify(args), preview ?? null, new Date().toISOString());

    const approved = await new Promise<boolean>((resolve) => {
      pendingApprovals.set(approvalId, { resolve });
      setTimeout(() => {
        if (pendingApprovals.has(approvalId)) {
          pendingApprovals.delete(approvalId);
          // Tell the UI the card expired, otherwise it stays "pending" forever
          // and a later click produces a confusing "not found" error.
          onEvent({ type: 'approval_timeout', approvalId });
          resolve(false);
        }
      }, 5 * 60 * 1000);
    });

    db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(approved ? 'approved' : 'rejected', approvalId);
    return approved;
  } catch (err) {
    logger.error('Approval request failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function getOSName(): string {
  switch (process.platform) {
    case 'win32': return `Windows (${process.arch})`;
    case 'darwin': return `macOS (${process.arch})`;
    case 'linux': return `Linux (${process.arch})`;
    default: return `${process.platform} (${process.arch})`;
  }
}

export function buildSystemPrompt(
  workspacePath: string, 
  projectType: string, 
  threadType?: ThreadType,
  specId?: string
): string {
  const steeringContext = loadSteeringContext(workspacePath);
  const readme = loadReadme(workspacePath);

  let specSessionInstructions = '';
  if (threadType === 'spec_session') {
    specSessionInstructions = `

## Spec Session Mode — staged, human-in-the-loop spec authoring

You are a TECH LEAD. In a Spec Session you build a proper spec with the user BEFORE any code is written, one document at a time, each gated by the user's approval. You never create everything at once.

The three documents (created strictly in order once a starting point is chosen):
1. **Requirements** — what we're building and why, as testable EARS acceptance properties. PRESENT the requirements to the user in chat and ask them to review. Do not proceed until they approve.
2. **Design** — the architecture, components, data models, interfaces, sequencing, decisions. First read requirements (read_spec). Then WRITE the full design directly in your reply as markdown. The app automatically saves your written design to design.md — you do NOT need to call a tool for it, and you should NOT try to pass the whole design as a tool argument. Just write it, then stop and wait for approval.
3. **Tasks** — only AFTER design is approved. Read requirements + design, then break the work into concrete, ordered tasks using add_spec_task / create_spec task_details. Use add_sub_tasks to decompose any task that's too large. PRESENT the task list and wait for approval.

CHOOSING THE STARTING POINT (do this FIRST):
- Before creating anything, use **ask_user** to ask whether they'd like to start **requirements-first** (default — clarify what/why, then design) or **design-first** (jump into architecture, then back-fill requirements). Offer both as options.
- Regardless of which they choose, call **create_spec(staged: true, startPhase: "requirements" | "design")** EXACTLY ONCE, right after they answer — this is what creates the spec_id everything else attaches to. Never call create_spec a second time for the same spec.
- If they choose requirements-first: create_spec already saved the requirements — present them, then proceed 2 → 3 above.
- If they choose design-first: create_spec (startPhase: "design") creates an empty spec already sitting in the design phase — then author the **Design** (write it in your reply; it's saved to that spec_id automatically), get approval, then derive **Requirements** from it (update_spec_status/read back as needed) and get approval, then **Tasks**. The approval gates still apply — just in the order the user picked.
- If the user already made their preference clear in their message, skip the question and proceed the same way (create_spec once, then author).

Approval gates:
- After the user approves a document, call approve_spec_phase(spec_id, "requirements"|"design"|"tasks"). This advances the phase. You may NOT author the next document before the current one is approved — the tools will refuse.
- Call approve_spec_phase EXACTLY ONCE per phase. If it tells you the phase was already advanced, do NOT call it again — move on to the pending action it names.
- If the request is genuinely ambiguous, ask the user with the **ask_user** tool (it pauses for their answer) — don't just write questions into chat and stop.

CRITICAL — saving documents (the three markdown files ARE the spec):
- Each spec lives at \`.bubbly/specs/<spec_id>/\` as three markdown files: **requirements.md**, **design.md**, **tasks.md**. Those files are the SOURCE OF TRUTH — whatever is in them is what the spec says.
- To author or revise a document, WRITE THE FILE with write_file (or edit_file for a tweak). That is the only save mechanism; there is no separate "set the design" or "set the requirements" tool, and nothing is captured implicitly from your chat message.
- Always ALSO present the document in your reply so the user can review it without opening a file — but the file write is what persists it.
- This applies in every order. Design-first means: write design.md → get approval → write requirements.md → get approval → write tasks.md. Requirements are never skipped just because you started with the design.
- tasks.md tracks progress through its checkboxes: \`- [ ]\` not started · \`- [~]\` in progress · \`- [x]\` done. Update a task by editing that one character. Never renumber or reword a task's \`**id**\` — other tasks depend on it.

Style:
- Be concise. Present each document ONCE, then STOP and wait for the user — your turn is over after presenting. Do NOT restate or re-summarize the same requirements/design/tasks multiple times in one turn. One clear presentation, then end your turn. No filler, no repeated "here's what I'll do" paragraphs.

Executing tasks (only once phase is "ready"):
- Work tasks in dependency order. Mark a task in_progress when you start it; implement it; validate; then mark it done. A task is verified before the next begins.
- NEVER move to the next task until the current one is genuinely complete and verified. Keep at most one task in_progress.
- You may delegate implementation to a worker with delegate_task, or implement directly — your judgment.
${specId ? `\nThe active spec for this session is: ${specId}` : `\nNo spec exists yet — create one (staged) as your first meaningful action once you understand the request.`}
`;
  }

  return `You are BUBBLY, an expert software engineering agent working on a ${projectType} project.

Your workspace is: ${workspacePath}

## Environment (IMPORTANT)
- Operating system: ${getOSName()}
- Shell for run_command: ${process.platform === 'win32' ? 'PowerShell (powershell.exe)' : 'sh/bash'}
${process.platform === 'win32'
  ? `- You are on WINDOWS. Use PowerShell commands, NOT Unix/Linux commands. Examples: use \`Get-ChildItem\` or \`dir\` (not \`ls\`), \`Get-Content\` (not \`cat\`), \`Remove-Item\` (not \`rm\`), \`Copy-Item\` (not \`cp\`), \`New-Item -ItemType Directory\` (not \`mkdir -p\`), \`Select-String\` (not \`grep\`). Use \`;\` to chain commands, NOT \`&&\`. Use backslashes or forward slashes in paths.`
  : `- You are on a Unix-like system. Standard sh/bash commands work.`}
- When running commands, match this OS. Do not assume Linux.

## How you work
${threadType === 'spec_session'
  ? `You are the lead engineer. You do NOT edit files, run commands, or implement anything yourself — you literally don't have those tools. Your job for every request:
1. Briefly orient yourself if needed using your read-only tools (get_repo_map, read_file, grep_search, find_symbol, etc.).
2. Build the spec (requirements → design → tasks) as described above. The SPEC and its tasks ARE your plan — there is no separate plan tool in this mode.
3. For EACH task, call **delegate_task** with a clear, self-contained instruction (plus likely target files and a concrete acceptance criterion). A focused worker agent does the real work — reads/edits files, runs commands, validates — and reports back.
   - When several upcoming tasks are INDEPENDENT and touch completely separate files, call **delegate_parallel** with 2-4 of them at once to run those workers simultaneously. Each task MUST list its target_files and they must not overlap. If they can't be cleanly separated, use delegate_task one at a time.
4. Track progress by editing **tasks.md** directly — it is the source of truth. Before starting a task set its marker to \`- [~]\`, and when the worker reports it verified set it to \`- [x]\`. Read the file, change the one character, write it back. Keep at most one task \`[~]\` at a time (a delegate_parallel batch may hold several).
   - Markers: \`- [ ]\` not started · \`- [~]\` in progress · \`- [x]\` done. Never invent other markers, and never renumber or reword a task's \`**id**\` — other tasks depend on it.
5. When every step is done, give a short final summary and STOP. Your turn is over — do not keep going.

In Spec mode, implementation ALWAYS goes through delegate_task or delegate_parallel. You never paste code, never edit files, never run commands directly. You stay locked to THIS spec — do not start unrelated work; if the user asks for something outside the spec, fold it into the spec (new requirement/task) rather than freelancing.`
  : `You are a hands-on engineer who knows when to do it yourself and when to delegate. Your judgment on scope is the whole game:

**Do it directly (the common case).** For small, well-scoped changes — editing a file or two, a quick fix, adding a component, running a command, a small new file — just DO it with your tools (edit_file, write_file, run_command, etc.). Do NOT spin up a worker for this; delegating small work wastes tokens and time.

**Delegate big jobs.** Use **delegate_task** only when the work is genuinely large or parallelizable — e.g. "build out an entire feature across many files", "scaffold a whole module", or several independent chunks. A worker handles ONE unit end-to-end (edits, runs, validates) and reports back.

Rule of thumb: if you could finish it yourself in a handful of tool calls, do it yourself. If it would take a worker its own focused session, delegate it.

Your flow for a request:
1. Orient if needed (get_repo_map, read_file, grep_search, find_symbol).
2. Lay out a plan with **update_plan** for anything non-trivial (multiple steps). Skip the plan for a one-liner.
3. Execute: edit directly for small steps, delegate the big ones.
4. Mark steps done with **update_plan** as you go.
5. Give a short final summary and STOP.`}

Write your narration as normal prose — a sentence or two about what you're doing and why. Do NOT wrap reasoning in tags or force a "thinking" section; if your model has a separate reasoning channel, use it naturally and the app handles it.

## Delegation (for big jobs)
- **delegate_task(instruction, target_files?, acceptance?)** runs a worker that implements ONE larger unit of work, validates it, and reports back. Give it everything it needs to succeed on its own.
- For pure questions / explanations (no changes needed), just answer using your read-only tools.

## Navigate by STRUCTURE, not by reading everything
You have read-only tools to orient yourself and write good delegation instructions:
- **get_repo_map(focus?)** — compressed, ranked map of important files + their signatures. Good first move.
- **find_symbol(name)** — jump to where something is declared (file + line + signature).
- **find_references(name)** — every place a symbol is used (the blast radius before a change).
- **get_file_outline(path)** — a file's structure without reading the whole thing.
- **grep_search(pattern)** — regex search across files. **find_files(query)** — fuzzy-find a file by name.
- **read_file** / **read_files** — read one or several files.

## What workers do (so you write good tickets when you DO delegate)
Workers have the full toolset: they edit files (minimal edit_file changes for existing files, write_file/append_file for new ones), run commands and background processes, validate their changes, and create checkpoints. You don't need to spell out HOW — just give a clear WHAT and the acceptance criterion, and let the worker choose the means.

## Bubbly Preview — ALWAYS use it for anything with a UI
Bubbly Preview is a live browser docked in the right panel, driven by the **browser_control** tool. Every action you take (open, click, type, scroll, reload) streams a fresh frame into it, so the user WATCHES you work.

**Prerequisite — the run config.** browser_control is BLOCKED until the project has a run config (.bubbly/browser-meta.json) describing how to start it. You author it, once, after understanding the project:
1. \`preview_config detect\` — see what Bubbly auto-detected.
2. Verify it against reality: read the root package.json scripts, check for subdirectories (frontend/, api/, apps/*), and work out which service serves the UI and on what port. Detection is a hint, not an answer.
3. \`preview_config write\` — record EVERY runnable service, each with its own \`cwd\`, \`start\`, and \`kind\`. A monorepo with a Vite UI and an Express API needs both entries; one Run then starts them all. Exactly one service is \`kind:"frontend"\` — that's the page the preview opens.
If a config ALREADY exists, it is authoritative: use it, don't re-write it, and never clobber hand-edited commands. Re-write only when browser_control reports the config is broken or a service is missing.
- If the project has ANY web UI (a frontend, a dev server, a page, a component you changed), you MUST verify it in Bubbly Preview — do not just describe the result. Start the app (run_background for a dev server), then browser_control open(url) to load it, and click/type/scroll to exercise what you built.
- After a code change to UI, browser_control reload to see the new state.
- Use browser_control screenshot to actually SEE the rendered design (it returns the image, not just text) before judging whether the UI is correct.
- This is the single place the user sees your web work — use it liberally instead of leaving the user to open things themselves. (If it says browser control is disabled, ask the user to enable "Allow browser control" in Settings.)

## Background work — keep moving; do NOT wait around
\`run_background\` returns immediately. The DEFAULT after starting something is to **carry on with other work** — do not wait for it, and do not poll \`get_process_output\` in a loop (each poll is a full round-trip that re-sends the whole conversation and usually tells you nothing).
- Read a background process's output ONCE, when you actually need to know something from it.
- Blocking is a last resort, and only for a SHORT gate you cannot proceed without — e.g. \`watch(condition:"port_open", port:5173)\` for a few seconds before opening the browser. Blocking waits are capped at 60s no matter what you request, because they freeze the session.
- For anything genuinely slow (a real build, an install, a test suite), do NOT sit on it. Use \`watch(..., detached:true)\`, then FINISH YOUR TURN and tell the user what you're waiting on. You will be resumed with the result when it lands — that is the whole point, and it costs one turn instead of a frozen session.
- Never watch something just because you started it. Watch only when you genuinely cannot continue without the outcome.

## Writing for the user
- DEFAULT TO ACTION: decide and proceed on routine choices (naming, structure, sensible defaults). Note the choice briefly.
- Use **ask_user(question)** ONLY when genuinely blocked or facing a high-stakes, ambiguous decision you shouldn't make alone.
- Don't dump large blocks of implementation code into chat — make the change with your tools instead. (Short illustrative snippets inside an explanation are fine.)

## Working style${threadType === 'vibe_coding' ? ' (Vibe mode — fast and direct)' : ''}
${threadType === 'vibe_coding'
  ? '- Favor doing small work yourself; reserve delegation for genuinely large jobs. Keep the user moving fast.'
  : '- Plan the whole request, delegate each step, mark steps done as workers report back, then summarize and STOP.'}
- Match the repo's existing style and conventions. Don't introduce unnecessary dependencies.
- Wrap up with a brief, plain-language summary of what was built.

${steeringContext ? steeringContext : ''}

${readme ? `## Project README\n\n${readme}` : ''}
${specSessionInstructions}

## Important
- Use relative paths for all file operations (relative to the workspace root)
- Never escape the workspace directory
- Keep the user informed with brief explanations as you work
`.trim();
}

export async function runAgentLoop(params: {
  sessionId?: string;
  userMessage: string;
  workspacePath: string;
  threadType?: ThreadType;
  specId?: string;
  onEvent: (event: WSServerEvent) => void;
}): Promise<void> {
  logger.info('Agent loop starting', { 
    sessionId: params.sessionId, 
    workspacePath: params.workspacePath,
    messageLength: params.userMessage.length,
    threadType: params.threadType,
    specId: params.specId
  });
  
  const settings = getAllSettings();
  const provider = settings.defaultProvider as 'claude' | 'ollama' | 'gemini';
  const model =
    provider === 'claude' ? settings.claudeModel
    : provider === 'gemini' ? settings.geminiModel
    : settings.ollamaModel;
  const requireApprovalForWrites = settings.requireApprovalForWrites === 'true';
  const requireApprovalForShell = settings.requireApprovalForShell === 'true';
  const enableThinking = provider === 'ollama' && settings.ollamaEnableThinking === 'true';
  // IDE preferences (with safe defaults for older DBs).
  const multiAgentSpec = settings.multiAgentSpec !== 'false';
  const contextTokenBudget = parseInt(settings.contextTokenBudget || '24000', 10) || 24000;
  const autoValidate = settings.autoValidate !== 'false';
  const autoContextMigration = settings.autoContextMigration !== 'false';
  const contextMigrationThreshold = parseFloat(settings.contextMigrationThreshold || '0.85') || 0.85;
  
  // Parse Ollama retry configuration from settings
  const ollamaRetryConfig = provider === 'ollama' ? {
    maxAttempts: parseInt(settings.ollamaRetryMaxAttempts || '5', 10),
    initialDelayMs: parseInt(settings.ollamaRetryInitialDelayMs || '1000', 10),
    backoffMultiplier: parseFloat(settings.ollamaRetryBackoffMultiplier || '2'),
    // Per-attempt ceiling for a MODEL call. Local/tunneled models routinely take
    // well over 30s for prompt-eval + first token on a big context, so a short
    // timeout was aborting healthy requests and burning all retries (3×30s).
    // The user has a Stop button, so allow a generous ceiling.
    timeoutMs: parseInt(settings.ollamaRequestTimeoutMs || '300000', 10) || 300000,
  } : undefined;

  logger.debug('Agent configuration', { 
    provider, 
    model, 
    requireApprovalForWrites, 
    requireApprovalForShell, 
    enableThinking,
    ollamaRetryConfig 
  });

  // Validate configuration before starting
  if (provider === 'claude' && !settings.anthropicApiKey) {
    logger.error('Claude API key not configured');
    params.onEvent({ 
      type: 'error', 
      message: 'Claude API key not configured. Please add your Anthropic API key in Settings.',
      recoverable: true,
      suggestions: [
        'Open Settings and add your Anthropic API key',
        'Get an API key from https://console.anthropic.com',
        'Alternatively, switch to Ollama in Settings',
      ],
    });
    return;
  }

  if (provider === 'gemini' && !settings.geminiApiKey) {
    logger.error('Gemini API key not configured');
    params.onEvent({
      type: 'error',
      message: 'Google Gemini API key not configured. Please add your Gemini API key in Settings.',
      recoverable: true,
      suggestions: [
        'Open Settings and add your Google Gemini API key',
        'Get an API key from https://aistudio.google.com/app/apikey',
        'Alternatively, switch to Claude or Ollama in Settings',
      ],
    });
    return;
  }

  if (provider === 'ollama') {
    try {
      const ollamaUrl = settings.ollamaBaseUrl || 'http://localhost:11434';
      const response = await fetch(`${ollamaUrl}/api/tags`, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (!response.ok) {
        logger.warn('Ollama connectivity check failed', { 
          status: response.status,
          url: ollamaUrl 
        });
        params.onEvent({ 
          type: 'status', 
          content: `Warning: Ollama returned status ${response.status}. Attempting to continue...` 
        });
      }
    } catch (err) {
      logger.warn('Ollama connectivity check error', { 
        error: err instanceof Error ? err.message : String(err),
        url: settings.ollamaBaseUrl 
      });
      params.onEvent({ 
        type: 'status', 
        content: `Warning: Cannot verify Ollama connection. Attempting to continue...` 
      });
      // Don't return - let it try anyway
    }
  }

  const agentConfig: AgentConfig = {
    provider,
    model,
    apiKey: settings.anthropicApiKey || undefined,
    geminiApiKey: settings.geminiApiKey || undefined,
    baseUrl: settings.ollamaBaseUrl || 'http://localhost:11434',
    // Output ceiling. A whole large file is emitted inside ONE tool-call
    // argument, so a low cap truncates it mid-generation (the #1 cause of
    // "files keep truncating"). Modern Claude models support far more; give
    // generations real room. (Ollama ignores this and uses num_predict:-1.)
    maxTokens: 32000,
    numCtx: parseInt(settings.ollamaNumCtx || '16384', 10) || 16384,
    // Only set a ceiling (which enables auto-sizing via /api/show) when the
    // user has auto-sizing on. Off → undefined → callOllama uses numCtx as-is.
    autoNumCtxCeiling: settings.ollamaAutoNumCtx !== 'false'
      ? (parseInt(settings.ollamaNumCtxCeiling || '32768', 10) || 32768)
      : undefined,
  };

  // Resolve each Ollama model's REAL context window ONCE, so context-pressure
  // and thread migration are measured against what the model can actually
  // attend to — not a fixed 16k/32k guess. Without this, a large-window model
  // (e.g. a cloud MiniMax) served over the Ollama path is treated as a tiny
  // local model and migrates to a fresh thread every few file reads, redoing
  // work forever. Cloud models keep their full, uncapped window (see
  // resolveNumCtx); the result is cached per model so this is cheap.
  if (agentConfig.provider === 'ollama') {
    if (agentConfig.autoNumCtxCeiling !== undefined) {
      try {
        const resolved = await resolveNumCtx({
          baseUrl: agentConfig.baseUrl ?? 'http://localhost:11434',
          model: agentConfig.model,
          configuredNumCtx: agentConfig.numCtx,
          ceiling: agentConfig.autoNumCtxCeiling,
        });
        agentConfig.resolvedContextTokens = resolved.numCtx;
        logger.info('Resolved operative context window for Ollama model', {
          model: agentConfig.model, tokens: resolved.numCtx, source: resolved.source,
        });
      } catch (err) {
        logger.warn('Could not resolve operative context window; falling back to configured num_ctx', {
          model: agentConfig.model, error: err instanceof Error ? err.message : String(err),
        });
        agentConfig.resolvedContextTokens = agentConfig.numCtx;
      }
    } else {
      // Auto-sizing off: the window we send is exactly the configured num_ctx,
      // so that is the operative window for pressure evaluation.
      agentConfig.resolvedContextTokens = agentConfig.numCtx;
    }
  }

  // Create or get session
  let sessionId = params.sessionId;
  let existingMessages: Message[] = [];

  if (!sessionId) {
    const session = createSession({
      workspacePath: params.workspacePath,
      provider,
      model,
      threadType: params.threadType,
      specId: params.specId,
    });
    sessionId = session.id;
    logger.info('New session created', { sessionId, threadType: params.threadType, specId: params.specId });
    params.onEvent({ type: 'session_created', sessionId });
    
    // Log session creation to audit events
    logAuditEvent({
      sessionId,
      eventType: 'session_created',
      resultSummary: `Session created with ${provider}/${model} (${params.threadType})`,
    });
  } else {
    existingMessages = sanitizeHistory(getMessages(sessionId));
    logger.info('Resuming existing session', { sessionId, existingMessageCount: existingMessages.length });
  }

  let stopped = false;
  const abortController = new AbortController();
  activeSessions.set(sessionId, { stop: () => { stopped = true; abortController.abort(); } });

  updateSessionStatus(sessionId, 'running');
  
  // Log session start to audit events
  logAuditEvent({
    sessionId,
    eventType: 'session_running',
    resultSummary: 'Agent loop started',
  });

  try {
    const projectType = detectProjectType(params.workspacePath);
    
    // Get the session to check thread type and spec_id
    const session = getSession(sessionId);
    const threadType = session?.threadType || params.threadType;
    const specId = session?.specId || params.specId;
    
    const baseSystemPrompt = buildSystemPrompt(
      params.workspacePath, 
      projectType, 
      threadType,
      specId
    );

    // Inject any active Skills (Claude-style reusable capabilities) based on the
    // user's message — always-on skills, plus keyword-matched ones.
    let systemPrompt = baseSystemPrompt;
    try {
      const { buildSkillsPromptSection } = await import('./skills');
      const skillsSection = buildSkillsPromptSection(params.userMessage);
      if (skillsSection) systemPrompt = baseSystemPrompt + skillsSection;
    } catch (err) {
      logger.warn('Could not build skills section', { error: err instanceof Error ? err.message : String(err) });
    }

    // Connect any configured MCP servers so their tools are available to the
    // lead this run. Best-effort: a failed server never blocks the run.
    let mcpToolDefs: import('../mcp/manager').AgentToolDef[] = [];
    try {
      const { mcpManager } = await import('../mcp/manager');
      await mcpManager.ensureConnected();
      mcpToolDefs = mcpManager.getToolDefinitions();
      if (mcpToolDefs.length > 0) {
        logger.info('MCP tools available to agent', { count: mcpToolDefs.length });
        params.onEvent({ type: 'status', content: `Connected ${mcpToolDefs.length} MCP tool(s).` });
      }
    } catch (err) {
      logger.warn('MCP connection step failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // Build the compressed repo map up front so even small models get a
    // structural overview of the codebase without burning tool calls. This is
    // the core of "context narrowing" from dream.md — the model sees the whole
    // project's shape in a few hundred tokens.
    let repoMapContext = '';
    try {
      const idx = getIndex(params.workspacePath);
      if (idx.fileCount > 0) {
        const repoMap = buildRepoMap(params.workspacePath, {
          focus: params.userMessage,
          tokenBudget: 1600,
        });
        repoMapContext = `\n\n---\n# Codebase Overview (auto-generated structural map)\nThis is a compressed map of the most important files and their key symbols. Use it to orient yourself. Call get_repo_map, find_symbol, find_references, or get_file_outline for more detail.\n\n${repoMap}\n---\n`;
        logger.info('Injected repo map context', { fileCount: idx.fileCount, mapChars: repoMap.length });
      }
    } catch (err) {
      logger.warn('Could not build repo map', { error: err instanceof Error ? err.message : String(err) });
    }

    // The StatusBar's "Agent running" pill is the single global busy indicator.
    // We deliberately do NOT also push a "Thinking..." status bubble here — that
    // produced a duplicate "working" tag in the UI.

    // Build conversation history
    let userMessage = params.userMessage;
    
    // For spec sessions, give the model lightweight awareness of the spec on
    // the first message — informational only, NOT a forced pipeline.
    if (threadType === 'spec_session' && specId && existingMessages.length === 0) {
      const spec = readSpec(params.workspacePath, specId);
      if (spec) {
        const completedTasks = spec.tasks.filter(t => t.status === 'done');
        const inProgressTasks = spec.tasks.filter(t => t.status === 'in_progress');
        const todoTasks = spec.tasks.filter(t => t.status === 'todo');
        const allDone = spec.tasks.length > 0 && todoTasks.length === 0 && inProgressTasks.length === 0;
        const phase = spec.phase ?? 'ready';

        let phaseGuidance = '';
        if (phase === 'requirements') {
          phaseGuidance = 'This spec is still in the REQUIREMENTS phase. Present/refine requirements and get approval (approve_spec_phase "requirements") before authoring the design. Do not write tasks or code yet.';
        } else if (phase === 'design') {
          phaseGuidance = 'Requirements are approved. This spec is in the DESIGN phase. Read requirements, author/refine the design (set_spec_design), and get approval before creating tasks.';
        } else if (phase === 'tasks') {
          phaseGuidance = 'Requirements and design are approved. This spec is in the TASKS phase. Read both documents, break the work into concrete tasks (and sub-tasks), and get approval before executing.';
        } else if (allDone) {
          phaseGuidance = "All tasks are complete. Respond normally — you may extend the spec, start new work, or just answer.";
        } else {
          phaseGuidance = todoTasks.length > 0
            ? 'The spec is approved and ready. Continue executing tasks in dependency order, verifying each before the next.'
            : 'Continue as appropriate.';
        }

        const specContext = `
## Spec context (for your awareness)

Spec: ${spec.title} (${spec.type}) — status: ${spec.status} · phase: ${phase}
Progress: ${completedTasks.length}/${spec.tasks.length} tasks completed
${todoTasks.length > 0 ? `Remaining tasks: ${todoTasks.map(t => t.title).join(', ')}` : ''}
${phaseGuidance}

---

User message: `;

        userMessage = specContext + userMessage;
        logger.info('Injected spec awareness into first message', {
          specId,
          phase,
          totalTasks: spec.tasks.length,
          completed: completedTasks.length,
          allDone,
        });
      }
    }
    
    // For new spec sessions without a spec, inject staged-workflow guidance.
    if (threadType === 'spec_session' && !specId && existingMessages.length === 0) {
      const specCreationContext = `
## Spec Session — start the staged spec workflow

Build the spec WITH the user, one document at a time. Do not write code yet.

1. Briefly explore the workspace if helpful (gather_context / get_repo_map / read_file).
2. Use ask_user to ask whether to start REQUIREMENTS-FIRST (default) or DESIGN-FIRST — unless the user already made their preference clear.
3. Regardless of order, call create_spec(staged: true, startPhase: "requirements" | "design") EXACTLY ONCE to create the spec and get its spec_id — this always happens first, even for design-first. Call it ONLY once per session; never call it again for this spec later in the conversation, even if you're about to write the design.
4. Then author the first document: for requirements-first, requirements were just saved by create_spec — present them. For design-first, now write the design in your reply (the app saves it to design.md automatically using the spec_id from step 3 — do not call set_spec_design until the spec exists). Present it and wait for approval before moving on.

---

User request: `;
      
      userMessage = specCreationContext + userMessage;
      logger.info('Injected staged spec creation context for new spec session', { sessionId });
    }
    
    // Prepend the repo map to the first message of a fresh session so the model
    // starts grounded in the codebase structure.
    if (repoMapContext && existingMessages.length === 0) {
      userMessage = userMessage + repoMapContext;
    }

    const messages: Message[] = [
      ...existingMessages,
      { role: 'user', content: userMessage },
    ];

    // --- Model-downgrade migration (on resume) ----------------------------
    // If this thread's history was built by a large-context model and a smaller
    // model is now active, the history may not fit. If so, summarize + migrate
    // to a fresh thread so the small model starts clean. If it fits, continue.
    if (autoContextMigration && existingMessages.length > 0) {
      const downgrade = detectModelDowngrade({ config: agentConfig, systemPrompt, messages });
      if (downgrade.migrate) {
        logger.info('Model downgrade detected — migrating thread', {
          sessionId, model, ratio: downgrade.ratio,
        });
        params.onEvent({ type: 'status', content: 'This model has a smaller context window than the thread was built with — summarizing and continuing in a fresh thread…' });
        try {
          const specForContext = specId ? readSpec(params.workspacePath, specId) : null;
          const extraContext = specForContext
            ? `Spec "${specForContext.title}" — ${specForContext.tasks.filter(t => t.status === 'done').length}/${specForContext.tasks.length} tasks done.`
            : undefined;
          const migration = await migrateToFreshThread({
            config: agentConfig,
            parentSessionId: sessionId,
            workspacePath: params.workspacePath,
            threadType,
            specId,
            messages,
            reason: 'model_downgrade',
            extraContext,
            signal: abortController.signal,
          });
          const oldSessionId = sessionId;
          updateSessionStatus(oldSessionId, 'idle');
          activeSessions.delete(oldSessionId);
          sessionId = migration.newSessionId;
          activeSessions.set(sessionId, { stop: () => { stopped = true; abortController.abort(); } });
          updateSessionStatus(sessionId, 'running');
          // Replace the working history with the seed + the user's new message.
          messages.length = 0;
          messages.push(...migration.seedMessages, { role: 'user', content: params.userMessage });
          saveMessage(sessionId, 'user', params.userMessage);
          updateFirstMessage(sessionId, params.userMessage);
          params.onEvent({ type: 'session_created', sessionId });
          params.onEvent({ type: 'context_migrated', fromSessionId: oldSessionId, toSessionId: sessionId, reason: 'model_downgrade', summary: migration.summary });
          logAuditEvent({ sessionId, eventType: 'context_migrated', resultSummary: `Downgrade migration from ${oldSessionId}` });
        } catch (e) {
          logger.error('Model-downgrade migration failed; continuing in place', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // Persist ONLY the user's original message — not the injected repo map /
    // spec context — so reopening the thread shows a clean user bubble.
    saveMessage(sessionId, 'user', params.userMessage);

    // Snapshot the workspace BEFORE acting on this prompt so the user can roll
    // back everything this prompt (and later ones) changed. Best-effort; never
    // blocks the run. Skipped when there's no workspace.
    if (params.workspacePath) {
      try {
        const { createPromptCheckpoint } = await import('./promptCheckpoints');
        const cp = createPromptCheckpoint(params.workspacePath, sessionId, params.userMessage);
        if (cp) {
          params.onEvent({ type: 'prompt_checkpoint', id: cp.id, prompt: cp.prompt, createdAt: cp.createdAt } as any);
        }
      } catch { /* non-critical */ }
    }
    
    // Update first message preview if this is the first user message
    if (existingMessages.length === 0) {
      updateFirstMessage(sessionId, params.userMessage); // Use original message for preview
      logger.debug('First message preview updated', { sessionId });
    }

    // Spec sessions need more iterations for long-running autonomous work
    const MAX_ITERATIONS = threadType === 'spec_session' ? 10000 : 5000;
    let iteration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const allDiffs: FileDiff[] = [];
    // Track files touched since the last task completion (for the verifier)
    const filesTouchedThisTask = new Set<string>();
    let consecutiveEmptyResponses = 0;

    // ---- Multi-agent spec dispatch ----------------------------------------
    // In Spec Session mode, once a spec exists the orchestrator OWNS the plan:
    // it dispatches a focused Task Agent per task with progress tracking, rather
    // than letting the model free-form chat. If we're resuming a session that
    // already has a spec with pending tasks, dispatch immediately.
    const dispatchSpec = async (sid: string): Promise<boolean> => {
      const spec = readSpec(params.workspacePath, sid);
      if (!spec || spec.tasks.length === 0) return false;
      // Respect the staged workflow: only auto-dispatch once the spec is fully
      // authored and approved (phase 'ready'). A staged spec still in
      // requirements/design/tasks authoring must NOT be executed yet. Legacy
      // specs have no phase and are treated as ready.
      if (spec.phase && spec.phase !== 'ready') return false;
      const hasPending = spec.tasks.some((t) => t.status !== 'done');
      if (!hasPending) return false;

      params.onEvent({ type: 'status', content: `Dispatching task agents for "${spec.title}"…` });
      const runResult = await runSpecToCompletion({
        config: agentConfig,
        workspacePath: params.workspacePath,
        specId: sid,
        requireApprovalForWrites,
        requireApprovalForShell,
        onEvent: params.onEvent,
        requestApproval: (toolName, args, preview) =>
          requestApprovalShared({ sessionId: sessionId!, toolName, args, preview, onEvent: params.onEvent }),
        isStopped: () => stopped,
        logAudit: (e) => logAuditEvent({ sessionId: sessionId!, ...e }),
      });
      logger.info('Spec dispatch finished', { specId: sid, ...runResult });
      return true;
    };

    if (threadType === 'spec_session' && specId && existingMessages.length === 0 && multiAgentSpec) {
      // Only auto-dispatch on the very first message of a brand-new spec session
      // when multi-agent mode is explicitly enabled. Never hijack follow-up
      // messages — the agent must always be able to respond to the user freely.
      const dispatched = await dispatchSpec(specId);
      if (dispatched) {
        updateSessionStatus(sessionId, 'idle');
        logAuditEvent({ sessionId, eventType: 'session_complete', tokensUsed: 0 });
        activeSessions.delete(sessionId);
        params.onEvent({ type: 'done', sessionId });
        return;
      }
    }

    // --- Context budget, tied to the ACTIVE model's real window -------------
    // The migration check compares the prompt against the model's operative
    // window. Compaction must therefore target a budget BELOW the migration
    // line, otherwise (esp. on Ollama, where the window can be smaller than the
    // configured contextTokenBudget) compaction can never satisfy the check and
    // migration fires on every single iteration. We derive an effective
    // compaction budget from the window so compaction is the first line of
    // defence and migration is a genuine last resort.
    const operativeLimit = getContextLimit({
      provider: agentConfig.provider,
      model: agentConfig.model,
      numCtx: agentConfig.numCtx,
      autoNumCtxCeiling: agentConfig.autoNumCtxCeiling,
      resolvedContextTokens: agentConfig.resolvedContextTokens,
    });
    const usableWindow = usableInputTokens(operativeLimit);
    const systemPromptTokens = estimateTextTokens(systemPrompt);
    const migrationLineTokens = usableWindow * contextMigrationThreshold;
    // Keep compacted history comfortably under the migration line: leave room
    // for the system prompt plus a safety margin for the next model reply.
    const effectiveCompactionBudget = Math.max(
      Math.min(contextTokenBudget, Math.floor(migrationLineTokens - systemPromptTokens - 1500)),
      4000,
    );
    // Guard against back-to-back migrations: a freshly-seeded thread holds only
    // the handoff brief, so re-migrating it immediately is pointless and causes
    // the "summarizing…" message to fire repeatedly. Require both real history
    // and a cooldown since the last migration.
    let lastMigrationIteration = Number.NEGATIVE_INFINITY;
    const MIGRATION_COOLDOWN_ITERS = 3;
    const MIGRATION_MIN_MESSAGES = 6;

    while (iteration < MAX_ITERATIONS && !stopped) {
      iteration++;

      logger.debug('Agent iteration starting', { iteration, messageCount: messages.length });

      // Report context usage every iteration so the composer's gauge tracks the
      // conversation as it grows. This is measured against the model's REAL
      // operative window (resolved per model), not a fixed guess, so switching
      // to a bigger model visibly gives the user more room.
      try {
        params.onEvent({
          type: 'context_usage',
          usedTokens: systemPromptTokens + estimateTotalTokens(messages),
          usableTokens: usableWindow,
          windowTokens: operativeLimit.maxTokens,
          model: agentConfig.model,
          source: operativeLimit.source,
        });
      } catch { /* telemetry must never break the run */ }

      // Keep the context window bounded so long runs never break. No-op until
      // history grows large; preserves the goal + recent turns + tool pairing.
      // Budget is tied to the active model's window (see effectiveCompactionBudget).
      if (messages.length > 24) {
        const compaction = compactHistory(messages, { maxTokens: effectiveCompactionBudget, keepRecent: 18 });
        if (compaction.compacted) {
          messages.length = 0;
          messages.push(...compaction.messages);
          logger.info('Context compacted', {
            tokensBefore: compaction.tokensBefore,
            tokensAfter: compaction.tokensAfter,
            dropped: compaction.droppedCount,
            budget: effectiveCompactionBudget,
          });
          params.onEvent({ type: 'context_compacted', tokensBefore: compaction.tokensBefore, tokensAfter: compaction.tokensAfter });
        }
      }

      // --- Intelligent context migration -----------------------------------
      // Compaction keeps history small relative to the model's budget, but if
      // even the compacted prompt (goal + verbatim recent turns) approaches the
      // model's operative limit, summarize and CONTINUE IN A FRESH THREAD so the
      // loop never hits a hard overflow. Guarded so it can't fire repeatedly.
      const migrationAllowed =
        autoContextMigration &&
        messages.length > MIGRATION_MIN_MESSAGES &&
        iteration - lastMigrationIteration > MIGRATION_COOLDOWN_ITERS;
      if (migrationAllowed) {
        const decision = shouldMigrateForPressure({
          config: agentConfig,
          systemPrompt,
          messages,
          threshold: contextMigrationThreshold,
        });
        if (decision.migrate) {
          lastMigrationIteration = iteration;
          logger.info('Context pressure threshold crossed — migrating thread', {
            sessionId, ratio: decision.ratio, model,
          });
          params.onEvent({ type: 'status', content: 'Approaching the context limit — summarizing and continuing in a fresh thread so nothing is lost…' });
          try {
            const specForContext = specId ? readSpec(params.workspacePath, specId) : null;
            const extraContext = specForContext
              ? `Spec "${specForContext.title}" — ${specForContext.tasks.filter(t => t.status === 'done').length}/${specForContext.tasks.length} tasks done. Remaining: ${specForContext.tasks.filter(t => t.status !== 'done').map(t => t.title).join('; ') || 'none'}.`
              : undefined;
            const migration = await migrateToFreshThread({
              config: agentConfig,
              parentSessionId: sessionId,
              workspacePath: params.workspacePath,
              threadType,
              specId,
              messages,
              reason: 'context_limit',
              extraContext,
              signal: abortController.signal,
            });
            const oldSessionId = sessionId;
            updateSessionStatus(oldSessionId, 'idle');
            logAuditEvent({ sessionId: oldSessionId, eventType: 'context_migrated', resultSummary: `Migrated to ${migration.newSessionId} (context limit)` });
            activeSessions.delete(oldSessionId);
            // Switch the active session to the new thread.
            sessionId = migration.newSessionId;
            activeSessions.set(sessionId, { stop: () => { stopped = true; abortController.abort(); } });
            updateSessionStatus(sessionId, 'running');
            updateFirstMessage(sessionId, params.userMessage);
            // Reset working history to the seed brief.
            messages.length = 0;
            messages.push(...migration.seedMessages);
            params.onEvent({ type: 'session_created', sessionId });
            params.onEvent({ type: 'context_migrated', fromSessionId: oldSessionId, toSessionId: sessionId, reason: 'context_limit', summary: migration.summary });
          } catch (e) {
            logger.error('Context-pressure migration failed; continuing in place', { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      let assistantText = '';
      /** Last progress emit per tool id, for throttling. */
      const toolProgressAt = new Map<string, number>();

      // Create Stream Buffer instance for this iteration
      const streamBuffer = new StreamBuffer(
        {
          minTokens: 5,      // Reduced from 10 for faster flushing
          minChars: 100,     // Reduced from 500 for faster flushing
          flushIntervalMs: 50, // Reduced from 100 for more frequent flushing
        },
        (text) => {
          assistantText += text;
          params.onEvent({ type: 'text_delta', content: text });
        },
        logger
      );

      // Thinking gets the SAME batching treatment as prose. Emitting a WS event
      // per reasoning token is what made thinking judder while the answer below
      // it streamed smoothly: reasoning models emit thinking in fast, bursty
      // runs, and each raw token cost a socket frame plus a React re-render.
      // Slightly larger batches than prose — thinking is skimmed, not read word
      // by word, so smoothness matters more than per-token immediacy.
      const thinkingBuffer = new StreamBuffer(
        { minTokens: 8, minChars: 160, flushIntervalMs: 60 },
        (text) => { params.onEvent({ type: 'thinking', content: text }); },
        logger
      );

      let response: ModelResponse;
      let modelRetryCount = 0;
      let rateLimited = false;
      const MAX_MODEL_RETRIES = 3;
      
      while (modelRetryCount <= MAX_MODEL_RETRIES) {
        try {
          response = await callModel({
            config: agentConfig,
            systemPrompt,
            messages,
            tools: [...leadToolsForThread(threadType), ...mcpToolDefs],
            enableThinking,
            ollamaRetryConfig,
            signal: abortController.signal,
            onRateLimitWait: (waitMs, reason) => {
              params.onEvent({ type: 'status', content: reason });
              logger.info('Waiting out model rate limit', { waitMs, iteration });
            },
            onToken: (text) => {
              streamBuffer.push(text);
            },
            onToolStart: ({ id, name }) => {
              // Flush any streamed prose into its own bubble first, then show
              // the tool as "starting" the instant it begins — so a large file
              // write reads as "Creating file… (working)" immediately instead
              // of a frozen UI until the whole call has streamed in.
              // Drain reasoning first: a tool starting means thinking is over,
              // and a stranded partial sentence would land after the tool line.
              thinkingBuffer.finalize();
              streamBuffer.finalize();
              params.onEvent({ type: 'tool_started', id, tool: name });
            },
            onThinking: (text) => {
              thinkingBuffer.push(text);
            },
            onToolProgress: ({ id, name, partialJson }) => {
              // Throttled: partial_json fires per token, and a 700-line file is
              // tens of thousands of them. One frame every 120ms is smooth to
              // the eye and cheap on the socket.
              const now = Date.now();
              const last = toolProgressAt.get(id) ?? 0;
              if (now - last < 120) return;
              toolProgressAt.set(id, now);
              const p = describeToolProgress(partialJson);
              params.onEvent({ type: 'tool_progress', id, tool: name, path: p.path, bytes: p.bytes, lines: p.lines });
            },
            onOllamaRetry: (attempt, maxAttempts, delayMs, error) => {
              params.onEvent({
                type: 'ollama_retry',
                attempt,
                maxAttempts,
                delayMs,
                error,
              });
            },
          });
          
          // Finalize both buffers so nothing is stranded at end of stream.
          thinkingBuffer.finalize();
          streamBuffer.finalize();
          
          logger.info('Model response received', { 
            textLength: response.textContent.length, 
            toolCallCount: response.toolCalls.length,
            stopReason: response.stopReason,
            retryCount: modelRetryCount
          });
          
          // Success - break out of retry loop
          break;
        } catch (modelError) {
          // Drain both buffers on EVERY failure path. Without this a pending
          // flush timer can fire after the run has ended (or after the user hit
          // Stop) and append a stray fragment to a finished message.
          thinkingBuffer.finalize();
          streamBuffer.finalize();

          // User pressed Stop — abort cleanly, don't retry or error.
          const isAbort = modelError instanceof Error &&
            (modelError.name === 'AbortError' || /aborted/i.test(modelError.message));
          if (stopped || isAbort) {
            logger.info('Model call aborted by user', { sessionId, iteration });
            break;
          }

          // RATE LIMIT (429): the provider client already waited out the
          // server's retry hint and it STILL failed, which means the limit is
          // longer than our budget (e.g. Gemini free-tier daily quota). Firing
          // more requests here only burns the remaining quota and produces the
          // exact retry-storm seen in the logs. Surface a clean, actionable
          // error and stop this run instead of "continuing".
          const isRateLimit = !!(modelError as any)?.isRateLimit ||
            (modelError as any)?.httpStatus === 429 ||
            (modelError instanceof Error && /\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(modelError.message));
          if (isRateLimit) {
            const waitMatch = modelError instanceof Error ? /retry in (\d+(?:\.\d+)?)s/i.exec(modelError.message) : null;
            const waitHint = waitMatch ? ` Try again in about ${Math.ceil(parseFloat(waitMatch[1]))}s.` : '';
            logger.warn('Model rate limit hit — stopping run to preserve quota', { iteration, provider });
            params.onEvent({
              type: 'error',
              message:
                `${provider === 'gemini' ? 'Gemini' : 'The model'} API rate limit reached.${waitHint} ` +
                `The free tier allows only a few requests per minute/day, and an agent run makes many calls. ` +
                `Wait a bit and retry, switch to a less limited model, or add billing to raise the limit.`,
              recoverable: true,
              suggestions: [
                'Wait for the rate-limit window to reset, then retry',
                provider === 'gemini' ? 'Switch to a higher-quota Gemini model or enable billing at aistudio.google.com' : 'Switch providers in Settings',
                'Use Ollama (local) to avoid API rate limits entirely',
              ],
            });
            rateLimited = true;
            break;
          }

          modelRetryCount++;

          logger.error('Model API call failed', {
            iteration,
            attempt: modelRetryCount,
            maxRetries: MAX_MODEL_RETRIES,
            error: modelError instanceof Error ? modelError.message : String(modelError),
            stack: modelError instanceof Error ? modelError.stack : undefined
          });
          
          const errorMsg = modelError instanceof Error ? modelError.message : String(modelError);
          
          // If we've exhausted retries, handle the error
          if (modelRetryCount > MAX_MODEL_RETRIES) {
            // If it's the first iteration, this is likely a configuration issue
            if (iteration === 1) {
              sendErrorEvent(
                params.onEvent,
                modelError,
                { sessionId, iteration, retries: MAX_MODEL_RETRIES }
              );
              throw modelError;
            }
            
            // For later iterations, log and try to continue with the conversation
            logger.warn('Model API failed after all retries, attempting to continue', { iteration });
            params.onEvent({ 
              type: 'status', 
              content: `Model API error after ${MAX_MODEL_RETRIES} retries on step ${iteration}. Attempting to continue...` 
            });
            
            // Add a user message to help recover
            messages.push({
              role: 'user',
              content: 'The previous request failed. Please try a different approach or simplify the task.'
            });
            
            // Skip to next iteration
            continue;
          }
          
          // We still have retries left
          const retryDelayMs = 1000 * Math.pow(2, modelRetryCount - 1); // Exponential backoff: 1s, 2s, 4s
          
          logger.info('Retrying model API call', { 
            iteration,
            attempt: modelRetryCount,
            maxRetries: MAX_MODEL_RETRIES,
            delayMs: retryDelayMs
          });
          
          params.onEvent({ 
            type: 'status', 
            content: `Model error (attempt ${modelRetryCount}/${MAX_MODEL_RETRIES}). Retrying in ${retryDelayMs}ms...` 
          });
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
      
      // Rate limited: end the run cleanly. We've already emitted an error event
      // with guidance; continuing would just fire more quota-burning requests.
      if (rateLimited) {
        updateSessionStatus(sessionId, 'idle');
        activeSessions.delete(sessionId);
        params.onEvent({ type: 'done', sessionId });
        return;
      }

      // If we don't have a response after retries, skip this iteration
      if (!response!) {
        continue;
      }

      logger.debug('Model response received', { 
        textLength: response.textContent.length,
        toolCallCount: response.toolCalls.length,
        stopReason: response.stopReason
      });

      // Check for empty response - but allow it if there are tool calls
      if (!response.textContent && response.toolCalls.length === 0) {
        consecutiveEmptyResponses++;
        logger.warn('Empty model response', { 
          consecutiveCount: consecutiveEmptyResponses,
          maxAllowed: 5 
        });
        
        // A truly empty response (no text, no tool calls) is usually a transient
        // model glitch (a dropped stream, a stop-token hiccup). Recover instead
        // of ending the session: re-send the context, and after a couple of
        // silent retries add a gentle nudge. Only give up after 5 in a row.
        if (consecutiveEmptyResponses >= 5) {
          logger.info('Model returned empty responses repeatedly - ending turn', { sessionId, iteration });
          params.onEvent({ type: 'status', content: 'The model kept returning empty responses. Ending the turn — send another message to continue.' });
          break;
        }

        // After the 2nd consecutive empty, add a neutral nudge so a stuck model
        // gets a concrete prompt to respond to (without dictating the answer).
        if (consecutiveEmptyResponses >= 2) {
          messages.push({
            role: 'user',
            content: 'Continue with the task. If it is already complete, briefly summarize what you did; otherwise take the next action.',
          });
        }

        // Backoff grows with consecutive empties to ride out transient issues.
        await new Promise(resolve => setTimeout(resolve, 500 * consecutiveEmptyResponses));
        continue;
      }
      
      // Reset counter on successful response
      consecutiveEmptyResponses = 0;

      if (response.usage) {
        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;
      }

      // Build the assistant content blocks for the message history
      const assistantContentBlocks: Message['content'] = [];
      if (response.thinking) {
        assistantContentBlocks.push({ type: 'thinking', thinking: response.thinking });
      }
      if (response.textContent) {
        assistantContentBlocks.push({ type: 'text', text: response.textContent });
      }
      for (const tc of response.toolCalls) {
        assistantContentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantContentBlocks.length > 0 ? assistantContentBlocks : response.textContent,
      };
      messages.push(assistantMessage);

      // Persist the FULL turn (text + any tool_use blocks). Critical: a
      // tool-only turn must keep its tool_use, otherwise the next turn's
      // tool_result is orphaned and the whole history becomes invalid on
      // reload — which silently wipes the conversation's memory.
      saveTurn(sessionId, assistantMessage);

      // If no tool calls, check if we should continue (spec mode) or stop
      if (response.toolCalls.length === 0) {
        if (response.textContent) {
          params.onEvent({
            type: 'message',
            content: response.textContent,
            sessionId,
          });
        }
        
        // CRITICAL: Handle max_tokens cutoff - model was cut off mid-response, auto-continue
        if (response.stopReason === 'max_tokens' || response.stopReason === 'length') {
          logger.info('Response hit max_tokens limit - auto-continuing', { 
            sessionId, 
            iteration,
            stopReason: response.stopReason,
            textLength: response.textContent.length
          });
          
          params.onEvent({
            type: 'status',
            content: 'Response was long - continuing...'
          });
          
          // Add a continuation prompt
          messages.push({
            role: 'user',
            content: 'Continue from where you left off. Do not repeat what you already said.'
          });
          
          continue;
        }

        // The model produced a final answer with no tool calls — its turn is
        // genuinely over. We do NOT inject "continue" / "next task" prompts:
        // the agent works freely and decides for itself when it's done. Control
        // returns to the user. (Spec progress, if any, is already tracked via
        // the model's own update_task_status / update_plan calls.)
        break;
      }

      // Stream text if any (already streamed via onToken; emit a message too).
      if (response.textContent) {
        params.onEvent({ type: 'message', content: response.textContent, sessionId });
      }

      // If stop reason is max_tokens but we have tool calls, execute them and auto-continue after
      const hitMaxTokensWithTools = (response.stopReason === 'max_tokens' || response.stopReason === 'length') && response.toolCalls.length > 0;

      // Execute tool calls
      const toolResultBlocks: Message['content'] = [];

      for (const toolCall of response.toolCalls) {
        if (stopped) break;

        logger.debug('Executing tool', { tool: toolCall.name, id: toolCall.id });

        params.onEvent({
          type: 'tool_call',
          id: toolCall.id,
          tool: toolCall.name,
          args: toolCall.args,
        });

        logAuditEvent({
          sessionId,
          eventType: 'tool_call',
          tool: toolCall.name,
          args: toolCall.args,
        });

        // Check approval
        const approvalCheck = checkRequiresApproval(
          toolCall.name,
          toolCall.args,
          requireApprovalForWrites,
          requireApprovalForShell
        );

        // Handle auto-decline for invalid parameters
        if (approvalCheck.autoDecline) {
          logger.warn('Tool operation auto-declined due to invalid parameters', {
            tool: toolCall.name,
            reason: approvalCheck.reason,
            args: toolCall.args
          });

          // Send status message to frontend
          params.onEvent({
            type: 'status',
            content: `Operation auto-declined: ${approvalCheck.reason}`
          });

          // Send tool result indicating the operation was declined
          params.onEvent({
            type: 'tool_result',
            id: toolCall.id,
            tool: toolCall.name,
            result: `Operation declined: ${approvalCheck.reason}. Please provide valid parameters and try again.`,
          });

          // Add to tool result blocks so the agent knows what happened
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: `Operation was automatically declined due to invalid parameters: ${approvalCheck.reason}. Please check your parameters and try again with valid values.`,
          });

          logAuditEvent({
            sessionId,
            eventType: 'tool_auto_declined',
            tool: toolCall.name,
            args: toolCall.args,
            resultSummary: approvalCheck.reason,
          });

          continue;
        }

        let approved = !approvalCheck.required;

        if (approvalCheck.required) {
          const approvalId = uuidv4();
          
          // Send preparing event to show loading state
          params.onEvent({
            type: 'approval_preparing',
            tool: toolCall.name,
            args: toolCall.args,
          });
          
          logger.info('Approval required', { 
            approvalId, 
            tool: toolCall.name, 
            reason: approvalCheck.reason 
          });

          params.onEvent({
            type: 'approval_required',
            approvalId,
            tool: toolCall.name,
            args: toolCall.args,
            preview: approvalCheck.preview,
          });

          // Store in DB
          const db = (await import('../db/index')).getDb();
          db.prepare(
            `INSERT INTO approvals (id, session_id, tool, args, preview, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`
          ).run(
            approvalId,
            sessionId,
            toolCall.name,
            JSON.stringify(toolCall.args),
            approvalCheck.preview ?? null,
            new Date().toISOString()
          );

          // Wait for human decision (with 5-minute timeout).
          // An EXPIRY is not a rejection: for tools that can act on the user's
          // machine, the audit trail has to distinguish "a human looked at this
          // and said no" from "nobody was watching and it lapsed". Recording
          // both as `approval_rejected` misrepresents what actually happened.
          let timedOut = false;
          let approvalTimer: ReturnType<typeof setTimeout> | undefined;
          const approvalPromise = new Promise<boolean>((resolve) => {
            pendingApprovals.set(approvalId, { resolve });
            approvalTimer = setTimeout(() => {
              if (pendingApprovals.has(approvalId)) {
                pendingApprovals.delete(approvalId);
                timedOut = true;
                // Sync the UI so the card shows "expired" instead of pending.
                params.onEvent({ type: 'approval_timeout', approvalId });
                resolve(false);
              }
            }, 5 * 60 * 1000);
          });

          approved = await approvalPromise;
          // The user answered — drop the pending timer instead of leaving it to
          // fire (and hold the event loop) five minutes later.
          if (approvalTimer) clearTimeout(approvalTimer);

          logger.info('Approval decision received', { approvalId, approved, timedOut });

          // Log approval decision to audit events
          logAuditEvent({
            sessionId,
            eventType: approved ? 'approval_approved' : timedOut ? 'approval_timeout' : 'approval_rejected',
            tool: toolCall.name,
            args: toolCall.args,
            resultSummary: approved
              ? 'User approved action'
              : timedOut
              ? 'Expired — no response within 5 minutes'
              : 'User rejected action',
          });

          // Update approval status in DB
          db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(
            approved ? 'approved' : timedOut ? 'expired' : 'rejected',
            approvalId
          );

          if (!approved) {
            logger.info('Tool execution rejected by user', { tool: toolCall.name });
            params.onEvent({
              type: 'tool_result',
              id: toolCall.id,
              tool: toolCall.name,
              result: 'Action rejected by user.',
            });

            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: 'Action was rejected by the user.',
            });
            continue;
          }
        }

        // Intercept ask_user: pause the loop and wait for the user's answer.
        // This is the agent's escape hatch when genuinely blocked.
        if (toolCall.name === 'ask_user') {
          const question = String(toolCall.args.question ?? 'The agent has a question.');
          // Models sometimes return options as objects ({label}/{value}/{text})
          // rather than plain strings. Coerce every option to a string here so
          // the frontend never tries to render an object as a React child
          // (which throws and white-screens the whole app).
          const rawOptions = Array.isArray(toolCall.args.options) ? toolCall.args.options : undefined;
          const options = rawOptions
            ?.map((o) => {
              if (typeof o === 'string') return o;
              if (o && typeof o === 'object') {
                const r = o as Record<string, unknown>;
                const v = r.label ?? r.value ?? r.text ?? r.title ?? r.name;
                return typeof v === 'string' ? v : JSON.stringify(o);
              }
              return String(o);
            })
            .filter((s) => s.trim().length > 0);
          const questionId = uuidv4();

          params.onEvent({ type: 'question_asked', questionId, question, options });
          logAuditEvent({ sessionId, eventType: 'ask_user', resultSummary: question });

          const answer = await new Promise<string>((resolve) => {
            pendingQuestions.set(questionId, { resolve });
            // No hard timeout — the user may take their time. Stop cancels it.
            const check = setInterval(() => {
              if (stopped) { clearInterval(check); pendingQuestions.delete(questionId); resolve('[user stopped the session]'); }
            }, 500);
          });

          params.onEvent({ type: 'tool_result', id: toolCall.id, tool: toolCall.name, result: `User answered: ${answer}` });
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolCall.id, content: `The user answered: ${answer}` });
          continue;
        }

        // Intercept MCP tools: route to the owning server via the manager.
        if (toolCall.name.startsWith('mcp__')) {
          params.onEvent({ type: 'tool_call', id: toolCall.id, tool: toolCall.name, args: toolCall.args });
          try {
            const { mcpManager } = await import('../mcp/manager');
            const result = await mcpManager.callTool(toolCall.name, toolCall.args);
            params.onEvent({ type: 'tool_result', id: toolCall.id, tool: toolCall.name, result });
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolCall.id, content: result });
            logAuditEvent({ sessionId, eventType: 'mcp_tool', tool: toolCall.name, resultSummary: result.slice(0, 120) });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            params.onEvent({ type: 'tool_result', id: toolCall.id, tool: toolCall.name, result: `MCP tool failed: ${msg}` });
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolCall.id, content: `MCP tool failed: ${msg}` });
          }
          continue;
        }

        // Intercept delegate_task: run a focused worker sub-agent. The lead
        // delegates the actual implementation and gets back an ACK report,
        // acting as a tech lead rather than editing files itself.
        if (toolCall.name === 'delegate_task') {
          const instruction = String(toolCall.args.instruction ?? '').trim();
          if (!instruction) {
            params.onEvent({ type: 'tool_result', id: toolCall.id, tool: toolCall.name, result: 'delegate_task needs an instruction.' });
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolCall.id, content: 'delegate_task requires a non-empty "instruction".' });
            continue;
          }
          const targetFiles = Array.isArray(toolCall.args.target_files) ? (toolCall.args.target_files as string[]) : undefined;
          const acceptance = toolCall.args.acceptance ? String(toolCall.args.acceptance) : undefined;
          const delegationId = uuidv4();

          // Emit a dedicated delegation lifecycle so the UI can render a live
          // worker card (separate from generic tool bubbles) and report back.
          params.onEvent({ type: 'delegation_started', delegationId, instruction, targetFiles, acceptance });
          params.onEvent({ type: 'status', content: `Delegating to worker: ${instruction.slice(0, 80)}` });
          logAuditEvent({ sessionId, eventType: 'delegate_task', resultSummary: instruction.slice(0, 120) });

          const { runDelegatedAgent } = await import('./taskAgent');
          const delegation = await runDelegatedAgent({
            config: agentConfig,
            workspacePath: params.workspacePath,
            instruction,
            targetFiles,
            acceptance,
            requireApprovalForWrites,
            requireApprovalForShell,
            onEvent: (event) => {
              // A worker may maintain its OWN mini-plan via update_plan. Tag it
              // as owner:'worker' and DO NOT persist it as the session plan, so
              // it never clobbers the lead's (main) plan. The UI shows both.
              if (event.type === 'plan_updated') {
                params.onEvent({ ...event, owner: 'worker' } as any);
                return;
              }
              params.onEvent(event);
            },
            onProgress: (phase, detail) =>
              params.onEvent({ type: 'delegation_progress', delegationId, phase, detail }),
            requestApproval: (toolName, args, preview) =>
              requestApprovalShared({ sessionId: sessionId!, toolName, args, preview, onEvent: params.onEvent }),
            isStopped: () => stopped,
          });

          // Track worker-touched files for the verifier/diff accounting.
          for (const f of delegation.filesTouched) filesTouchedThisTask.add(f);
          // Persist the worker's ACTUAL diffs onto the thread so the Changes
          // panel is fully restorable on refresh (not just file names).
          if (delegation.diffs && delegation.diffs.length > 0) {
            allDiffs.push(...delegation.diffs);
            params.onEvent({ type: 'diff', files: delegation.diffs });
            try {
              recordSessionChanges(sessionId, delegation.diffs.map((d) => ({
                path: d.path, type: d.type, additions: d.additions, deletions: d.deletions, diff: d.diff,
                at: new Date().toISOString(),
              })));
            } catch { /* non-critical */ }
          }

          params.onEvent({
            type: 'delegation_completed',
            delegationId,
            report: delegation.report,
            filesTouched: delegation.filesTouched,
            validationOk: delegation.validationOk,
          });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: `Worker ACK: ${delegation.report}${delegation.validationOk ? '' : ' (validation reported issues — review before marking done)'}\nFiles changed: ${delegation.filesTouched.join(', ') || 'none'}`,
          });
          continue;
        }

        // Intercept delegate_parallel: run 2-4 INDEPENDENT workers at once, each
        // in its own lane. Guarded so the workers can only run concurrently when
        // they touch disjoint files (otherwise they'd corrupt each other).
        if (toolCall.name === 'delegate_parallel') {
          const rawTasks = Array.isArray(toolCall.args.tasks) ? toolCall.args.tasks : [];
          const assignments = (rawTasks as Array<Record<string, unknown>>).map((t) => ({
            instruction: String(t?.instruction ?? '').trim(),
            targetFiles: Array.isArray(t?.target_files) ? (t.target_files as string[]) : undefined,
            acceptance: t?.acceptance ? String(t.acceptance) : undefined,
          }));

          const { planParallelBatch, runParallelDelegation, MAX_PARALLEL_AGENTS } = await import('./parallelAgents');
          const plan = planParallelBatch(assignments, MAX_PARALLEL_AGENTS);
          if (!plan.ok) {
            const msg = `Cannot run these in parallel: ${plan.reason} You can still delegate them one at a time with delegate_task.`;
            params.onEvent({ type: 'tool_result', id: toolCall.id, tool: toolCall.name, result: msg });
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolCall.id, content: msg });
            continue;
          }

          params.onEvent({ type: 'status', content: `Running ${assignments.length} agents in parallel…` });
          logAuditEvent({ sessionId, eventType: 'delegate_parallel', resultSummary: `${assignments.length} parallel workers` });

          const results = await runParallelDelegation({
            config: agentConfig,
            workspacePath: params.workspacePath,
            assignments,
            requireApprovalForWrites,
            requireApprovalForShell,
            maxParallel: MAX_PARALLEL_AGENTS,
            onEvent: (event) => {
              // Keep a worker's own mini-plan from clobbering the lead plan.
              if (event.type === 'plan_updated') { params.onEvent({ ...event, owner: 'worker' } as any); return; }
              params.onEvent(event);
            },
            requestApproval: (toolName, args, preview) =>
              requestApprovalShared({ sessionId: sessionId!, toolName, args, preview, onEvent: params.onEvent }),
            isStopped: () => stopped,
          });

          // Aggregate every lane's files + diffs for verification/diff accounting.
          for (const r of results) {
            for (const f of r.filesTouched) filesTouchedThisTask.add(f);
            if (r.diffs && r.diffs.length > 0) {
              allDiffs.push(...r.diffs);
              params.onEvent({ type: 'diff', files: r.diffs });
              try {
                recordSessionChanges(sessionId, r.diffs.map((d) => ({
                  path: d.path, type: d.type, additions: d.additions, deletions: d.deletions, diff: d.diff,
                  at: new Date().toISOString(),
                })));
              } catch { /* non-critical */ }
            }
          }

          const anyFailed = results.some((r) => !r.validationOk);
          const summary = results
            .map((r, i) => `Worker ${i + 1}: ${r.report}${r.validationOk ? '' : ' (validation issues)'}`)
            .join('\n');
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: `All ${results.length} parallel workers finished.${anyFailed ? ' Some reported validation issues — review before marking done.' : ''}\n${summary}`,
          });
          continue;
        }

        // Execute the tool
        logger.debug('Executing approved tool', { tool: toolCall.name });
        
        let execResult;
        try {
          // Create a wrapper for onEvent that handles terminal + plan events
          const toolOnEvent = (event: { type: string; content: string }) => {
            // Parse terminal events and forward them properly
            if (event.type === 'terminal_start' || event.type === 'terminal_output' || event.type === 'terminal_end') {
              const data = JSON.parse(event.content);
              params.onEvent({
                type: event.type,
                ...data,
              } as any);
            } else if (event.type === 'diagnostics') {
              try { params.onEvent({ type: 'diagnostics', issues: JSON.parse(event.content) } as any); } catch { /* ignore */ }
            } else if (event.type === 'browser_screenshot') {
              params.onEvent({ type: 'browser_screenshot', file: event.content } as any);
            } else if (event.type === 'preview_url') {
              // A background process (e.g. `npm run dev`) just printed its URL —
              // push it straight to the client so the Bubbly Preview panel opens
              // itself instead of waiting for the user to notice and open it.
              params.onEvent({ type: 'preview_url', url: event.content } as any);
            } else if (event.type === 'plan_updated') {
              try {
                const data = JSON.parse(event.content);
                // Persist the plan so the collapsible plan strip survives a
                // refresh / reopen of the thread. This is the MAIN (lead) plan.
                try { saveSessionPlan(sessionId!, data.steps); } catch { /* non-critical */ }
                params.onEvent({ type: 'plan_updated', steps: data.steps, owner: 'main' } as any);
              } catch { /* ignore */ }
            } else {
              params.onEvent(event as any);
            }
          };
          
          execResult = await executeTool(
            toolCall.name,
            toolCall.args,
            params.workspacePath,
            toolOnEvent,
            abortController.signal
          );
          
          logger.info('Tool execution completed', { 
            tool: toolCall.name, 
            resultLength: execResult.result.length,
            hasDiff: !!execResult.diff 
          });
        } catch (toolError) {
          // Tool execution failed - log and report to agent
          const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
          
          logger.error('Tool execution failed', {
            tool: toolCall.name,
            args: toolCall.args,
            error: errorMsg,
            stack: toolError instanceof Error ? toolError.stack : undefined
          });
          
          // Send error notification to frontend
          params.onEvent({
            type: 'status',
            content: `Tool execution failed: ${toolCall.name} - ${errorMsg}`
          });
          
          // Create a detailed error message for the agent with suggestions
          let errorWithSuggestions = `Tool execution failed: ${errorMsg}`;
          
          // Add specific suggestions based on the tool and error
          if (toolCall.name === 'write_file' || toolCall.name === 'read_file') {
            errorWithSuggestions += '\n\nSuggestions:\n- Check if the file path is correct and relative to the workspace root\n- Verify you have permission to access this file\n- Ensure the directory exists before writing';
          } else if (toolCall.name === 'run_command') {
            errorWithSuggestions += '\n\nSuggestions:\n- Check if the command is available on this system\n- Verify the command syntax is correct\n- Try a simpler version of the command';
          } else if (toolCall.name.includes('git')) {
            errorWithSuggestions += '\n\nSuggestions:\n- Ensure this is a git repository\n- Check if you have uncommitted changes\n- Verify git is installed and configured';
          } else {
            errorWithSuggestions += '\n\nSuggestion: Try a different approach or break the task into smaller steps.';
          }
          
          // Send tool result with error details
          params.onEvent({
            type: 'tool_result',
            id: toolCall.id,
            tool: toolCall.name,
            result: errorWithSuggestions,
          });
          
          // Add to tool result blocks so the agent can try an alternative approach
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: errorWithSuggestions,
          });
          
          logAuditEvent({
            sessionId,
            eventType: 'tool_error',
            tool: toolCall.name,
            args: toolCall.args,
            resultSummary: errorMsg,
          });
          
          // Continue to next tool call instead of crashing
          continue;
        }

        // Handle spec creation in Spec Session threads
        if (toolCall.name === 'create_spec' && execResult.spec) {
          const session = getSession(sessionId);
          if (session && session.threadType === 'spec_session') {
            logger.info('Spec created in Spec Session thread', { 
              sessionId, 
              specId: execResult.spec.id 
            });
            
            // Lock the spec to this session
            lockSpecToSession(params.workspacePath, execResult.spec.id, sessionId);
            
            // Update the session with the spec_id
            updateSessionSpecId(sessionId, execResult.spec.id);
            
            // Notify frontend about spec creation
            params.onEvent({
              type: 'spec_created',
              spec: execResult.spec,
            });
            
            logger.info('Spec locked to session', { 
              sessionId, 
              specId: execResult.spec.id 
            });

            // HAND OFF to the multi-agent dispatcher: now that the spec exists
            // with tasks, the orchestrator owns execution. The chat loop stops
            // free-forming and task agents take over with progress tracking.
            if (multiAgentSpec && execResult.spec.tasks.length > 0) {
              const dispatched = await dispatchSpec(execResult.spec.id);
              if (dispatched) {
                updateSessionStatus(sessionId, 'idle');
                logAuditEvent({ sessionId, eventType: 'session_complete', tokensUsed: totalInputTokens + totalOutputTokens });
                activeSessions.delete(sessionId);
                params.onEvent({ type: 'done', sessionId });
                return;
              }
            }
          }
        }
        
        // Handle spec updates (task status changes)
        if (toolCall.name === 'update_spec_status' && execResult.spec) {
          params.onEvent({
            type: 'spec_updated',
            spec: execResult.spec,
          });
        }
        
        // Handle task status updates and check for spec completion
        if (toolCall.name === 'update_task_status' && execResult.spec) {
          params.onEvent({
            type: 'spec_updated',
            spec: execResult.spec,
          });
          
          // VERIFIER AGENT: when a task is marked done, verify it was actually completed
          if (toolCall.args.status === 'done' && filesTouchedThisTask.size > 0) {
            const taskId = String(toolCall.args.task_id ?? '');
            const verifiedTask = execResult.spec.tasks.find(t => t.id === taskId)
              || execResult.spec.tasks.find(t => taskId.includes(t.id) || t.id.includes(taskId));
            
            if (verifiedTask) {
              params.onEvent({
                type: 'status',
                content: `Verifying task: ${verifiedTask.title}...`
              });

              // STEP 1 — deterministic validation (cheap, grounded). Catches
              // syntax/type errors before spending a model call on judgment.
              const touched = Array.from(filesTouchedThisTask);
              const validation = autoValidate
                ? await runValidation({
                    workspacePath: params.workspacePath,
                    changedFiles: touched,
                    timeoutMs: 30000,
                  })
                : { ok: true, issues: [], checkedWith: [], summary: 'validation disabled' };

              // Surface these issues in the Problems panel.
              params.onEvent({ type: 'diagnostics', issues: validation.issues } as any);

              if (!validation.ok) {
                logger.warn('Deterministic validation failed - reverting task', {
                  taskId: verifiedTask.id,
                  issues: validation.issues.length,
                });
                updateTaskStatus(params.workspacePath, execResult.spec.id, verifiedTask.id, 'in_progress');
                const revertedSpec = readSpec(params.workspacePath, execResult.spec.id);
                if (revertedSpec) params.onEvent({ type: 'spec_updated', spec: revertedSpec });

                params.onEvent({ type: 'status', content: `Validation failed: ${validation.summary}` });
                params.onEvent({
                  type: 'tool_result',
                  id: toolCall.id,
                  tool: toolCall.name,
                  result: `Validation failed: ${validation.summary}`,
                });
                logAuditEvent({
                  sessionId,
                  eventType: 'task_validation',
                  resultSummary: `${verifiedTask.title}: FAIL (${validation.checkedWith.join(',')}) - ${validation.summary}`,
                });
                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content: `VALIDATION FAILED for task "${verifiedTask.title}".\n\n${formatIssuesForRepair(validation)}\n\nThe task is NOT done. Fix these specific errors with edit_file, call validate_changes to confirm, then mark the task done again. Do NOT move on until validation passes.`,
                });
                continue;
              }

              // STEP 2 — semantic verification (LLM judges completeness vs. the task).
              const verification = await verifyTaskCompletion({
                config: agentConfig,
                workspacePath: params.workspacePath,
                task: verifiedTask,
                specTitle: execResult.spec.title,
                filesTouched: Array.from(filesTouchedThisTask),
                readFileContent: async (p: string) => {
                  try {
                    const { readFile } = await import('./tools/filesystem');
                    return await readFile(params.workspacePath, p);
                  } catch {
                    return null;
                  }
                },
              });
              
              logAuditEvent({
                sessionId,
                eventType: 'task_verification',
                resultSummary: `${verifiedTask.title}: ${verification.verified ? 'PASS' : 'FAIL'} - ${verification.reason}`,
              });
              
              if (!verification.verified) {
                // Verification failed - revert task to in_progress and tell the agent to fix it
                logger.warn('Task verification failed - reverting to in_progress', {
                  taskId: verifiedTask.id,
                  reason: verification.reason,
                });
                
                updateTaskStatus(params.workspacePath, execResult.spec.id, verifiedTask.id, 'in_progress');
                const revertedSpec = readSpec(params.workspacePath, execResult.spec.id);
                if (revertedSpec) {
                  params.onEvent({ type: 'spec_updated', spec: revertedSpec });
                }
                
                params.onEvent({
                  type: 'status',
                  content: `Verification failed: ${verification.reason}`
                });
                
                // Emit tool_result for UI consistency
                params.onEvent({
                  type: 'tool_result',
                  id: toolCall.id,
                  tool: toolCall.name,
                  result: `Verification failed: ${verification.reason}`,
                });
                
                // Inject a repair message so the agent fixes the issue (dream.md repair loop)
                const suggestionsText = verification.suggestions.length > 0
                  ? `\n\nSuggested fixes:\n${verification.suggestions.map(s => `- ${s}`).join('\n')}`
                  : '';
                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content: `VERIFICATION FAILED for task "${verifiedTask.title}".\n\nReason: ${verification.reason}${suggestionsText}\n\nThe task is NOT done. Fix the issues above using edit_file or write_file, then mark the task done again. Do NOT move to the next task until this is fixed.`,
                });
                
                // Skip the rest of this tool's normal result handling
                continue;
              } else {
                params.onEvent({
                  type: 'status',
                  content: `Verified: ${verifiedTask.title}`
                });
                // Clear touched files for the next task
                filesTouchedThisTask.clear();
              }
            }
          }
          
          // Check if all tasks are now complete
          const allComplete = areAllTasksComplete(params.workspacePath, execResult.spec.id);
          
          if (allComplete && execResult.spec.status !== 'done') {
            logger.info('All tasks complete - marking spec as done', { 
              specId: execResult.spec.id,
              sessionId 
            });
            
            // Update spec status to done
            const updatedSpec = updateSpec(params.workspacePath, execResult.spec.id, { 
              status: 'done' 
            });
            
            if (updatedSpec) {
              params.onEvent({
                type: 'status',
                content: `All tasks complete! Spec "${updatedSpec.title}" is done.`
              });
              
              params.onEvent({
                type: 'spec_updated',
                spec: updatedSpec,
              });
              
              logAuditEvent({
                sessionId,
                eventType: 'spec_completed',
                resultSummary: `Spec "${updatedSpec.title}" completed - all ${updatedSpec.tasks.length} tasks done`,
              });
            }
          }
        }
        
        // Generic: any other spec-returning tool (get_next_task auto-completes tasks,
        // add_spec_task adds tasks) should also push a live update to the frontend
        if (
          execResult.spec &&
          toolCall.name !== 'create_spec' &&
          toolCall.name !== 'update_spec_status' &&
          toolCall.name !== 'update_task_status'
        ) {
          params.onEvent({
            type: 'spec_updated',
            spec: execResult.spec,
          });
        }

        params.onEvent({
          type: 'tool_result',
          id: toolCall.id,
          tool: toolCall.name,
          result: execResult.result,
          diff: execResult.diff,
        });

        if (execResult.diff) {
          allDiffs.push(...execResult.diff);
          // Track touched files for the verifier
          for (const d of execResult.diff) {
            filesTouchedThisTask.add(d.path);
          }
          // Persist the file changes onto the thread so each session records
          // exactly what it changed (recoverable on refresh).
          try {
            recordSessionChanges(sessionId, execResult.diff.map((d) => ({
              path: d.path,
              type: d.type,
              additions: d.additions,
              deletions: d.deletions,
              diff: d.diff,
              at: new Date().toISOString(),
            })));
          } catch { /* non-critical */ }
          // Keep the code-intelligence index fresh after writes/edits so
          // find_symbol / repo_map reflect the latest code.
          try {
            const { invalidateIndex } = await import('./intelligence/codeIntelligence');
            invalidateIndex(params.workspacePath);
          } catch { /* non-critical */ }
          params.onEvent({ type: 'diff', files: execResult.diff });
        }

        logAuditEvent({
          sessionId,
          eventType: 'tool_result',
          tool: toolCall.name,
          resultSummary: execResult.result.slice(0, 200),
        });

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: execResult.result,
          ...(execResult.images && execResult.images.length > 0 ? { images: execResult.images } : {}),
        });
      }

      if (toolResultBlocks.length > 0) {
        messages.push({ role: 'user', content: toolResultBlocks });
        
        // Save tool results to database for persistence (structured, ordered).
        saveTurn(sessionId, { role: 'user', content: toolResultBlocks });
        
        logger.debug('Tool results persisted', { 
          sessionId, 
          toolResultCount: toolResultBlocks.length 
        });
      }

      // If model was cut off mid-response with tool calls, add continuation prompt
      if (hitMaxTokensWithTools) {
        logger.info('Response hit max_tokens with tool calls - auto-continuing', { 
          sessionId, 
          iteration 
        });
        messages.push({
          role: 'user',
          content: 'Continue executing. You were cut off mid-response. Keep working on the task.'
        });
      }
    }

    if (stopped) {
      logger.info('Session stopped by user', { sessionId });
      params.onEvent({ type: 'status', content: 'Session stopped by user.' });
    }

    // Reconcile lingering task state so the UI never shows a stuck spinner.
    // When the agent's turn ends with a task still in_progress, we do NOT
    // assume it's done (that would be a false completion). We revert it to
    // 'todo' so it's clearly unfinished and resumable, and emit the update so
    // the spinner stops. The verifier/agent will complete it on the next turn.
    if (!stopped && specId) {
      try {
        const spec = readSpec(params.workspacePath, specId);
        if (spec) {
          const inProgress = spec.tasks.filter((t) => t.status === 'in_progress');
          if (inProgress.length > 0) {
            inProgress.forEach((t) => {
              updateTaskStatus(params.workspacePath, specId, t.id, 'todo');
            });
            const reconciled = readSpec(params.workspacePath, specId);
            if (reconciled) params.onEvent({ type: 'spec_updated', spec: reconciled });
            logger.info('Reconciled lingering in_progress tasks to todo at loop end', {
              sessionId, specId, count: inProgress.length,
            });
          }
        }
      } catch (e) {
        logger.warn('Task reconciliation at loop end failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }

    updateSessionStatus(sessionId, 'idle');
    logAuditEvent({
      sessionId,
      eventType: 'session_idle',
      resultSummary: 'Agent loop paused - waiting for user input',
    });
    logAuditEvent({
      sessionId,
      eventType: 'session_complete',
      tokensUsed: totalInputTokens + totalOutputTokens,
    });

    logger.info('Agent loop completed', { 
      sessionId, 
      iterations: iteration,
      totalTokens: totalInputTokens + totalOutputTokens,
      diffsGenerated: allDiffs.length 
    });

    params.onEvent({ type: 'done', sessionId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Agent loop error', { 
      sessionId, 
      error: msg,
      stack: err instanceof Error ? err.stack : undefined
    });
    
    // Send user-friendly error with suggestions
    sendErrorEvent(params.onEvent, err, { sessionId });
    
    updateSessionStatus(sessionId, 'error');
    logAuditEvent({ sessionId, eventType: 'error', resultSummary: msg });
  } finally {
    activeSessions.delete(sessionId);
    logger.debug('Session cleanup completed', { sessionId });
  }
}
