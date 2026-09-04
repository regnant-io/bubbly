/**
 * Task Agent — a focused sub-agent that implements ONE spec task.
 *
 * In Spec Session mode Bubbly no longer runs a single sprawling chat loop.
 * Instead the orchestrator dispatches a dedicated Task Agent per task. Each one:
 *   - receives a TIGHT context package (task contract + focused repo map +
 *     outlines of the files it will touch) — ideal for small models
 *   - has a small, bounded iteration budget (it does one thing)
 *   - runs tools, makes minimal edits, and self-validates
 *   - reports structured progress (dispatched → working → validating → done)
 *
 * This keeps each unit of work scoped and verifiable, which is what makes the
 * overall run stable and lets weak models succeed task-by-task.
 */

import { callModel } from '../models/index';
import { StreamBuffer } from '../models/streamBuffer';
import { executeTool, checkRequiresApproval, TOOL_DEFINITIONS } from './tools/index';
import { buildTaskContext, invalidateIndex } from './intelligence/codeIntelligence';
import { runValidation, formatIssuesForRepair } from './intelligence/validator';
import { logger } from '../utils/logger';
import type { AgentConfig, Message, SpecTask, Spec, WSServerEvent, FileDiff } from '../types';

export interface DelegatedAgentResult {
  report: string;
  filesTouched: string[];
  /** Full file diffs the worker produced, so the lead can persist them for refresh-recovery. */
  diffs: FileDiff[];
  validationOk: boolean;
}

/**
 * Run a focused worker sub-agent on a free-form instruction and return a report.
 *
 * This powers the `delegate_task` tool: in Spec Session mode the LEAD agent acts
 * like a tech lead — it plans and delegates, but does not edit files itself.
 * Each delegated worker gets a tight context package, does the work with tools,
 * self-validates, and reports back ("ACK" + summary) to the lead.
 */
