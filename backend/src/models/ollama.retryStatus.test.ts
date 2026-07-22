/**
 * Integration test for Ollama retry status updates
 * 
 * Verifies that:
 * - onRetry callback is invoked during retries
 * - Retry status includes attempt number, max attempts, delay, and error
 * - Status updates are sent for each retry attempt
 */

import { callOllama } from './ollama';
import type { Message, ToolDefinition } from '../types';

// Mock fetch globally
global.fetch = jest.fn();

describe('Ollama Retry Status Updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should invoke onRetry callback with correct parameters during retries', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];
    const retryStatuses: Array<{
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }> = [];

    // Mock fetch to fail twice, then succeed
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Hello back!' },
          done: true,
          eval_count: 10,
          prompt_eval_count: 5,
        }),
      });

    const result = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'You are a helpful assistant.',
      messages,
      tools,
      retryConfig: {
        maxAttempts: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        timeoutMs: 1000,
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        retryStatuses.push({ attempt, maxAttempts, delayMs, error });
      },
    });

    // Verify onRetry was called twice (for the two failures)
    expect(retryStatuses.length).toBe(2);

    // Verify first retry status
    expect(retryStatuses[0]).toEqual({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      error: 'ETIMEDOUT',
    });

    // Verify second retry status
    expect(retryStatuses[1]).toEqual({
      attempt: 2,
      maxAttempts: 3,
      delayMs: 200, // 100 * 2^1
      error: 'ECONNREFUSED',
    });

    // Verify the call eventually succeeded
    expect(result.textContent).toBe('Hello back!');
  });

  it('should provide error details in retry status', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    const tools: ToolDefinition[] = [];
    const retryStatuses: Array<{
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }> = [];

    // Mock fetch to fail with specific error, then succeed
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Response' },
          done: true,
        }),
      });

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'System',
      messages,
      tools,
      retryConfig: {
        maxAttempts: 2,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        timeoutMs: 1000,
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        retryStatuses.push({ attempt, maxAttempts, delayMs, error });
      },
    });

    // Verify error message is included in retry status
    expect(retryStatuses.length).toBe(1);
    expect(retryStatuses[0].error).toBe('Connection timeout');
  });

  it('should calculate exponential backoff delays correctly', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    const tools: ToolDefinition[] = [];
    const retryStatuses: Array<{
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }> = [];

    // Mock fetch to fail 4 times with timeout errors, then succeed
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Success' },
          done: true,
        }),
      });

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'System',
      messages,
      tools,
      retryConfig: {
        maxAttempts: 5,
        initialDelayMs: 10, // Use smaller delays for testing
        backoffMultiplier: 2,
        timeoutMs: 5000,
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        retryStatuses.push({ attempt, maxAttempts, delayMs, error });
      },
    });

    // Verify exponential backoff: 10ms, 20ms, 40ms, 80ms
    expect(retryStatuses.length).toBe(4);
    expect(retryStatuses[0].delayMs).toBe(10); // 10 * 2^0
    expect(retryStatuses[1].delayMs).toBe(20); // 10 * 2^1
    expect(retryStatuses[2].delayMs).toBe(40); // 10 * 2^2
    expect(retryStatuses[3].delayMs).toBe(80); // 10 * 2^3
  });

  it('should not invoke onRetry if first attempt succeeds', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const tools: ToolDefinition[] = [];
    const retryStatuses: Array<{
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }> = [];

    // Mock fetch to succeed immediately
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'Success' },
        done: true,
      }),
    });

    await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'System',
      messages,
      tools,
      retryConfig: {
        maxAttempts: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        timeoutMs: 1000,
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        retryStatuses.push({ attempt, maxAttempts, delayMs, error });
      },
    });

    // Verify onRetry was never called
    expect(retryStatuses.length).toBe(0);
  });

  it('should work without onRetry callback (optional parameter)', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Test' }];
    const tools: ToolDefinition[] = [];

    // Mock fetch to fail once with timeout, then succeed
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Response' },
          done: true,
        }),
      });

    // Should not throw even without onRetry callback
    const result = await callOllama({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      systemPrompt: 'System',
      messages,
      tools,
      retryConfig: {
        maxAttempts: 2,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        timeoutMs: 1000,
      },
      // No onRetry callback provided
    });

    expect(result.textContent).toBe('Response');
  });
});
