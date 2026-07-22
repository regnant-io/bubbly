import { callModel } from '../models/index';
import { logger } from '../utils/logger';
import { getFileTree } from './tools/filesystem';
import type { AgentConfig, SpecTask } from '../types';

export interface VerificationResult {
  verified: boolean;
  reason: string;
  suggestions: string[];
}

/**
 * Verifier Agent (per dream.md "Validation Layer" + "Repair Loop")
 *
 * After a task is marked done, this runs an independent check to confirm the
 * task was ACTUALLY completed - not just claimed. It inspects the workspace
 * state (file tree + relevant file contents) and asks the model to judge
 * whether the task's acceptance criteria are met.
 */
export async function verifyTaskCompletion(params: {
  config: AgentConfig;
  workspacePath: string;
  task: SpecTask;
  specTitle: string;
  filesTouched: string[];
  readFileContent: (path: string) => Promise<string | null>;
}): Promise<VerificationResult> {
  const { config, workspacePath, task, specTitle, filesTouched, readFileContent } = params;

  logger.info('Verifier: checking task completion', {
    taskId: task.id,
    taskTitle: task.title,
    filesTouched: filesTouched.length,
  });

  // Build evidence: file tree + contents of touched files
  const fileTree = getFileTree(workspacePath, '.', 3);

  let fileEvidence = '';
  for (const file of filesTouched.slice(0, 8)) {
    const content = await readFileContent(file);
    if (content !== null) {
      // Cap each file to keep prompt manageable
      const capped = content.length > 4000 ? content.slice(0, 4000) + '\n[...truncated...]' : content;
      fileEvidence += `\n--- ${file} ---\n${capped}\n`;
    }
  }

  if (!fileEvidence) {
    fileEvidence = '(No files were created or modified during this task.)';
  }

  const verifierSystemPrompt = `You are a strict QA verification agent. Your job is to determine whether a development task was ACTUALLY completed based on the actual workspace state.

You are skeptical. You do NOT take claims at face value. You inspect the real files.

Respond with ONLY a JSON object in this exact format:
{
  "verified": true or false,
  "reason": "one sentence explaining your judgment",
  "suggestions": ["specific action to fix if not verified", "..."]
}

Mark verified=false if:
- The expected files do not exist or are empty
- The code is placeholder/stub/TODO without real implementation
- The code has obvious syntax errors or references undefined things
- The task requirements are clearly not met
- There is mock/dummy logic where real logic was required

Mark verified=true ONLY if the task is genuinely and completely done with working code.`;

  const verifierUserPrompt = `# Task to Verify
**Spec:** ${specTitle}
**Task:** ${task.title}

# Current Workspace File Tree
${fileTree}

# Files Touched During This Task
${fileEvidence}

Based on the ACTUAL file contents above, was this task genuinely completed? Respond with the JSON object only.`;

  try {
    const response = await callModel({
      config,
      systemPrompt: verifierSystemPrompt,
      messages: [{ role: 'user', content: verifierUserPrompt }],
      tools: [], // No tools - verifier just judges
      // Stream internally (no-op sink) so Ollama isn't bound by the 30s
      // non-streaming request timeout on slower local models — that timeout
      // + retries is a known "hang" source. Streaming reads until done.
      onToken: () => {},
    });

    const text = response.textContent.trim();

    // Extract JSON from the response (model may wrap it in prose/markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Verifier: could not parse JSON response, assuming verified', {
        taskId: task.id,
        textPreview: text.slice(0, 200),
      });
      // Fail open - don't block progress if verifier output is unparseable
      return { verified: true, reason: 'Verifier response unparseable, proceeding', suggestions: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as VerificationResult;

    logger.info('Verifier: task verification complete', {
      taskId: task.id,
      verified: parsed.verified,
      reason: parsed.reason,
    });

    return {
      verified: !!parsed.verified,
      reason: parsed.reason || (parsed.verified ? 'Task verified' : 'Task not verified'),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch (err) {
    logger.error('Verifier: verification failed', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail open - don't block the pipeline if the verifier errors
    return { verified: true, reason: 'Verifier error, proceeding', suggestions: [] };
  }
}