export async function runDelegatedAgent(params: {
  config: AgentConfig;
  workspacePath: string;
  instruction: string;
  targetFiles?: string[];
  acceptance?: string;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  maxIterations?: number;
  onEvent: (event: WSServerEvent) => void;
  onProgress?: (phase: string, detail?: string) => void;
  requestApproval: (toolName: string, args: Record<string, unknown>, preview?: string) => Promise<boolean>;
  isStopped: () => boolean;
}): Promise<DelegatedAgentResult> {
  const {
    config, workspacePath, instruction, targetFiles, acceptance,
    requireApprovalForWrites, requireApprovalForShell, onEvent, onProgress, requestApproval, isStopped,
  } = params;
  const maxIterations = params.maxIterations ?? 30;

  const focusQuery = `${instruction} ${acceptance ?? ''} ${(targetFiles ?? []).join(' ')}`;
  onProgress?.('gathering_context');
  const { repoMap, focusFiles } = buildTaskContext(workspacePath, focusQuery, { tokenBudget: 1200, maxFocusFiles: 5 });
  const focusText = focusFiles.length > 0
    ? focusFiles.map((f) => `### ${f.path}\n${f.outline || '(no symbols)'}`).join('\n\n')
    : '(no closely-related files found — this may be new code)';

  const isWindows = process.platform === 'win32';
  const systemPrompt = `You are a BUBBLY Worker Agent. A lead engineer has delegated ONE unit of work to you. Do exactly that, then report back.

## Environment
- OS: ${isWindows ? 'Windows — use cmd.exe commands (dir, not ls or Get-ChildItem; && for chaining; %VAR% for env vars)' : 'Unix-like — sh/bash'}

## Your assignment
${instruction}
${acceptance ? `\nDone when: ${acceptance}` : ''}
${targetFiles && targetFiles.length > 0 ? `Likely files: ${targetFiles.join(', ')}` : ''}

## Rules
- Use navigation tools (get_repo_map, find_symbol, get_file_outline) before reading whole files.
- EXISTING files: edit_file (minimal change). NEW files: write_file. Never paste code as text.
- After editing, call validate_changes on the files you changed and fix any errors.
- Write real, working code — no stubs or TODOs.
- When the assignment is genuinely complete and validation passes, end with exactly one line:
  ACK: <one-sentence report of what you did>
- Do NOT ask questions. You have what you need below.`;

  const kickoff = `${repoMap}\n\n---\n# Files most relevant to this assignment\n${focusText}\n\n---\nBegin now.`;
  const messages: Message[] = [{ role: 'user', content: kickoff }];
  // Workers get the full toolset EXCEPT delegation/ask — they do the work
  // directly and cannot spawn further workers (prevents infinite nesting).
  // Workers do BOUNDED work and report back. They deliberately do NOT get
  // `watch`: a worker blocking on a watcher also blocks the lead that is
  // awaiting it, and the worker's isStopped() is only checked between
  // iterations — never during a tool call — so the whole run became
  // unstoppable. Waiting on slow things is the lead's job.
  const workerTools = TOOL_DEFINITIONS.filter((t) =>
    t.name !== 'delegate_task' && t.name !== 'delegate_parallel' && t.name !== 'ask_user' && t.name !== 'watch');
  const filesTouched = new Set<string>();
  const diffsByPath = new Map<string, FileDiff>();
  const recentSigs: string[] = [];
  let iteration = 0;
  let report = '';

  onProgress?.('working');
  while (iteration < maxIterations && !isStopped()) {
    iteration++;
    let response;
    // Batch text AND thinking, exactly as the lead does. Sub-agents previously
    // emitted a socket frame per token on both streams; with several workers
    // running at once that was the heaviest source of UI judder.
    const textBuf = new StreamBuffer(
      { minTokens: 5, minChars: 100, flushIntervalMs: 50 },
      (t) => onEvent({ type: 'text_delta', content: t }),
    );
    const thinkBuf = new StreamBuffer(
      { minTokens: 8, minChars: 160, flushIntervalMs: 60 },
      (t) => onEvent({ type: 'thinking', content: t }),
    );
    try {
      response = await callModel({
        config, systemPrompt, messages, tools: workerTools,
        onToken: (t) => textBuf.push(t),
        onThinking: (t) => thinkBuf.push(t),
      });
      thinkBuf.finalize();
      textBuf.finalize();
    } catch (err) {
      // Drain before retrying so buffered output isn't lost or replayed late.
      thinkBuf.finalize();
      textBuf.finalize();
      logger.error('Delegated agent model call failed', { error: err instanceof Error ? err.message : String(err) });
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }

    const blocks: Message['content'] = [];
    if (response.textContent) blocks.push({ type: 'text', text: response.textContent });
    for (const tc of response.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    messages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : response.textContent });

    if (response.textContent) {
      onEvent({ type: 'message', content: response.textContent, sessionId: '' });
      const m = /ACK:\s*(.+)/i.exec(response.textContent);
      if (m && response.toolCalls.length === 0) { report = m[1].trim(); break; }
    }

    if (response.toolCalls.length === 0) {
      if (response.stopReason === 'max_tokens' || response.stopReason === 'length') {
        messages.push({ role: 'user', content: 'Continue from where you left off.' });
        continue;
      }
      messages.push({ role: 'user', content: 'If the assignment is complete and validation passes, reply "ACK: <summary>". Otherwise keep using tools to finish it.' });
      if (iteration > 2) break;
      continue;
    }

    const toolResults: Message['content'] = [];
    for (const tc of response.toolCalls) {
      if (isStopped()) break;
      // Loop-breaker for the worker too.
      const sig = `${tc.name}:${JSON.stringify(tc.args)}`;
      const repeats = recentSigs.filter((s) => s === sig).length;
      recentSigs.push(sig);
      if (recentSigs.length > 10) recentSigs.shift();
      if (repeats >= 3) {
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: 'You repeated this exact call too many times. Read the file and try a different approach.' });
        continue;
      }

      onEvent({ type: 'tool_call', id: tc.id, tool: tc.name, args: tc.args });
      const ac = checkRequiresApproval(tc.name, tc.args, requireApprovalForWrites, requireApprovalForShell);
      if (ac.autoDecline) { toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `Auto-declined: ${ac.reason}` }); continue; }
      if (ac.required && !(await requestApproval(tc.name, tc.args, ac.preview))) {
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: 'Action rejected by user.' });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: 'Action was rejected by the user.' });
        continue;
      }
      try {
        const exec = await executeTool(tc.name, tc.args, workspacePath, (e) => {
          if (e.type.startsWith('terminal_')) { try { onEvent({ type: e.type, ...JSON.parse(e.content) } as any); } catch { /* ignore */ } }
          else onEvent(e as any);
        });
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: exec.result, diff: exec.diff });
        if (exec.diff) { for (const d of exec.diff) { filesTouched.add(d.path); diffsByPath.set(d.path, d); } invalidateIndex(workspacePath); onEvent({ type: 'diff', files: exec.diff }); }
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: exec.result });
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `Tool failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
  }

  // Final deterministic validation of the worker's changes.
  onProgress?.('validating');
  const touched = Array.from(filesTouched);
  let validationOk = true;
  if (touched.length > 0) {
    const rep = await runValidation({ workspacePath, changedFiles: touched, timeoutMs: 30000 });
    validationOk = rep.ok;
    onEvent({ type: 'diagnostics', issues: rep.issues });
    if (!rep.ok) report = `${report || 'Made changes'} — WARNING: validation reported issues: ${formatIssuesForRepair(rep)}`;
  }
  onProgress?.('done', report);

  return {
    report: report || `Worked on the assignment (${filesTouched.size} file(s) changed).`,
    filesTouched: touched,
    diffs: Array.from(diffsByPath.values()),
    validationOk,
  };
}


export interface TaskAgentResult {
  success: boolean;
  filesTouched: string[];
  summary: string;
  validationOk: boolean;
}

export interface TaskAgentParams {
  config: AgentConfig;
  workspacePath: string;
  spec: Spec;
  task: SpecTask;
  taskIndex: number;
  totalTasks: number;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
  maxIterations?: number;
  onEvent: (event: WSServerEvent) => void;
  /** Request human approval for a tool; returns whether it was approved. */
  requestApproval: (toolName: string, args: Record<string, unknown>, preview?: string) => Promise<boolean>;
  isStopped: () => boolean;
}

function buildTaskSystemPrompt(spec: Spec, task: SpecTask, taskIndex: number, totalTasks: number): string {
  const relatedProps = (spec.properties ?? []).filter((p) =>
    (task.satisfiesProperties ?? []).includes(p.id)
  );
  const propsText =
    relatedProps.length > 0
      ? relatedProps.map((p) => `- ${p.id}: ${p.statement}`).join('\n')
      : (spec.properties ?? []).slice(0, 5).map((p) => `- ${p.id}: ${p.statement}`).join('\n');

  return `You are a BUBBLY Task Agent. You implement EXACTLY ONE task, then stop.

