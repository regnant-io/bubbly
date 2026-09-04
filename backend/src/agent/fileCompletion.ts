/**
 * DEPRECATED: Self-healing file completion logic.
 *
 * This module was used to detect and auto-complete truncated file writes,
 * but has been disabled as modern models no longer require this behavior.
 * The auto-completion logic was creating stuck loops.
 *
 * IMPORTANT: This file is kept for historical reference but the healing
 * functions are NO LONGER CALLED from orchestrator.ts, taskAgent.ts, or tools/index.ts.
 * 
 * To re-enable in the future, you would need to:
 * 1. Add back the healTruncatedWriteIfNeeded calls in taskAgent.ts
 * 2. Add back the autoCompleteTruncated setting to types.ts, db/index.ts, settingsValidator.ts
 * 3. Add back the orchestrator checks for the setting
 *
 * ---
 *
 * The dominant cause of "corrupted/truncated files" is the model's GENERATION
 * getting cut off mid-file while it emits a whole file inside a single
 * tool-call argument (bounded by the context window). Detecting it and asking
 * the model to fix it still leaves the model doing the fragile part.
 *
 * This module makes truncation SELF-HEALING and invisible: when a write is
 * detected as cut off, the orchestrator calls completeTruncatedFile, which:
 *   1. trims the partial last line so the file ends at a clean line boundary,
 *   2. asks the model for ONLY the remaining code (plain text, no tool, no
 *      fences) starting after that boundary,
 *   3. appends it (clean seam at the newline),
 *   4. repeats until the file is structurally complete or a bound is hit.
 *
 * Seams are always at line boundaries, so we never glue tokens together or
 * duplicate a half-line — which is what makes this reliable across models.
 */

import { callModel } from '../models/index';
import { logger } from '../utils/logger';
import { detectTruncatedWrite } from './tools/writeIntegrity';
import type { AgentConfig, WSServerEvent } from '../types';

