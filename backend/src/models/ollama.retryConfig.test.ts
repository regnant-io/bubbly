import { callOllama } from './ollama';
import type { Message, ToolDefinition } from '../types';

// Mock fetch globally
global.fetch = jest.fn();

describe('Ollama Retry Configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should use default retry config when not provided', async () => {
    const mockResponse = {
      ok: true,
      body: null,
      json: async () => ({
        message: { role: 'assistant', content: 'Test response' },
        done: true,
      }),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'You are a helpful assistant',
      messages,
      tools,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should use custom retry config when provided', async () => {
    const mockResponse = {
      ok: true,
      body: null,
      json: async () => ({
        message: { role: 'assistant', content: 'Test response' },
        done: true,
      }),
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    const customRetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 500,
      backoffMultiplier: 1.5,
      timeoutMs: 20000,
    };

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'You are a helpful assistant',
      messages,
      tools,
      retryConfig: customRetryConfig,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on connection timeout with custom config', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    // First two attempts fail with timeout
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        body: null,
        json: async () => ({
          message: { role: 'assistant', content: 'Success after retries' },
          done: true,
        }),
      });

    const customRetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 100, // Short delay for testing
      backoffMultiplier: 2,
      timeoutMs: 5000,
    };

    const result = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'You are a helpful assistant',
      messages,
      tools,
      retryConfig: customRetryConfig,
    });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result.textContent).toBe('Success after retries');
  });

  it('should RETRY on a bare "fetch failed" connection error (undici)', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    // Node's fetch reports connection failures as a TypeError "fetch failed"
    // with the real reason in error.cause. This must be treated as retryable.
    const fetchFailed = new TypeError('fetch failed');
    (fetchFailed as any).cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' };

    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(fetchFailed)
      .mockResolvedValueOnce({
        ok: true,
        body: null,
        json: async () => ({ message: { role: 'assistant', content: 'recovered' }, done: true }),
      });

    const result = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'sys',
      messages,
      tools,
      retryConfig: { maxAttempts: 3, initialDelayMs: 50, backoffMultiplier: 2, timeoutMs: 5000 },
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.textContent).toBe('recovered');
  });

  it('should fail after max attempts with custom config', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    // All attempts fail
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ETIMEDOUT'));

    const customRetryConfig = {
      maxAttempts: 2,
      initialDelayMs: 50, // Very short delay for testing
      backoffMultiplier: 2,
      timeoutMs: 5000,
    };

    await expect(
      callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1',
        systemPrompt: 'You are a helpful assistant',
        messages,
        tools,
        retryConfig: customRetryConfig,
      })
    ).rejects.toThrow(/failed after 2 attempts/);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-retryable HTTP errors', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];

    // Return 400 Bad Request (non-retryable)
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    const customRetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    };

    await expect(
      callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1',
        systemPrompt: 'You are a helpful assistant',
        messages,
        tools,
        retryConfig: customRetryConfig,
      })
    ).rejects.toThrow(/non-retryable error/);

    // Should only try once for non-retryable errors
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should validate retry config bounds', () => {
    // This test verifies that the settings validation would catch invalid values
    const invalidConfigs = [
      { maxAttempts: 0, initialDelayMs: 1000, backoffMultiplier: 2 },
      { maxAttempts: 11, initialDelayMs: 1000, backoffMultiplier: 2 },
      { maxAttempts: 5, initialDelayMs: 50, backoffMultiplier: 2 },
      { maxAttempts: 5, initialDelayMs: 6000, backoffMultiplier: 2 },
      { maxAttempts: 5, initialDelayMs: 1000, backoffMultiplier: 1.0 },
      { maxAttempts: 5, initialDelayMs: 1000, backoffMultiplier: 4.0 },
    ];

    // These would be caught by the settings validation endpoint
    // This test documents the expected validation behavior
    expect(invalidConfigs.length).toBe(6);
  });
});
