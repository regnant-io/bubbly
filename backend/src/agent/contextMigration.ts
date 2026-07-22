/**
 * Context Migration — the "intelligent context system".
 *
 * Ties together the context-limit registry, the conversation summarizer, and
 * session creation to do two things automatically:
 *
 *  1. AUTO-MIGRATE ON CONTEXT PRESSURE. When a thread's prompt approaches the
 *     active model's operative context limit, we summarize the conversation
 *     into a handoff brief, open a NEW thread (child of the current one) seeded
 *     with that brief, and continue work there. The user never hits a hard
 *     overflow and the loop never "breaks".
 *
 *  2. HANDLE MODEL DOWNGRADE. If a thread's history was built by a large-context
 *     model and a smaller-context model later takes over, the existing history
 *     may not even fit. We detect this on resume: if it fits, we let it run; if
 *     it doesn't, we force a summarize + migrate so the small model starts clean.
 */

import { logger } from '../utils/logger';
import { createSession, saveMessage, saveTurn, getSession } from '../session/manager';
import { summarizeConversation } from './conversationSummarizer';
import { estimateTotalTokens } from './contextManager';
import {
  evaluateContextPressure,
  estimateTextTokens,
  getContextLimit,
  usableInputTokens,
} from './contextLimits';
import type { AgentConfig, Message, ThreadType } from '../types';

export interface MigrationDecision {
  migrate: boolean;
  reason?: 'context_limit' | 'model_downgrade';
  ratio?: number;
  usableInputTokens?: number;
  estimatedInputTokens?: number;
}

/**
 * Decide whether the current thread should migrate to a fresh one due to
 * context pressure under the active model.
 */
export function shouldMigrateForPressure(params: {
  config: AgentConfig;
  systemPrompt: string;
  messages: Message[];
  threshold?: number;
}): MigrationDecision {
  const pressure = evaluateContextPressure({
    provider: params.config.provider,
    model: params.config.model,
    numCtx: params.config.numCtx,
    autoNumCtxCeiling: params.config.autoNumCtxCeiling,
    resolvedContextTokens: params.config.resolvedContextTokens,
    systemPromptTokens: estimateTextTokens(params.systemPrompt),
    historyTokens: estimateTotalTokens(params.messages),
    threshold: params.threshold,
  });
  return {
    migrate: pressure.shouldMigrate,
    reason: pressure.shouldMigrate ? 'context_limit' : undefined,
    ratio: pressure.ratio,
    usableInputTokens: pressure.usableInputTokens,
    estimatedInputTokens: pressure.estimatedInputTokens,
  };
}

/**
 * On resume: does the existing history fit the (possibly smaller) active
 * model's window? If a large-context thread is reopened with a small model and
 * the history no longer fits the usable input budget, we must migrate.
 */
export function detectModelDowngrade(params: {
  config: AgentConfig;
  systemPrompt: string;
  messages: Message[];
}): MigrationDecision {
  const limit = getContextLimit({
    provider: params.config.provider,
    model: params.config.model,
    numCtx: params.config.numCtx,
    autoNumCtxCeiling: params.config.autoNumCtxCeiling,
    resolvedContextTokens: params.config.resolvedContextTokens,
  });
  const usable = usableInputTokens(limit);
  const estimated = estimateTextTokens(params.systemPrompt) + estimateTotalTokens(params.messages);
  // Use a slightly higher bar than steady-state pressure: only force a downgrade
  // migration if the history genuinely won't fit comfortably (>95% of usable).
  const migrate = estimated > usable * 0.95;
  return {
    migrate,
    reason: migrate ? 'model_downgrade' : undefined,
    ratio: estimated / usable,
    usableInputTokens: usable,
    estimatedInputTokens: estimated,
  };
}

export interface MigrationResult {
  newSessionId: string;
  summary: string;
  /** The seeded messages array to continue the loop with in the new thread. */
  seedMessages: Message[];
}

/**
 * Perform a migration: summarize the conversation, create a child thread, seed
 * it with the handoff brief, and return the new session id + seed history.
 *
 * The new thread inherits workspace, thread type, provider/model, and spec id
 * from the parent, and links back via parentSessionId.
 */
export async function migrateToFreshThread(params: {
  config: AgentConfig;
  parentSessionId: string;
  workspacePath: string;
  threadType?: ThreadType;
  specId?: string;
  messages: Message[];
  reason: 'context_limit' | 'model_downgrade';
  extraContext?: string;
  signal?: AbortSignal;
}): Promise<MigrationResult> {
  logger.info('Migrating thread due to context pressure', {
    parentSessionId: params.parentSessionId,
    reason: params.reason,
    messageCount: params.messages.length,
  });

  const summary = await summarizeConversation({
    config: params.config,
    messages: params.messages,
    extraContext: params.extraContext,
    signal: params.signal,
  });

  const parent = getSession(params.parentSessionId);
  const child = createSession({
    workspacePath: params.workspacePath,
    provider: params.config.provider,
    model: params.config.model,
    threadType: params.threadType ?? parent?.threadType,
    threadName: parent?.threadName ? `${parent.threadName} (cont.)` : undefined,
    parentSessionId: params.parentSessionId,
    specId: params.specId ?? parent?.specId,
  });

  // Seed the new thread's persisted history with a single user message holding
  // the handoff brief. This is what the model sees as the "start" of the new
  // thread, so it continues coherently with a tiny, fresh context.
  const seedText =
    `# Continuing previous work (context handoff)\n\n` +
    `The prior thread reached the model's context limit and was summarized. ` +
    `Continue from this brief — the workspace already reflects completed work, so do NOT redo it.\n\n` +
    summary.text;

  saveMessage(child.id, 'user', seedText);

  const seedMessages: Message[] = [{ role: 'user', content: seedText }];

  logger.info('Thread migration complete', {
    parentSessionId: params.parentSessionId,
    newSessionId: child.id,
    modelGenerated: summary.modelGenerated,
    reason: params.reason,
  });

  return { newSessionId: child.id, summary: summary.text, seedMessages };
}