/** Strip a wrapping ```lang ... ``` fence if the model added one. */
function stripCodeFences(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[\w+-]*\r?\n/, '');
  t = t.replace(/\r?\n?```\s*$/, '');
  return t;
}

export interface FileCompletionResult {
  completed: boolean;
  rounds: number;
  appendedChars: number;
}

/**
 * Drive a truncated file to completion by repeatedly fetching and appending the
 * remainder. Returns once the file is structurally complete, the round budget
 * is exhausted, or the run is stopped.
 */
export async function completeTruncatedFile(params: {
  config: AgentConfig;
  workspacePath: string;
  relPath: string;
  onEvent: (event: WSServerEvent) => void;
  signal?: AbortSignal;
  isStopped?: () => boolean;
  maxRounds?: number;
}): Promise<FileCompletionResult> {
  const { config, workspacePath, relPath, onEvent, signal } = params;
  const isStopped = params.isStopped ?? (() => false);
  const maxRounds = params.maxRounds ?? 8;

  const { readFile, writeFile, appendFile } = await import('./tools/filesystem');

  let appendedChars = 0;
  let rounds = 0;

  while (rounds < maxRounds && !isStopped()) {
    let current: string;
    try {
      current = await readFile(workspacePath, relPath);
    } catch {
      return { completed: false, rounds, appendedChars };
    }

    const trunc = detectTruncatedWrite(relPath, current);
    if (!trunc.truncated) {
      return { completed: true, rounds, appendedChars };
    }

    rounds++;

    // Trim the (likely partial) last line so the seam is a clean line boundary.
    const lastNl = current.lastIndexOf('\n');
    const clean = lastNl >= 0 ? current.slice(0, lastNl + 1) : '';
    if (clean && clean !== current) {
      try {
        await writeFile(workspacePath, relPath, clean);
        current = clean;
      } catch {
        /* keep going with original */
      }
    }

    const tailLines = current.split('\n').filter((l) => l.length > 0).slice(-12).join('\n');

    onEvent({ type: 'status', content: `Auto-completing ${relPath} (was cut off) — pass ${rounds}…` });

    let continuation = '';
    try {
      const resp = await callModel({
        config,
        systemPrompt:
          'You are completing a SOURCE FILE that was cut off mid-generation. ' +
          'Output ONLY the missing remainder of the file as raw code — NO explanations, ' +
          'NO markdown code fences, and do NOT repeat any lines that are already present. ' +
          'Begin exactly at the line that should follow the provided tail, and continue until the file is syntactically complete.',
        messages: [
          {
            role: 'user',
            content:
              `File path: ${relPath}\n\n` +
              `The file currently ENDS with these lines (already written — do not repeat them):\n` +
              `-----\n${tailLines}\n-----\n\n` +
              `Output ONLY the code that comes next to finish the file.`,
          },
        ],
        tools: [],
        signal,
        // Stream so the user sees progress and we avoid the non-streaming timeout.
        onToken: (t) => onEvent({ type: 'text_delta', content: t }),
      });
      continuation = stripCodeFences(resp.textContent);
    } catch (err) {
      logger.warn('File auto-completion model call failed', { relPath, error: err instanceof Error ? err.message : String(err) });
      return { completed: false, rounds, appendedChars };
    }

    if (!continuation.trim()) {
      // Model produced nothing useful — stop trying.
      return { completed: false, rounds, appendedChars };
    }

    try {
      await appendFile(workspacePath, relPath, continuation);
      appendedChars += continuation.length;
    } catch (err) {
      logger.warn('File auto-completion append failed', { relPath, error: err instanceof Error ? err.message : String(err) });
      return { completed: false, rounds, appendedChars };
    }
  }

  // Final structural check.
  try {
    const { readFile } = await import('./tools/filesystem');
    const final = await readFile(workspacePath, relPath);
    const done = !detectTruncatedWrite(relPath, final).truncated;
    logger.info('File auto-completion finished', { relPath, rounds, appendedChars, completed: done });
    return { completed: done, rounds, appendedChars };
  } catch {
    return { completed: false, rounds, appendedChars };
  }
}


/**
 * Shared post-write healing used by BOTH the lead orchestrator and worker
 * agents. After a write_file/append_file, if the resulting file looks cut off
 * mid-generation, drive it to completion (append-only, at clean line seams) and
 * return an updated tool result + a fresh diff. This lives in one place so every
 * write path — wherever it runs — is self-healing, instead of only the lead.
 *
 * Returns the (possibly updated) exec result. On any failure it returns the
 * original unchanged so a write is never lost.
 */
export async function healTruncatedWriteIfNeeded(params: {
  config: AgentConfig;
  workspacePath: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  execResult: { result: string; diff?: import('../types').FileDiff[] };
  onEvent: (event: WSServerEvent) => void;
  signal?: AbortSignal;
  isStopped?: () => boolean;
  enabled?: boolean;
}): Promise<{ result: string; diff?: import('../types').FileDiff[] }> {
  const { config, workspacePath, toolName, toolArgs, execResult, onEvent, signal } = params;
  const isStopped = params.isStopped ?? (() => false);
  if (params.enabled === false) return execResult;
  if (toolName !== 'write_file' && toolName !== 'append_file') return execResult;
  if (isStopped()) return execResult;

  const relPath = String((toolArgs as Record<string, unknown>)?.path ?? '');
  if (!relPath) return execResult;

  try {
    const { readFile, writeFile } = await import('./tools/filesystem');
    const written = await readFile(workspacePath, relPath);
    if (!detectTruncatedWrite(relPath, written).truncated) return execResult;

    logger.info('Detected truncated write — auto-completing', { path: relPath });
    const heal = await completeTruncatedFile({
      config,
      workspacePath,
      relPath,
      onEvent,
      signal,
      isStopped,
    });

    try {
      const healed = await readFile(workspacePath, relPath);
      const rewrite = await writeFile(workspacePath, relPath, healed); // recompute diff
      const { invalidateIndex } = await import('./intelligence/codeIntelligence');
      invalidateIndex(workspacePath);
      return {
        result: heal.completed
          ? `File written and auto-completed: ${relPath} (the initial generation was cut off; the system finished it in ${heal.rounds} pass(es)).`
          : `File written: ${relPath} — WARNING: it appears truncated and auto-completion could not finish it. Review ${relPath} and complete it with append_file.`,
        diff: [rewrite.diff],
      };
    } catch {
      return execResult;
    }
  } catch (e) {
    logger.warn('Truncation auto-completion check failed', { error: e instanceof Error ? e.message : String(e) });
    return execResult;
  }
}