## The Spec
"${spec.title}" (${spec.type})

## Acceptance Properties this work serves
${propsText || '(none specified)'}

## YOUR TASK (${taskIndex + 1}/${totalTasks})
**${task.title}**
${task.acceptance ? `Definition of done: ${task.acceptance}` : ''}
${task.targetFiles && task.targetFiles.length > 0 ? `Expected files: ${task.targetFiles.join(', ')}` : ''}

## RULES
- Implement ONLY this task. Do NOT work on other tasks.
- Use the navigation tools (get_repo_map, find_symbol, get_file_outline) before reading whole files.
- Make MINIMAL edits: use edit_file for existing files, write_file only for new files.
- After editing, call validate_changes on the files you changed and FIX any reported errors.
- Write real, working code — never stubs, placeholders, or TODO comments.
- When the task is genuinely complete and validation passes, end your turn with a single line:
  TASK_COMPLETE: <one-sentence summary of what you did>
- Do NOT ask questions. Take action. You have everything you need below.`;
}

/**
 * Run a single task to completion (or until the iteration budget is exhausted).
 */
export async function runTaskAgent(params: TaskAgentParams): Promise<TaskAgentResult> {
  const {
    config, workspacePath, spec, task, taskIndex, totalTasks,
    requireApprovalForWrites, requireApprovalForShell, onEvent, requestApproval, isStopped,
  } = params;
  const maxIterations = params.maxIterations ?? 40;

  onEvent({ type: 'task_dispatched', specId: spec.id, taskId: task.id, taskTitle: task.title, index: taskIndex, total: totalTasks });
  onEvent({ type: 'task_progress', specId: spec.id, taskId: task.id, phase: 'gathering_context' });

  // Build the tight per-task context package.
  const focusQuery = `${task.title} ${task.acceptance ?? ''} ${(task.targetFiles ?? []).join(' ')}`;
  const { repoMap, focusFiles } = buildTaskContext(workspacePath, focusQuery, { tokenBudget: 1200, maxFocusFiles: 5 });

  const focusText =
    focusFiles.length > 0
      ? focusFiles.map((f) => `### ${f.path}\n${f.outline || '(no symbols)'}`).join('\n\n')
      : '(no closely-related files found — this may be new code)';

  const systemPrompt = buildTaskSystemPrompt(spec, task, taskIndex, totalTasks);
  const kickoff =
    `${repoMap}\n\n---\n# Files most relevant to this task\n${focusText}\n\n---\nBegin implementing the task now.`;

  const messages: Message[] = [{ role: 'user', content: kickoff }];
  const filesTouched = new Set<string>();
  let iteration = 0;
  let completed = false;
  let summary = '';

  onEvent({ type: 'task_progress', specId: spec.id, taskId: task.id, phase: 'working' });

  while (iteration < maxIterations && !isStopped()) {
    iteration++;

    let response;
    const textBuf = new StreamBuffer(
      { minTokens: 5, minChars: 100, flushIntervalMs: 50 },
      (t) => onEvent({ type: 'text_delta', content: t }),
    );
    const thinkBuf = new StreamBuffer(
      { minTokens: 8, minChars: 160, flushIntervalMs: 60 },
      (t) => onEvent({ type: 'thinking', content: t }),
    );
    try {
      response = await callModel({
        config,
        systemPrompt,
        messages,
        tools: TOOL_DEFINITIONS,
        onToken: (t) => textBuf.push(t),
        onThinking: (t) => thinkBuf.push(t),
      });
      thinkBuf.finalize();
      textBuf.finalize();
    } catch (err) {
      thinkBuf.finalize();
      textBuf.finalize();
      logger.error('Task agent model call failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      // brief backoff then retry once per iteration budget
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    // Record assistant turn.
    const assistantBlocks: Message['content'] = [];
    if (response.textContent) assistantBlocks.push({ type: 'text', text: response.textContent });
    for (const tc of response.toolCalls) assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    messages.push({ role: 'assistant', content: assistantBlocks.length > 0 ? assistantBlocks : response.textContent });

    if (response.textContent) {
      onEvent({ type: 'message', content: response.textContent, sessionId: '' });
      const m = /TASK_COMPLETE:\s*(.+)/i.exec(response.textContent);
      if (m && response.toolCalls.length === 0) {
        summary = m[1].trim();
        completed = true;
        break;
      }
    }

    if (response.toolCalls.length === 0) {
      // No tools and no completion marker — nudge once, then accept stop.
      if (response.stopReason === 'max_tokens' || response.stopReason === 'length') {
        messages.push({ role: 'user', content: 'Continue from where you left off.' });
        continue;
      }
      messages.push({
        role: 'user',
        content: 'If the task is done and validation passes, reply with "TASK_COMPLETE: <summary>". Otherwise continue using tools to finish it.',
      });
      // Avoid infinite no-op loops.
      if (iteration > 3 && messages.slice(-4).every((mm) => mm.role !== 'assistant' || (typeof mm.content !== 'string' && !mm.content.some((b) => b.type === 'tool_use')))) {
        break;
      }
      continue;
    }

    // Execute tool calls.
    const toolResults: Message['content'] = [];
    for (const tc of response.toolCalls) {
      if (isStopped()) break;
      onEvent({ type: 'tool_call', id: tc.id, tool: tc.name, args: tc.args });

      const approvalCheck = checkRequiresApproval(tc.name, tc.args, requireApprovalForWrites, requireApprovalForShell);
      if (approvalCheck.autoDecline) {
        const content = `Operation auto-declined: ${approvalCheck.reason}`;
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: content });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        continue;
      }
      if (approvalCheck.required) {
        const approved = await requestApproval(tc.name, tc.args, approvalCheck.preview);
        if (!approved) {
          onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: 'Action rejected by user.' });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: 'Action was rejected by the user.' });
          continue;
        }
      }

      try {
        const exec = await executeTool(tc.name, tc.args, workspacePath, (e) => {
          if (e.type.startsWith('terminal_')) {
            try { onEvent({ type: e.type, ...JSON.parse(e.content) } as any); } catch { /* ignore */ }
          } else {
            onEvent(e as any);
          }
        });
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: exec.result, diff: exec.diff });
        if (exec.diff) {
          for (const d of exec.diff) filesTouched.add(d.path);
          invalidateIndex(workspacePath);
          onEvent({ type: 'diff', files: exec.diff });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: exec.result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: `Error: ${msg}` });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `Tool failed: ${msg}. Try a different approach.` });
      }
    }
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
  }

  // Final deterministic validation of everything the task touched.
  onEvent({ type: 'task_progress', specId: spec.id, taskId: task.id, phase: 'validating' });
  const touched = Array.from(filesTouched);
  let validationOk = true;
  if (touched.length > 0) {
    const report = await runValidation({ workspacePath, changedFiles: touched, timeoutMs: 30000 });
    validationOk = report.ok;
    onEvent({ type: 'diagnostics', issues: report.issues });
    if (!report.ok) {
      // Give the agent one focused repair pass.
      onEvent({ type: 'task_progress', specId: spec.id, taskId: task.id, phase: 'repairing', detail: report.summary });
      messages.push({
        role: 'user',
        content: `Validation found problems. Fix these, then reply TASK_COMPLETE:\n${formatIssuesForRepair(report)}`,
      });
      const repaired = await runRepairPass(params, messages, filesTouched);
      validationOk = repaired;
    }
  }

  return {
    success: completed || filesTouched.size > 0,
    filesTouched: Array.from(filesTouched),
    summary: summary || `Worked on "${task.title}" (${filesTouched.size} file(s) changed).`,
    validationOk,
  };
}

