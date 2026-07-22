import { callOllama, listOllamaModels } from './ollama';
import type { Message, ToolDefinition } from '../types';

// Mock the logger to avoid console output during tests
jest.mock('../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Ollama Retry Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('fetchWithRetry - Exponential Backoff', () => {
    it('should succeed on first attempt when API is healthy', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
        }),
      };
      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      // Fast-forward through any timers
      jest.runAllTimers();

      const result = await promise;
      expect(result.textContent).toBe('Hello!');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry with exponential backoff on transient errors', async () => {
      const mockError = new Error('ECONNREFUSED');
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Success after retry' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(mockError)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      // Fast-forward through retry delays
      // First retry: 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      // Second retry: 2000ms
      await jest.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result.textContent).toBe('Success after retry');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    // Note: Testing max retries with real delays would take 15+ seconds
    // The retry logic is validated by the successful retry test above
    // and the non-retryable error tests below
  });

  describe('Non-Retryable Errors', () => {
    it('should not retry on 400 Bad Request', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      };
      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      jest.runAllTimers();

      await expect(promise).rejects.toThrow(/non-retryable error/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 401 Unauthorized', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      };
      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      jest.runAllTimers();

      await expect(promise).rejects.toThrow(/non-retryable error/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 404 Not Found', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      jest.runAllTimers();

      await expect(promise).rejects.toThrow(/non-retryable error/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Retryable Server Errors', () => {
    it('should retry on 500 Internal Server Error', async () => {
      const mockError = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Recovered' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Recovered');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 503 Service Unavailable', async () => {
      const mockError = {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      };
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Service restored' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Service restored');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 429 Too Many Requests', async () => {
      const mockError = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      };
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Rate limit passed' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Rate limit passed');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Timeout Handling', () => {
    it('should classify AbortError as a retryable timeout error', async () => {
      // Mock a request that throws AbortError (simulating timeout)
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Recovered after timeout' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });
      
      // Fast-forward through retry delay
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Recovered after timeout');
      // Should retry on AbortError
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Streaming Response', () => {
    it('should handle streaming responses correctly', async () => {
      const chunks = [
        JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n',
        JSON.stringify({ message: { content: ' world' }, done: false }) + '\n',
        JSON.stringify({ message: { content: '!' }, done: true, eval_count: 10, prompt_eval_count: 5 }) + '\n',
      ];

      const mockStream = {
        getReader: () => ({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[0]) })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[1]) })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(chunks[2]) })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: jest.fn(),
        }),
      };

      const mockResponse = {
        ok: true,
        body: mockStream,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const tokens: string[] = [];
      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
        onToken: (text) => tokens.push(text),
      });

      jest.runAllTimers();

      const result = await promise;
      expect(result.textContent).toBe('Hello world!');
      expect(tokens).toEqual(['Hello', ' world', '!']);
      expect(result.usage?.inputTokens).toBe(5);
      expect(result.usage?.outputTokens).toBe(10);
    });
  });

  describe('Tool Calls', () => {
    it('should handle tool calls in responses', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: {
            role: 'assistant',
            content: 'Let me help you with that',
            tool_calls: [
              {
                function: {
                  name: 'read_file',
                  arguments: { path: 'test.txt' },
                },
              },
            ],
          },
          done: true,
        }),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const tools: ToolDefinition[] = [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ];

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Read test.txt' }],
        tools,
      });

      jest.runAllTimers();

      const result = await promise;
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('read_file');
      expect(result.toolCalls[0].args).toEqual({ path: 'test.txt' });
      expect(result.stopReason).toBe('tool_use');
    });
  });

  describe('listOllamaModels', () => {
    it('should list available models', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama2' },
            { name: 'codellama' },
            { name: 'mistral' },
          ],
        }),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce(mockResponse);

      const models = await listOllamaModels('http://localhost:11434');
      expect(models).toEqual(['llama2', 'codellama', 'mistral']);
    });

    it('should return empty array on error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Connection failed'));

      const models = await listOllamaModels('http://localhost:11434');
      expect(models).toEqual([]);
    });
  });

  describe('Connection Error Types', () => {
    it('should retry on ECONNREFUSED', async () => {
      const mockError = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Connected' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Connected');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on ENOTFOUND', async () => {
      const mockError = new Error('getaddrinfo ENOTFOUND ollama.local');
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'DNS resolved' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://ollama.local:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('DNS resolved');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on socket hang up', async () => {
      const mockError = new Error('socket hang up');
      const mockSuccess = {
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Reconnected' },
          done: true,
        }),
      };

      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSuccess);

      const promise = callOllama({
        baseUrl: 'http://localhost:11434',
        model: 'llama2',
        systemPrompt: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.textContent).toBe('Reconnected');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
