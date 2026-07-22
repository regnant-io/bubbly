import { shouldMigrateForPressure, detectModelDowngrade } from './contextMigration';
import type { AgentConfig, Message } from '../types';

function bulkMessages(approxTokens: number): Message[] {
  // One big user message of approxTokens (≈ 4 chars/token).
  return [{ role: 'user', content: 'x'.repeat(approxTokens * 4) }];
}

describe('context migration decisions', () => {
  const smallModel: AgentConfig = { provider: 'ollama', model: 'llama3.1', numCtx: 8192 };
  const bigModel: AgentConfig = { provider: 'claude', model: 'claude-sonnet-4-5' };

  it('triggers pressure migration when history is large for a small model', () => {
    const d = shouldMigrateForPressure({
      config: smallModel,
      systemPrompt: 'sys',
      messages: bulkMessages(6500),
      threshold: 0.85,
    });
    expect(d.migrate).toBe(true);
    expect(d.reason).toBe('context_limit');
  });

  it('does not trigger pressure migration for a small history on a big model', () => {
    const d = shouldMigrateForPressure({
      config: bigModel,
      systemPrompt: 'sys',
      messages: bulkMessages(3000),
    });
    expect(d.migrate).toBe(false);
  });

  it('detects a downgrade when a big-model history will not fit a small model', () => {
    // History sized for a big model (~30k tokens) reopened on an 8k model.
    const d = detectModelDowngrade({
      config: smallModel,
      systemPrompt: 'sys',
      messages: bulkMessages(30_000),
    });
    expect(d.migrate).toBe(true);
    expect(d.reason).toBe('model_downgrade');
  });

  it('does not flag a downgrade when history still fits', () => {
    const d = detectModelDowngrade({
      config: smallModel,
      systemPrompt: 'sys',
      messages: bulkMessages(2000),
    });
    expect(d.migrate).toBe(false);
  });
});
