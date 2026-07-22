/**
 * Conversation Summarizer — produces a compact, structured handoff summary of a
 * long thread so work can continue in a FRESH thread without losing the plot.
 *
 * This is the heart of the "intelligent context system": when a thread nears
 * the model's context limit (or a smaller model takes over a thread authored by
 * a larger one), we summarize everything so far into a dense brief and start a
 * new thread seeded with it. The new thread has a tiny history but full
 * awareness of the goal, decisions, what's done, and what's next.
 *
 * The summary is grounded: it always preserves the ORIGINAL goal verbatim and
 * asks the model to be concrete about file changes and remaining work.
 */

import { callModel } from '../models/index';
import { logger } from '../utils/logger';
import type { AgentConfig, Message } from '../types';

export interface HandoffSummary {
  /** Markdown summary used to seed the new thread. */
  text: string;
  /** Whether it was produced by the model (vs. a deterministic fallback). */
  modelGenerated: boolean;
}

/** Extract the first user message (the goal) as plain text. */
function extractGoal(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '(no goal recorded)';
  if (typeof firstUser.content === 'string') return firstUser.content;
  return firstUser.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Flatten a message into readable text for the summarizer prompt. */
function flatten(message: Message): string {
  if (typeof message.content === 'string') return `${message.role}: ${message.content}`;
  const parts: string[] = [];
  for (const b of message.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'thinking') parts.push(`(reasoning) ${b.thinking}`);
    else if (b.type === 'tool_use') parts.push(`→ called ${b.name}(${JSON.stringify(b.input).slice(0, 300)})`);
    else if (b.type === 'tool_result') parts.push(`← result: ${b.content.slice(0, 400)}`);
  }
  return `${message.role}: ${parts.join('\n')}`;
}

/**
 * Build a deterministic fallback summary from history without a model call.
 * Used if the summarizer model call fails — we must never block migration.
 */
function deterministicSummary(messages: Message[]): string {
  const goal = extractGoal(messages);
  const filesTouched = new Set<string>();
  const toolsUsed = new Map<string, number>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          toolsUsed.set(b.name, (toolsUsed.get(b.name) ?? 0) + 1);
          const p = (b.input as Record<string, unknown>)?.path;
          if (typeof p === 'string') filesTouched.add(p);
        }
      }
    }
  }
  const toolSummary = Array.from(toolsUsed.entries()).map(([t, n]) => `${t}×${n}`).join(', ');
  return [
    `## Continued from a previous thread (auto-summary)`,
    ``,
    `### Original goal`,
    goal,
    ``,
    `### Activity so far`,
    `Tools used: ${toolSummary || 'none'}`,
    `Files touched: ${filesTouched.size > 0 ? Array.from(filesTouched).join(', ') : 'none recorded'}`,
    ``,
    `### Note`,
    `This is a deterministic fallback summary (the summarizer model was unavailable). Inspect the workspace and the spec/task state to confirm what is done before continuing. Do not redo completed work.`,
  ].join('\n');
}

/**
 * Summarize a long conversation into a structured handoff brief.
 */
export async function summarizeConversation(params: {
  config: AgentConfig;
  messages: Message[];
  /** Optional extra context (e.g. spec progress) to fold into the brief. */
  extraContext?: string;
  signal?: AbortSignal;
}): Promise<HandoffSummary> {
  const { config, messages } = params;
  const goal = extractGoal(messages);

  // Keep the transcript we feed the summarizer bounded — the most recent turns
  // carry the most relevant state. The goal is preserved separately/verbatim.
  const transcript = messages.map(flatten).join('\n\n');
  const boundedTranscript = transcript.length > 24_000
    ? transcript.slice(0, 4_000) + '\n\n…[middle elided]…\n\n' + transcript.slice(-16_000)
    : transcript;

  const systemPrompt = `You are a meticulous engineering scribe. You produce a HANDOFF BRIEF so another engineer (or a smaller AI model) can seamlessly continue a long task in a fresh session with NO prior memory.

Write concise, concrete markdown with EXACTLY these sections:

## Goal
Restate the original goal precisely (do not soften or change it).

## Decisions & approach
Key technical decisions made and the approach being followed.

## Work completed
What is actually DONE — name files created/modified and what changed in each. Be specific; this prevents redoing finished work.

## Current state
Where things stand right now, including anything in progress or partially done.

## Next steps
The concrete remaining steps, in order, to finish the goal.

## Gotchas
Constraints, environment notes, failed approaches to avoid, and anything subtle the next engineer must know.

Be dense and factual. No fluff. If something is unknown, say so rather than guessing.`;

  const userPrompt = `Original goal (verbatim):\n${goal}\n\n${params.extraContext ? `Additional state:\n${params.extraContext}\n\n` : ''}Full transcript to summarize:\n\n${boundedTranscript}`;

  try {
    const response = await callModel({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [],
      signal: params.signal,
      // Stream internally so the long summary generation isn't killed by the
      // 30s non-streaming request timeout (+ retries) on local models.
      onToken: () => {},
    });
    const text = response.textContent.trim();
    if (text.length < 40) {
      logger.warn('Summarizer returned too little; using deterministic fallback');
      return { text: deterministicSummary(messages), modelGenerated: false };
    }
    return { text, modelGenerated: true };
  } catch (err) {
    logger.error('Conversation summarization failed; using deterministic fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: deterministicSummary(messages), modelGenerated: false };
  }
}
