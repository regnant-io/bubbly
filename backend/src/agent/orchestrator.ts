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

/**
 * The spec ids touched by a set of file diffs.
 *
 * Specs have no creation tool any more — the agent just writes
 * `.bubbly/specs/<name>/requirements.md`. So "which spec did that touch" is a
 * question about paths, answered here, and it is how a session gets linked to
 * the spec it is authoring and how the Specs panel learns a checkbox moved.
 */
export function specIdsInDiff(diffs: Array<{ path: string }>): string[] {
  const ids = new Set<string>();
  for (const d of diffs) {
    const m = /(?:^|\/)\.bubbly\/specs\/([^/]+)\//.exec(d.path.replace(/\\/g, '/'));
    if (m && m[1] && !m[1].includes('..')) ids.add(m[1]);
  }
  return [...ids];
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
  'search',
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
  // Authoring a document for the user is a lead activity in every mode: it is
  // how a plan, a summary or a report gets delivered without being pasted into
  // the conversation.
  'artifact',
]);

const LEAD_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => LEAD_TOOL_NAMES.has(t.name));

/**
 * Turn the raw `plan_updated` a tool emits into the shape the client consumes.
 *
 * The tool layer emits `{ type, content }` where content is a JSON STRING; the
 * client reads `event.steps`. The lead's path translated between the two, but
 * the two worker paths spread the raw event straight through — so every worker
 * plan arrived with `steps: undefined` and was silently dropped. Nothing warned
 * about it because a missing plan just renders as no plan. One helper now, used
 * by all three call sites, so they cannot drift apart again.
 */
type PlanSteps = Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>;

function parsePlanEvent(event: unknown): PlanSteps | null {
  const e = (event ?? {}) as { steps?: unknown; content?: unknown };
  // Accept BOTH shapes. The worker paths hand this the raw tool event (cast
  // through `as any` on their way up, which is why the declared type here can't
  // be trusted), while a caller that has already translated passes `steps`.
  // Reading whichever is present means no site can be wrong about the other.
  if (Array.isArray(e.steps)) return e.steps.length > 0 ? (e.steps as PlanSteps) : null;
  try {
    const data = JSON.parse(String(e.content ?? ''));
    return Array.isArray(data?.steps) && data.steps.length > 0 ? (data.steps as PlanSteps) : null;
  } catch {
    return null;
  }
}

/**
 * Mutating "do the work directly" tools. The lead has these in BOTH modes so
 * small, well-scoped changes don't have to pay the cost of spinning up a worker
 * sub-agent (which burns extra tokens and time). Big jobs still go through
 * delegate_task.
 *
 * Spec mode used to withhold every one of these, which made a certain kind of
 * sense when a spec was authored through dedicated tools: the lead planned, the
 * workers built. But specs are now ordinary markdown files, and a lead that
 * cannot call write_file cannot write requirements.md. Rather than reintroduce
 * a special-cased writer, the spec lead is simply hands-on like the vibe lead —
 * it authors its own documents, and still delegates the big implementation work.
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
 * The lead's toolset for a given thread type.
 *
 * Both modes get the same tools now; what differs is the WORKING METHOD the
 * system prompt sets out, not the capability list. The one exception is
 * update_plan: in a spec session, tasks.md IS the plan, and a second parallel
 * plan widget would just be somewhere for the two to disagree.
 */
