import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { validateSettings } from './settingsValidator';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('settingsValidator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateSettings', () => {
    const currentSettings = {
      workspacePath: '/home/user/project',
      anthropicApiKey: 'sk-ant-existing123456789',
      ollamaBaseUrl: 'http://localhost:11434',
      defaultProvider: 'claude',
      theme: 'dark',
      requireApprovalForWrites: 'true',
      requireApprovalForShell: 'true',
      ollamaEnableThinking: 'false',
      ollamaRetryMaxAttempts: '5',
      ollamaRetryInitialDelayMs: '1000',
      ollamaRetryBackoffMultiplier: '2',
    };

    it('should pass validation for valid settings', async () => {
      const updates = {
        workspacePath: '/home/user/newproject',
        theme: 'light',
      };

      const result = await validateSettings(updates, currentSettings);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    describe('workspace path validation', () => {
      it('should reject empty workspace path', async () => {
        const updates = { workspacePath: '' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'workspacePath',
          message: 'Workspace path is required',
        });
      });

      it('should reject relative paths', async () => {
        const updates = { workspacePath: 'relative/path' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'workspacePath',
          message: 'Workspace path must be an absolute path',
        });
      });

      it('should accept Unix absolute paths', async () => {
        const updates = { workspacePath: '/home/user/project' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
      });

      it('should accept Windows absolute paths', async () => {
        const updates = { workspacePath: 'C:\\Users\\user\\project' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
      });
    });

    describe('API key validation', () => {
      it('should reject invalid API key format', async () => {
        const updates = { anthropicApiKey: 'invalid-key' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'anthropicApiKey',
          message: 'Invalid API key format. Should start with "sk-ant-"',
        });
      });

      it('should reject short API keys', async () => {
        const updates = { anthropicApiKey: 'sk-ant-short' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'anthropicApiKey',
          message: 'Invalid API key format. Should start with "sk-ant-"',
        });
      });

      it('should test API key validity when changed', async () => {
        const mockFetch = jest.mocked(fetch);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
        } as Response);

        const updates = { anthropicApiKey: 'sk-ant-newkey123456789012345' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.anthropic.com/v1/messages',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'x-api-key': 'sk-ant-newkey123456789012345',
            }),
          })
        );
      });

      it('should reject invalid API key from API test', async () => {
        const mockFetch = jest.mocked(fetch);
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
        } as Response);

        const updates = { anthropicApiKey: 'sk-ant-invalidkey123456789' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'anthropicApiKey',
          message: 'API key is invalid or cannot connect to Claude API',
        });
      });

      it('should skip API test if key unchanged', async () => {
        const mockFetch = jest.mocked(fetch);
        const updates = { anthropicApiKey: currentSettings.anthropicApiKey };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should allow empty API key', async () => {
        const updates = { anthropicApiKey: '' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
      });
    });

    describe('Ollama URL validation', () => {
      it('should reject empty Ollama URL', async () => {
        const updates = { ollamaBaseUrl: '' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaBaseUrl',
          message: 'Ollama base URL is required',
        });
      });

      it('should reject invalid URL format', async () => {
        const updates = { ollamaBaseUrl: 'not-a-url' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaBaseUrl',
          message: 'Invalid URL format',
        });
      });

      it('should test Ollama connectivity when URL changes', async () => {
        const mockFetch = jest.mocked(fetch);
        mockFetch.mockResolvedValueOnce({
          ok: true,
        } as Response);

        const updates = { ollamaBaseUrl: 'http://newhost:11434' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://newhost:11434/api/tags',
          expect.objectContaining({
            method: 'GET',
          })
        );
      });

      it('should reject unreachable Ollama URL', async () => {
        const mockFetch = jest.mocked(fetch);
        mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

        const updates = { ollamaBaseUrl: 'http://unreachable:11434' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaBaseUrl',
          message: 'Cannot connect to Ollama at this URL. Make sure Ollama is running.',
        });
      });

      it('should skip connectivity test if URL unchanged', async () => {
        const mockFetch = jest.mocked(fetch);
        const updates = { ollamaBaseUrl: currentSettings.ollamaBaseUrl };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('retry configuration validation', () => {
      it('should reject invalid max attempts', async () => {
        const updates = { ollamaRetryMaxAttempts: '0' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaRetryMaxAttempts',
          message: 'Max retry attempts must be between 1 and 10',
        });
      });

      it('should reject max attempts above limit', async () => {
        const updates = { ollamaRetryMaxAttempts: '11' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
      });

      it('should reject invalid initial delay', async () => {
        const updates = { ollamaRetryInitialDelayMs: '50' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaRetryInitialDelayMs',
          message: 'Initial retry delay must be between 100 and 5000 milliseconds',
        });
      });

      it('should reject invalid backoff multiplier', async () => {
        const updates = { ollamaRetryBackoffMultiplier: '1.0' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'ollamaRetryBackoffMultiplier',
          message: 'Backoff multiplier must be between 1.5 and 3.0',
        });
      });

      it('should accept valid retry configuration', async () => {
        const updates = {
          ollamaRetryMaxAttempts: '3',
          ollamaRetryInitialDelayMs: '500',
          ollamaRetryBackoffMultiplier: '2.5',
        };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
      });
    });

    describe('provider validation', () => {
      it('should reject invalid provider', async () => {
        const updates = { defaultProvider: 'invalid' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'defaultProvider',
          message: 'Provider must be "claude", "ollama", "gemini", or "openrouter"',
        });
      });

      it('should accept valid providers', async () => {
        const updates1 = { defaultProvider: 'claude' };
        const result1 = await validateSettings(updates1, currentSettings);
        expect(result1.valid).toBe(true);

        const updates2 = { defaultProvider: 'ollama' };
        const result2 = await validateSettings(updates2, currentSettings);
        expect(result2.valid).toBe(true);
      });
    });

    describe('theme validation', () => {
      it('should reject invalid theme', async () => {
        const updates = { theme: 'invalid' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'theme',
          message: 'Theme must be "light", "dark", or "system"',
        });
      });

      it('should accept valid themes', async () => {
        for (const theme of ['light', 'dark', 'system']) {
          const updates = { theme };
          const result = await validateSettings(updates, currentSettings);
          expect(result.valid).toBe(true);
        }
      });
    });

    describe('boolean field validation', () => {
      it('should reject invalid boolean values', async () => {
        const updates = { requireApprovalForWrites: 'yes' };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          field: 'requireApprovalForWrites',
          message: 'requireApprovalForWrites must be "true" or "false"',
        });
      });

      it('should accept valid boolean values', async () => {
        const updates = {
          requireApprovalForWrites: 'true',
          requireApprovalForShell: 'false',
          ollamaEnableThinking: 'true',
        };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(true);
      });
    });

    describe('multiple errors', () => {
      it('should return all validation errors', async () => {
        const updates = {
          workspacePath: '',
          anthropicApiKey: 'invalid',
          ollamaRetryMaxAttempts: '0',
          theme: 'invalid',
        };
        const result = await validateSettings(updates, currentSettings);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(4);
      });
    });
  });
});
