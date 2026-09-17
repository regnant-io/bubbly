import { supportsVision, openrouterLooksVision } from './capabilities';

/**
 * OpenRouter vision classification.
 *
 * This is the gate that stops an image from being attached to a model that
 * cannot read it. Getting it wrong in the permissive direction is expensive:
 * the request is refused, and the image is already in the conversation when it
 * is, so the refusal repeats for the rest of the thread.
 */
describe('openrouterLooksVision', () => {
  it.each([
    'anthropic/claude-3.5-sonnet',
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-4.1',
    'openai/gpt-4-turbo',
    'google/gemini-2.0-flash-001',
    'google/gemma-3-27b-it',
    'meta-llama/llama-3.2-90b-vision-instruct',
    'mistralai/pixtral-large-2411',
    'qwen/qwen2.5-vl-72b-instruct',
    'x-ai/grok-2-vision-1212',
  ])('classifies %s as multimodal', (slug) => {
    expect(openrouterLooksVision(slug)).toBe(true);
    expect(supportsVision('openrouter', slug)).toBe(true);
  });

  it.each([
    'openai/gpt-3.5-turbo',
    'deepseek/deepseek-r1',
    'mistralai/mistral-7b-instruct',
    'meta-llama/llama-3.1-70b-instruct',
    'qwen/qwen-2.5-coder-32b-instruct',
  ])('classifies %s as text-only', (slug) => {
    expect(openrouterLooksVision(slug)).toBe(false);
    expect(supportsVision('openrouter', slug)).toBe(false);
  });

  it('defaults an unknown slug to text-only', () => {
    // Unknown must mean "no": a false negative costs one explanatory sentence,
    // a false positive costs the thread.
    expect(openrouterLooksVision('some-vendor/brand-new-model')).toBe(false);
    expect(openrouterLooksVision('')).toBe(false);
  });
});

describe('supportsVision', () => {
  it('is unconditionally true for the always-multimodal providers', () => {
    expect(supportsVision('claude', 'anything')).toBe(true);
    expect(supportsVision('gemini', 'anything')).toBe(true);
  });

  it('reads the model name for Ollama', () => {
    expect(supportsVision('ollama', 'llava:13b')).toBe(true);
    expect(supportsVision('ollama', 'codellama:7b')).toBe(false);
  });

  it('says no for a provider it has never heard of', () => {
    expect(supportsVision('some-future-provider', 'gpt-4o')).toBe(false);
  });
});