/** A single bounded repair pass after validation fails. */
async function runRepairPass(params: TaskAgentParams, messages: Message[], filesTouched: Set<string>): Promise<boolean> {
  const { config, workspacePath, requireApprovalForWrites, requireApprovalForShell, onEvent, requestApproval, isStopped } = params;
  let iter = 0;
  while (iter < 8 && !isStopped()) {
    iter++;
    let response;
    try {
      response = await callModel({ config, systemPrompt: 'Fix the reported errors with minimal edits, then validate again.', messages, tools: TOOL_DEFINITIONS, onToken: (t) => onEvent({ type: 'text_delta', content: t }) });
    } catch {
      return false;
    }
    const blocks: Message['content'] = [];
    if (response.textContent) blocks.push({ type: 'text', text: response.textContent });
    for (const tc of response.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    messages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : response.textContent });

    if (response.toolCalls.length === 0) break;

    const results: Message['content'] = [];
    for (const tc of response.toolCalls) {
      if (isStopped()) break;
      onEvent({ type: 'tool_call', id: tc.id, tool: tc.name, args: tc.args });
      const ac = checkRequiresApproval(tc.name, tc.args, requireApprovalForWrites, requireApprovalForShell);
      if (ac.autoDecline) { results.push({ type: 'tool_result', tool_use_id: tc.id, content: `Auto-declined: ${ac.reason}` }); continue; }
      if (ac.required && !(await requestApproval(tc.name, tc.args, ac.preview))) {
        results.push({ type: 'tool_result', tool_use_id: tc.id, content: 'Rejected by user.' });
        continue;
      }
      try {
        const exec = await executeTool(tc.name, tc.args, workspacePath, (e) => { if (!e.type.startsWith('terminal_')) onEvent(e as any); });
        onEvent({ type: 'tool_result', id: tc.id, tool: tc.name, result: exec.result, diff: exec.diff });
        if (exec.diff) { for (const d of exec.diff) filesTouched.add(d.path); invalidateIndex(workspacePath); onEvent({ type: 'diff', files: exec.diff }); }
        results.push({ type: 'tool_result', tool_use_id: tc.id, content: exec.result });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: tc.id, content: `Tool failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (results.length > 0) messages.push({ role: 'user', content: results });

    // Re-validate.
    const report = await runValidation({ workspacePath, changedFiles: Array.from(filesTouched), timeoutMs: 30000 });
    onEvent({ type: 'diagnostics', issues: report.issues });
    if (report.ok) return true;
    messages.push({ role: 'user', content: `Still failing:\n${formatIssuesForRepair(report)}` });
  }
  const final = await runValidation({ workspacePath, changedFiles: Array.from(filesTouched), timeoutMs: 30000 });
  onEvent({ type: 'diagnostics', issues: final.issues });
  return final.ok;
}