function leadToolsForThread(threadType?: ThreadType) {
  const have = new Set(LEAD_TOOL_DEFINITIONS.map((t) => t.name));
  const all = [...LEAD_TOOL_DEFINITIONS, ...DIRECT_WORK_TOOL_DEFINITIONS.filter((t) => !have.has(t.name))];
  if (threadType === 'spec_session') {
    return all.filter((t) => t.name !== 'update_plan');
  }
  return all;
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
import { readSpec } from './tools/specs';
import { buildRuntimeStateBlock, buildHandoffStateNote } from './runtimeState';
import { getAllSettings } from '../db/index';
import { StreamBuffer } from '../models/streamBuffer';
import { getIndex, buildRepoMap } from './intelligence/codeIntelligence';
import { runValidation, formatIssuesForRepair } from './intelligence/validator';
import { compactHistory, sanitizeHistory, estimateTotalTokens } from './contextManager';
import { getContextLimit, usableInputTokens, estimateTextTokens } from './contextLimits';
import { resolveNumCtx } from '../models/ollama';
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

/**
 * Runs currently in flight, keyed by session id. This is the ONLY record of
 * "is this thread busy", and it is what makes a run single-flight.
 *
 * It used to be a bare stop-handle map that nothing ever consulted before
 * starting work, which had a nasty consequence: two `chat` messages for the
 * same session — a double-tap on Send, a queued message replayed after a
 * reconnect, a second window on the same thread — started two complete agent
 * loops over one conversation. Both appended to the same history, both streamed
 * into the same socket and both executed their tool calls, so the user saw the
 * generation branch and every tool fire twice. And because the second loop
 * overwrote the first's stop handle here, Stop only ever cancelled the newer
 * one; the older kept running (and kept writing files) with nothing left in the
 * UI able to reach it.
 */
interface ActiveRun {
  stop: () => void;
  startedAt: number;
}
const activeSessions = new Map<string, ActiveRun>();

/** Is a run already in flight for this thread? */
export function isSessionRunning(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function stopSession(sessionId: string): void {
  // Stop means stop, including the things that would restart it. A detached
  // watcher's whole job is to wake this thread back up; leaving one armed after
  // the user pressed Stop means the agent springs back to life minutes later
  // with no prompt from anyone. Cancel them first, whether or not a run is
  // currently in flight — a thread can be idle and still have watchers armed.
  try {
    const { watchers } = require('./tools/watchers') as typeof import('./tools/watchers');
    watchers.cancelForSession(sessionId);
  } catch { /* watcher teardown must never block a stop */ }

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

### A spec is THREE MARKDOWN FILES. There are no spec tools.

Every spec lives in the project at \`.bubbly/specs/<spec-name>/\`, as exactly three files:

    .bubbly/specs/<spec-name>/requirements.md
    .bubbly/specs/<spec-name>/design.md
    .bubbly/specs/<spec-name>/tasks.md

\`<spec-name>\` is a short kebab-case slug you choose from the title (e.g. "offline-sync", "fix-login-race"). You create, read and edit these with the ORDINARY filesystem tools — \`write_file\`, \`read_file\`, \`edit_file\`, \`list_directory\`. Nothing else. There is no create_spec, no add_spec_task, no update_task_status, no get_next_task, no approve_spec_phase. Do not look for them and do not describe them to the user; they were removed because a tool round-trip is a worse way to edit a checkbox than editing the checkbox.

### Task state lives in tasks.md, as a checkbox

Each task is one top-level markdown checkbox with a stable bold id:

    - [ ] **T1** Add the sync queue module
      - Files: src/sync/queue.ts, src/sync/queue.test.ts
      - Depends on: (none)
      - Requirements: R-2, R-5
      - Done when: queued writes survive a reload and flush in order once online
      - Verify with: npm test src/sync/queue.test.ts

Three markers, and only these three:
- \`- [ ]\` — not started
- \`- [~]\` — in progress (you are working on it right now)
- \`- [x]\` — done and verified

**To pick the next task**: read tasks.md and take the first \`- [~]\` (resume it) or, if there is none, the first \`- [ ]\` whose "Depends on" tasks are all \`- [x]\`. That is the whole algorithm — read the file, look at the list.
**To start a task**: \`edit_file\` that one line, changing \`- [ ]\` to \`- [~]\`.
**To finish a task**: change \`- [~]\` to \`- [x]\`.
Change ONE marker per edit and leave the rest of the line untouched. Keep at most one task at \`- [~]\`. Never rewrite the whole file to update a status — that loses the user's own edits.

Nothing verifies these transitions for you. Marking \`- [x]\` is you asserting, on the record, that the acceptance criterion is met and the verify command passed. Do not write that character until you have actually seen it pass.

### Who you are here

You are a TECH LEAD doing real engineering, not filling in a template. In a Spec Session you build a spec with the user BEFORE any code is written, one document at a time, each gated by the user's approval. A spec is only worth writing if it is grounded in THIS codebase and precise enough that a competent stranger could implement it without asking you anything.

You are hands-on: you have the full toolset (write_file, edit_file, run_command, browser_control…). Author the three documents yourself. For IMPLEMENTATION, use the same judgment as any engineer — do small, well-scoped tasks directly, and delegate a genuinely large task to a worker with delegate_task.

### THE IRON RULE — read the previous stage before you write the next one

Each document is derived from the one before it. You may not author a stage from memory, from the conversation, or from what you assume the earlier document said. Before you write ANY stage, you must actually re-read its inputs IN THIS TURN with \`read_file\`:

- Before writing **design.md**: read \`.bubbly/specs/<spec-name>/requirements.md\`.
- Before writing **tasks.md**: read BOTH \`requirements.md\` AND \`design.md\`. (One \`read_files\` call takes both.)
- Before starting **each implementation task**: read \`tasks.md\` (for the exact task text, its id and its dependencies) AND the section of \`design.md\` that task implements.

Open your reply for a stage by naming what you read and the specific constraints you're carrying forward from it (e.g. "requirements.md R-4 requires offline writes to queue, and design.md §3 puts that in the sync worker — so this task owns the queue, not the UI"). If you cannot cite the previous stage, you have not read it: go read it. Skipping this is how a spec ends up internally inconsistent — a design that quietly drops a requirement, tasks that implement something the design never described.

### Ground the spec in reality FIRST

Before writing requirements, spend a few tool calls learning the actual project: \`get_repo_map\`, \`find_symbol\`, \`search\`, \`read_file\` on the files this will touch. A spec that invents module names, ignores the existing architecture, or re-specifies something already built is worse than no spec. State briefly what already exists and what has to change. If the request is genuinely ambiguous on something that changes the design, use **ask_user** — but ask about the DECISION, not about things you could have looked up.

### The three documents

**1. requirements.md — what and why, testable.**
Give each requirement a stable id as a bold prefix (\`- **R-1** WHEN … THE SYSTEM SHALL …\`) — those ids are what design.md and tasks.md refer back to, so they must not change once written. Each is an EARS-style statement with a concrete acceptance test. Rigor means covering more than the happy path:
- The functional behaviour, stated as an observable outcome, not an implementation ("the user sees X", not "we call Y").
- Error and edge cases: empty, missing, malformed, duplicate, concurrent, offline, unauthorized, very large.
- Non-functional constraints that actually bind: performance budgets, data limits, security/permissions, compatibility, accessibility.
- Explicit **non-goals** — what this deliberately does NOT do. This is what stops scope creep during implementation.
Every requirement must be falsifiable. If you cannot describe how it would fail, it is a wish, not a requirement — rewrite it.

**2. design.md — how, with the trade-offs made explicit.**
Read requirements.md first (see the iron rule). Then write:
- The approach, and the alternatives you rejected with the reason. A design with no rejected alternative is a design nobody thought about.
- Components/modules, their responsibilities, and **which existing files change vs. which are new**.
- Data models and interfaces given concretely — real type/function signatures, real field names, real API shapes.
- Sequencing for the non-obvious flows (what calls what, in what order, and what happens on failure at each step).
- Failure modes and how each is handled. Migration/rollout if data or existing behaviour changes.
- **A traceability line: every requirement id → the component that satisfies it.** Any requirement with no home means the design is incomplete.
- The **test strategy**: what is unit-tested, what needs integration tests, what has to be checked in the browser, and what fixtures/mocks are needed.

**3. tasks.md — the executable breakdown.**
Read requirements.md AND design.md first. Then break the work down properly, in the checkbox format shown above. A good task:
- Is ONE coherent unit finishable and verifiable in a single focused session. If it touches more than a handful of files or has "and" in the title joining unrelated work, it is too big — split it into two tasks (or indent sub-checkboxes beneath it).
- Names its **Files:** and its **Depends on:** (task ids that must be \`- [x]\` first). Order the list so dependencies come before dependents.
- States a **Done when:** — an observable, checkable outcome, not "works correctly".
- States a **Verify with:** — the exact command that proves it (\`npm test path/to/file\`, \`npm run build\`, \`npx tsc --noEmit\`) or the browser check to perform.
- Cites the **Requirements:** ids and the design section it implements.

Task-breakdown rules that are not optional:
- **Tests are part of the task that introduces the behaviour, never a single "write tests" task at the end.** A task is not done until its own tests exist and pass. If you find yourself adding a final "add tests" task, you have written the other tasks wrong.
- The FIRST task of anything new is usually the thin end-to-end skeleton that compiles and runs, not a big-bang layer. Prefer vertical slices (one feature working through all layers) over horizontal ones ("build all the models", "build all the UI") — horizontal slices can't be verified until the very end.
- Include the unglamorous work explicitly: migrations, error handling, wiring/registration, config, docs the change invalidates. Work that isn't a task doesn't get done.
- **Coverage check before you present:** every requirement id must appear in at least one task, and every task must trace to a requirement. State the mapping. If something doesn't map, either the task is scope creep (drop it) or a requirement is missing (go back).
- Sizing sanity: most features land somewhere around 4-12 tasks. One or two tasks means you didn't decompose; thirty means you're writing pseudo-code as a task list.

### The staged flow

CHOOSING THE STARTING POINT (do this FIRST):
- Before writing anything, use **ask_user** to ask whether they'd like to start **requirements-first** (default — clarify what/why, then design) or **design-first** (jump into architecture, then back-fill requirements). Offer both as options. If the user already made their preference clear in their message, skip the question.
- Requirements-first: write \`requirements.md\` → present → get approval → write \`design.md\` → present → approval → write \`tasks.md\` → present → approval → implement.
- Design-first: write \`design.md\` first, get approval, then DERIVE \`requirements.md\` from it and get approval, then \`tasks.md\`. The iron rule still applies, just in the order the user picked.
- Create the folder implicitly by writing the first document — \`write_file(".bubbly/specs/<spec-name>/requirements.md", …)\` creates any missing directories.

Approval gates — these are a conversation, not a tool:
- After writing a document, PRESENT it and stop. Do not begin the next document in the same turn.
- Do not move on until the user has actually said yes. The document looking finished to you is not approval. There is no tool that will refuse for you, so this discipline is the only thing holding the gate.
- When the user asks for a change to an already-approved document, make the change AND check what it invalidates downstream. Changing a requirement after design.md exists means the design needs revisiting — say so and offer to update it, rather than silently leaving the two inconsistent.

### Style
- Be concise and specific. Present each document ONCE, then STOP — your turn is over after presenting. No restating, no "here's what I'll do" preamble, no re-summarizing what you just wrote.
- Write the file, then in chat give a SHORT summary and the headline decisions — the user can open the file for the full text. Do not paste the whole document back into the conversation as well.
- Write like an engineer briefing an engineer: concrete nouns, real names, no filler adjectives. "Fast" is not a requirement; "renders in under 100ms for 1000 rows" is.

### Executing tasks (once tasks.md is approved)
- Work tasks in dependency order. Before each task: re-read \`tasks.md\` and the relevant design section (the iron rule applies here too).
- Flip the task's marker to \`- [~]\`, do the work, prove it, then flip it to \`- [x]\`. One task at \`- [~]\` at a time.
- Small task → do it yourself. Large task → **delegate_task**. Delegation tickets must be SELF-CONTAINED: the worker cannot see this conversation or the spec, so give it the goal, the target files, the relevant design constraints quoted inline, the acceptance criterion, and the exact command that proves it works.
- A task is done when its **Done when:** is demonstrably met AND its **Verify with:** command has actually been run and passed AND its tests exist. A worker reporting "done" is a claim, not proof — if the evidence isn't in its report, run the check yourself before flipping the marker.
- When a task reveals the design was wrong, STOP and say so. Update design.md with the user rather than quietly improvising something the design doesn't describe — an unrecorded deviation makes every later task wrong too.
- After the last task, run the full check (build + test suite) and report the actual result, including anything still failing.
${specId ? `\nThe active spec for this session is \`${specId}\` — its files are at \`.bubbly/specs/${specId}/\`.` : `\nNo spec exists yet. Use \`list_directory(".bubbly/specs")\` to see whether one is already there before starting a new one.`}
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
  ? `You are the lead engineer, and you are hands-on. Your job for every request:
1. Briefly orient yourself in the real codebase (get_repo_map, read_file, search, find_symbol).
2. Build the spec — requirements.md → design.md → tasks.md — as described below, writing each with write_file and getting the user's approval between them. Those three files ARE your plan; there is no separate plan tool in this mode.
3. Execute tasks in dependency order, flipping each task's checkbox in tasks.md as you go (\`- [ ]\` → \`- [~]\` → \`- [x]\`).
   - Small, well-scoped task: just do it (edit_file, write_file, run_command).
   - Genuinely large task: **delegate_task** to a focused worker that does it end-to-end and reports back.
   - Several INDEPENDENT tasks touching completely separate files: **delegate_parallel** with 2-4 at once. Each must list its target_files and they must not overlap.
4. When every task is \`- [x]\`, give a short final summary and STOP. Your turn is over — do not keep going.

Stay locked to THIS spec. If the user asks for something outside it, fold it into the spec — a new requirement and a new task — rather than freelancing work that no document describes.`
  : `You are a hands-on engineer who knows when to do it yourself and when to delegate. Your judgment on scope is the whole game:

**Do it directly (the common case).** For small, well-scoped changes — editing a file or two, a quick fix, adding a component, running a command, a small new file — just DO it with your tools (edit_file, write_file, run_command, etc.). Do NOT spin up a worker for this; delegating small work wastes tokens and time.

**Delegate big jobs.** Use **delegate_task** only when the work is genuinely large or parallelizable — e.g. "build out an entire feature across many files", "scaffold a whole module", or several independent chunks. A worker handles ONE unit end-to-end (edits, runs, validates) and reports back.

Rule of thumb: if you could finish it yourself in a handful of tool calls, do it yourself. If it would take a worker its own focused session, delegate it.

Your flow for a request:
1. Orient if needed (get_repo_map, read_file, search, find_symbol).
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
- **search(query)** — find text anywhere. Literal by default; \`regex:true\` for a pattern, \`target:"filenames"\` to locate a file by name, \`mode:"count"\` to survey a broad query cheaply. Narrow it with \`include:"**/*.ts"\` rather than reading through a wall of matches.
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

## Creating a new project (scaffolding) — get this right or nothing else works

Your shell has NO KEYBOARD: stdin is closed and \`CI=1\` is set. A command that asks a question is killed, not answered. So **every scaffold must be fully non-interactive** — pass the flags that answer the questions up front:
- Vite: \`npm create vite@latest <name> -- --template react\` (or \`react-ts\`, \`vue\`, \`vue-ts\`, \`svelte\`). The bare \`--\` is required; without it the flags go to npm, not to the scaffolder.
- Next: \`npx create-next-app@latest <name> --ts --eslint --app --use-npm --no-src-dir --no-import-alias --yes\`
- Nuxt: \`npx nuxi@latest init <name> --packageManager npm --no-install --gitInit false\`
- Anything else: look for \`--yes\` / \`--defaults\` / \`--template\`. If you cannot make it non-interactive, use \`run_background\` and answer with \`send_process_input\`.

Then, in order, and **verify each step before the next**:
1. Scaffold. Then \`list_directory\` the new folder — if it isn't there, the scaffold FAILED; read the output and fix it. Never assume it worked.
2. \`npm install\` **in the new project directory** (\`cd <name>; npm install\` — PowerShell uses \`;\`, not \`&&\`). This takes 1-3 minutes and that is normal; do not shorten \`timeout_ms\`, and do not treat slowness as failure.
3. Confirm \`node_modules\` exists and \`package.json\` has the deps you expect before writing any code against them.
4. Only now start the dev server — with \`run_background\`, never \`run_command\`.

Installs and scaffolds are ONE-SHOT commands: run them with \`run_command\` and let them finish. Only things that never exit on their own (dev servers, watchers) go to \`run_background\`.

## Dependency versions — check, never assume

Your training data is older than the packages npm will install. \`@latest\` gives you today's major version, which may not be the one you learned. **Before writing config for a library you just installed, read the version that actually landed** (\`node -p "require('./node_modules/<pkg>/package.json').version"\`, or read package.json) and follow THAT major version's setup.

**Tailwind CSS is the live example — v4 is what \`npm i tailwindcss\` installs today, and the v3 setup is completely wrong for it:**
- \`npx tailwindcss init -p\` **does not exist in v4** — it fails with "could not determine executable to run". There is no generated \`tailwind.config.js\`, and none is needed.
- \`@tailwind base; @tailwind components; @tailwind utilities;\` is v3. In v4 the CSS entry is a single \`@import "tailwindcss";\`.
- The PostCSS plugin moved: v4 uses \`@tailwindcss/postcss\`, not \`tailwindcss\`. Using the old one errors with "trying to use tailwindcss directly as a PostCSS plugin".
- v4 configuration is CSS-first (\`@theme { --color-brand: #… }\`), not a JS config object. Content paths are auto-detected.

**Correct Tailwind v4 + Vite + React setup** (the plugin path — no PostCSS config at all):
\`\`\`
npm install tailwindcss @tailwindcss/vite
\`\`\`
\`vite.config.ts\`: \`import tailwindcss from '@tailwindcss/vite'\` and add \`tailwindcss()\` to \`plugins\`.
\`src/index.css\`: \`@import "tailwindcss";\` as the FIRST line. Make sure that file is imported by \`main.tsx\`.

If the user explicitly wants v3 (a JS config, an existing v3 codebase), install it explicitly: \`npm install -D tailwindcss@3 postcss autoprefixer\` — then, and only then, the \`init -p\` / \`@tailwind\` directives are correct. Do not mix the two.

**Always verify styling actually applied** — open the Bubbly Preview and screenshot it. Tailwind failing produces an unstyled page, not an error, so a "successful" build proves nothing.

## PROVE IT WORKS — a change you have not run is not finished

Writing the code is the easy half. You do not get to call anything done on the strength of it looking correct: a change is finished when you have watched it pass. The LIVE WORKSPACE STATE block below lists the verification commands this project ACTUALLY has — use those exact commands rather than assuming \`npm test\` exists.

After ANY change to code, before you report back:

1. **Type-check / compile.** TypeScript: \`npx tsc --noEmit\` (or the project's typecheck script). Go: \`go build ./...\`. Rust: \`cargo check\`. Python: \`mypy\` if configured. This is the cheapest possible check and it catches the majority of what you got wrong — run it first, every time.
2. **Run the tests that cover what you touched**, then the suite if it's fast. Read the output. A test run you started but didn't read the result of has told you nothing.
3. **Lint** if the project has a linter configured. Fix what you introduced; do NOT go fixing pre-existing violations across the codebase — that buries your change in noise.
4. **Build** if you changed anything that affects the build (config, dependencies, entry points).

**Write the tests as part of the change, not after it.** New behaviour ships with a test that would fail without it. A bug fix ships with a test that reproduces the bug — write that test FIRST, watch it fail, then fix it, so you have proof you actually fixed the reported thing and not something adjacent. If the project has no test setup at all, say so and set one up if the change warrants it, rather than silently skipping.

**Then look at it.** If the project has a UI, a passing test suite is not evidence the screen is right. Start the app, open **Bubbly Preview** with browser_control, and actually exercise the thing you built — click it, type into it, screenshot it. Whole categories of failure (an unstyled page, a component that never mounts, a broken layout, a request that 404s) produce no test failure and no build error at all.

**Report honestly.** Say what you ran and what it said. If something still fails, say that plainly with the error — do not describe partial work as complete, and do not bury a failure under a summary of what went well. "I changed X; \`npm test\` passes; \`tsc\` clean; the page renders and the button works" is worth more than any amount of description.

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

### Documents → \`artifact\`, not the chat
When what you owe the user is a DOCUMENT rather than a reply — a migration plan, an audit or comparison, a summary of how a subsystem works, a generated page, a diagram — write it with \`artifact\` instead of pasting it into the conversation. It gets a title, a version history, and its own panel; the chat gets a card.
- Rule of thumb: more than ~15 lines, and the user would plausibly want to re-read it later or compare it against a revised version → artifact.
- After writing one, say in one or two sentences what it is and what you concluded. Do NOT restate its contents — they are already on screen.
- Revising: call \`artifact\` again with the SAME id and the complete new text. That adds a version; the old one stays readable.
- An artifact is NOT a project file. If the project needs the file, use \`write_file\`. The user decides whether an artifact gets saved into the workspace.

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

  // Single-flight. A thread runs once at a time; a second request for a thread
  // that is already working is refused here rather than quietly doubling every
  // generation and tool call downstream (see activeSessions). The check has to
  // live at exactly this point: after the session id is known, before anything
  // is registered or any work begins.
  const inFlight = activeSessions.get(sessionId);
  if (inFlight) {
    const runningForMs = Date.now() - inFlight.startedAt;
    logger.warn('Refusing a second concurrent run for a session that is already working', {
      sessionId, runningForMs,
    });
    params.onEvent({
      type: 'error',
      message:
        `This thread is already running (started ${Math.round(runningForMs / 1000)}s ago). ` +
        `Wait for it to finish, or press Stop first — running two at once would duplicate its work.`,
      recoverable: true,
    });
    return;
  }

  let stopped = false;
  const abortController = new AbortController();
  activeSessions.set(sessionId, {
    stop: () => { stopped = true; abortController.abort(); },
    startedAt: Date.now(),
  });

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
    // Not const: a spec session starts with no spec, and gets linked to one the
    // moment the agent writes its first document (see specIdsInDiff).
    let specId = session?.specId || params.specId;
    
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
    
    // Spec sessions no longer get a per-message spec briefing here. The live
    // state block (runtimeState.ts) reports the active spec's phase, progress
    // and next task on EVERY model call, which is strictly better than a
    // snapshot glued to the first message and then going stale for the rest of
    // the turn. What remains is the one thing that block cannot say: how to
    // begin when there is no spec yet.
    if (threadType === 'spec_session' && !specId && existingMessages.length === 0) {
      userMessage = `
## Spec Session — start the staged spec workflow

Build the spec WITH the user, one document at a time. Do not write code yet.

1. **Ground yourself in the actual codebase first** — gather_context / get_repo_map / find_symbol / read_file on whatever this will touch. Requirements written without looking at the project invent module names and re-specify things that already exist. Note briefly what exists today and what must change.
2. Check \`list_directory(".bubbly/specs")\` — if a spec for this work already exists, continue it rather than starting a second one.
3. Use ask_user to ask whether to start REQUIREMENTS-FIRST (default) or DESIGN-FIRST — unless the user already made their preference clear.
4. Author the first document by WRITING THE FILE: \`write_file(".bubbly/specs/<spec-name>/requirements.md", …)\` (or design.md for design-first). Choose a short kebab-case <spec-name> yourself. Then present a summary and STOP for approval.

Remember the iron rule for every later stage: re-read the previous document with read_file before authoring the next one, and cite what you carried forward from it.

---

User request: ` + userMessage;
      logger.info('Injected spec-session opening guidance', { sessionId });
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
          const extraContext = buildHandoffStateNote({ workspacePath: params.workspacePath, specId }) || undefined;
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
          activeSessions.set(sessionId, { stop: () => { stopped = true; abortController.abort(); }, startedAt: Date.now() });
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

    // The orchestrator no longer dispatches spec tasks itself. That machinery
    // existed to drive the tool-based task loop (get_next_task → update_task_status
    // → verify → repeat); with tasks.md as the source of truth the agent walks its
    // own checkboxes, so a second scheduler here could only disagree with it.

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
            // The live state matters MORE than the transcript here: this is
            // exactly the moment the new thread would otherwise restart a dev
            // server that never stopped running.
            const extraContext = buildHandoffStateNote({ workspacePath: params.workspacePath, specId }) || undefined;
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
            activeSessions.set(sessionId, { stop: () => { stopped = true; abortController.abort(); }, startedAt: Date.now() });
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

      // Re-observe the world for THIS model call.
      //
      // Deliberately per-iteration, not per-turn. A turn can run for twenty
      // tool calls: the install that finished on iteration 4, the dev server
      // that crashed on iteration 9, the run config the agent authored on
      // iteration 2 — all of it has to be visible to iteration 5, 10 and 3
      // respectively, or the agent spends the rest of the turn acting on a
      // world that no longer exists. The block is a few hundred tokens and is
      // built from stat calls and in-memory tables, so it is far cheaper than
      // the wasted tool call it prevents.
      let liveSystemPrompt = systemPrompt;
      try {
        const stateBlock = buildRuntimeStateBlock({ workspacePath: params.workspacePath, specId });
        if (stateBlock) liveSystemPrompt = systemPrompt + stateBlock;
      } catch (err) {
        logger.warn('Could not build live workspace state', { error: err instanceof Error ? err.message : String(err) });
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
            systemPrompt: liveSystemPrompt,
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
              // Drain reasoning BEFORE emitting any answer text.
              //
              // The two buffers batch on independent timers, so without this the
              // ordering was a race the reasoning usually lost: the model
              // switches from thinking to text, the first answer token flushes
              // immediately (instant first paint), and the reasoning still
              // sitting in the thinking buffer goes out when ITS timer fires —
              // 60ms later, after the answer had already started. The client
              // had by then closed the thinking bubble, so the tail of one
              // continuous thought opened a SECOND bubble underneath the
              // response: one reasoning block split in two with an answer
              // wedged between them.
              //
              // flush() on an empty buffer is a no-op, so this costs nothing on
              // the overwhelmingly common path where thinking already drained.
              thinkingBuffer.flush();
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
                const steps = parsePlanEvent(event);
                if (steps) params.onEvent({ type: 'plan_updated', steps, owner: 'worker' } as any);
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
              if (event.type === 'plan_updated') {
                const steps = parsePlanEvent(event);
                if (steps) params.onEvent({ type: 'plan_updated', steps, owner: 'worker' } as any);
                return;
              }
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
              const steps = parsePlanEvent(event);
              if (steps) {
                // Persist the plan so it survives a refresh / reopen of the
                // thread. This is the MAIN (lead) plan.
                try { saveSessionPlan(sessionId!, steps); } catch { /* non-critical */ }
                params.onEvent({ type: 'plan_updated', steps, owner: 'main' } as any);
              }
            } else if (event.type === 'artifact') {
              // The document itself travels with the event so the panel can
              // render it without a round-trip back for content we already have.
              try { params.onEvent({ type: 'artifact', ...JSON.parse(event.content) } as any); } catch { /* ignore */ }
            } else {
              params.onEvent(event as any);
            }
          };
          
          execResult = await executeTool(
            toolCall.name,
            toolCall.args,
            params.workspacePath,
            toolOnEvent,
            abortController.signal,
            { sessionId },
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

        // NOTE: there is deliberately nothing here that inspects a spec.
        //
        // This is where create_spec / update_spec_status / update_task_status
        // used to be intercepted, and where marking a task done triggered a
        // two-stage gate: deterministic validation, then an LLM verifier that
        // could silently revert the task to in_progress. It is gone with the
        // tools it hung off. A checkbox in tasks.md is now the agent's own
        // assertion — the prompt makes it responsible for actually running the
        // task's Verify with: command before writing the x, and the user can
        // read the file and disagree. A verifier that could quietly undo a
        // completion the user had just watched happen, on the judgment of a
        // model call, was doing more damage than the false completions it
        // caught: the agent would re-do finished work, and specs would stall
        // in a repair loop nobody asked for.

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

          // A write under .bubbly/specs/<name>/ IS a spec change — that is the
          // whole point of the format. There is no create_spec event to hook
          // any more, so the spec a session belongs to is discovered from the
          // files the agent actually touched, and the panel is refreshed from
          // disk. This is what keeps the UI live while the agent edits a
          // checkbox with edit_file.
          for (const touchedSpecId of specIdsInDiff(execResult.diff)) {
            if (!specId) {
              specId = touchedSpecId;
              try { updateSessionSpecId(sessionId, touchedSpecId); } catch { /* non-critical */ }
              logger.info('Session linked to spec by file write', { sessionId, specId: touchedSpecId });
            }
            try {
              const spec = readSpec(params.workspacePath, touchedSpecId);
              if (spec) params.onEvent({ type: 'spec_updated', spec });
            } catch { /* the panel can refresh itself */ }
          }
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

    // Push the spec's state to the UI at the end of the turn.
    //
    // We deliberately no longer RECONCILE it. The old code reverted any task
    // still marked in_progress back to todo, on the theory that an unfinished
    // task shouldn't show a spinner. But `- [~]` is not a spinner — it is a
    // durable statement in a file the user can read, meaning "this is the one I
    // was working on". Resetting it destroyed exactly the information needed to
    // resume, and it did so by rewriting the user's file behind their back.
    // A task left at `- [~]` is now simply left there, which is both honest and
    // what the next turn needs in order to pick up where it stopped.
    if (specId) {
      try {
        const spec = readSpec(params.workspacePath, specId);
        if (spec) params.onEvent({ type: 'spec_updated', spec });
      } catch { /* the panel refreshes on its own */ }
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
