import {
  getContextLimit,
  usableInputTokens,
  evaluateContextPressure,
  estimateTextTokens,
} from './contextLimits';

describe('contextLimits registry', () => {
  it('uses Ollama num_ctx as the operative limit', () => {
    const l = getContextLimit({ provider: 'ollama', model: 'llama3.1', numCtx: 8192 });
    expect(l.maxTokens).toBe(8192);
    expect(l.source).toBe('ollama-num-ctx');
  });

  it('falls back to a sane Ollama default when num_ctx is missing', () => {
    const l = getContextLimit({ provider: 'ollama', model: 'qwen2.5-coder' });
    expect(l.maxTokens).toBe(16384);
  });

  it('maps Claude families to a 200k window', () => {
    expect(getContextLimit({ provider: 'claude', model: 'claude-sonnet-4-5' }).maxTokens).toBe(200_000);
    expect(getContextLimit({ provider: 'claude', model: 'claude-3-opus' }).maxTokens).toBe(200_000);
  });

  it('reserves output room in usable input budget', () => {
    const usable = usableInputTokens({ maxTokens: 8192, source: 'ollama-num-ctx' });
    expect(usable).toBeLessThan(8192);
    expect(usable).toBeGreaterThan(1024);
  });

  it('flags migration when input approaches the limit', () => {
    // 8k window: usable ≈ 6553. A history of ~6500 tokens crosses 0.85.
    const big = 'x'.repeat(6500 * 4);
    const pressure = evaluateContextPressure({
      provider: 'ollama',
      model: 'llama3.1',
      numCtx: 8192,
      systemPromptTokens: 200,
      historyTokens: estimateTextTokens(big),
      threshold: 0.85,
    });
    expect(pressure.shouldMigrate).toBe(true);
  });

  it('does not flag migration for a small prompt on a large model', () => {
    const pressure = evaluateContextPressure({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      systemPromptTokens: 500,
      historyTokens: 2000,
    });
    expect(pressure.shouldMigrate).toBe(false);
  });

  it('uses the resolved per-model window as the authoritative Ollama limit', () => {
    // A large cloud model resolves to a 200k window even though num_ctx/ceiling
    // are the small local defaults — the resolved value wins.
    const l = getContextLimit({
      provider: 'ollama',
      model: 'minimax-m3:cloud',
      numCtx: 16384,
      autoNumCtxCeiling: 32768,
      resolvedContextTokens: 200_000,
    });
    expect(l.maxTokens).toBe(200_000);
  });

  it('does not migrate a large-window Ollama model that would overflow a 32k guess', () => {
    // ~40k tokens of history: this WOULD cross the migration line for a 32k
    // window, but the model's real (resolved) window is 200k, so it must not.
    const history = estimateTextTokens('x'.repeat(40_000 * 4));
    const pressure = evaluateContextPressure({
      provider: 'ollama',
      model: 'minimax-m3:cloud',
      numCtx: 16384,
      autoNumCtxCeiling: 32768,
      resolvedContextTokens: 200_000,
      systemPromptTokens: 12_000,
      historyTokens: history,
      threshold: 0.85,
    });
    expect(pressure.shouldMigrate).toBe(false);

    // Sanity: the SAME prompt without the resolved window (old behaviour) would
    // have migrated, which is the bug this fixes.
    const oldBehaviour = evaluateContextPressure({
      provider: 'ollama',
      model: 'minimax-m3:cloud',
      numCtx: 16384,
      autoNumCtxCeiling: 32768,
      systemPromptTokens: 12_000,
      historyTokens: history,
      threshold: 0.85,
    });
    expect(oldBehaviour.shouldMigrate).toBe(true);
  });
});
