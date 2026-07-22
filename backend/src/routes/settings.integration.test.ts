import request from 'supertest';
import express from 'express';
import { settingsRouter } from './settings';
import { setSetting, getSetting } from '../db/index';

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);

// Mock fetch for API validation tests
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('Settings API - Retry Configuration', () => {
  it('should accept valid retry configuration values', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryMaxAttempts: '3',
        ollamaRetryInitialDelayMs: '500',
        ollamaRetryBackoffMultiplier: '1.5',
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    // Verify values were saved
    expect(getSetting('ollamaRetryMaxAttempts')).toBe('3');
    expect(getSetting('ollamaRetryInitialDelayMs')).toBe('500');
    expect(getSetting('ollamaRetryBackoffMultiplier')).toBe('1.5');
  });

  it('should reject invalid ollamaRetryMaxAttempts (too low)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryMaxAttempts: '0',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryMaxAttempts',
          message: expect.stringContaining('between 1 and 10'),
        }),
      ])
    );
  });

  it('should reject invalid ollamaRetryMaxAttempts (too high)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryMaxAttempts: '11',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryMaxAttempts',
        }),
      ])
    );
  });

  it('should reject invalid ollamaRetryInitialDelayMs (too low)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryInitialDelayMs: '50',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryInitialDelayMs',
        }),
      ])
    );
  });

  it('should reject invalid ollamaRetryInitialDelayMs (too high)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryInitialDelayMs: '6000',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryInitialDelayMs',
        }),
      ])
    );
  });

  it('should reject invalid ollamaRetryBackoffMultiplier (too low)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryBackoffMultiplier: '1.0',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryBackoffMultiplier',
        }),
      ])
    );
  });

  it('should reject invalid ollamaRetryBackoffMultiplier (too high)', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryBackoffMultiplier: '4.0',
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryBackoffMultiplier',
        }),
      ])
    );
  });

  it('should accept multiple valid settings at once', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryMaxAttempts: '7',
        ollamaRetryInitialDelayMs: '2000',
        ollamaRetryBackoffMultiplier: '2.5',
        ollamaModel: 'llama3.1',
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    // Verify all values were saved
    expect(getSetting('ollamaRetryMaxAttempts')).toBe('7');
    expect(getSetting('ollamaRetryInitialDelayMs')).toBe('2000');
    expect(getSetting('ollamaRetryBackoffMultiplier')).toBe('2.5');
    expect(getSetting('ollamaModel')).toBe('llama3.1');
  });

  it('should reject if any setting is invalid in a batch', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({
        ollamaRetryMaxAttempts: '5', // valid
        ollamaRetryInitialDelayMs: '50', // invalid - too low
        ollamaRetryBackoffMultiplier: '2.0', // valid
      });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'ollamaRetryInitialDelayMs',
        }),
      ])
    );
  });

  it('should return default retry values when getting settings', async () => {
    // Reset to defaults
    setSetting('ollamaRetryMaxAttempts', '5');
    setSetting('ollamaRetryInitialDelayMs', '1000');
    setSetting('ollamaRetryBackoffMultiplier', '2');

    const response = await request(app).get('/api/settings');

    expect(response.status).toBe(200);
    expect(response.body.ollamaRetryMaxAttempts).toBe('5');
    expect(response.body.ollamaRetryInitialDelayMs).toBe('1000');
    expect(response.body.ollamaRetryBackoffMultiplier).toBe('2');
  });
});


describe('Settings API - Comprehensive Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Workspace Path Validation', () => {
    it('should reject empty workspace path', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          workspacePath: '',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'workspacePath',
            message: 'Workspace path is required',
          }),
        ])
      );
    });

    it('should reject relative workspace path', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          workspacePath: 'relative/path',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'workspacePath',
            message: 'Workspace path must be an absolute path',
          }),
        ])
      );
    });

    it('should accept valid absolute path', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          workspacePath: '/home/user/project',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('API Key Validation', () => {
    it('should reject invalid API key format', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          anthropicApiKey: 'invalid-key',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'anthropicApiKey',
            message: expect.stringContaining('sk-ant-'),
          }),
        ])
      );
    });

    it('should test API key validity when changed', async () => {
      const mockFetch = jest.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const response = await request(app)
        .put('/api/settings')
        .send({
          anthropicApiKey: 'sk-ant-validkey123456789012345',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should reject invalid API key from API test', async () => {
      const mockFetch = jest.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const response = await request(app)
        .put('/api/settings')
        .send({
          anthropicApiKey: 'sk-ant-invalidkey123456789',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'anthropicApiKey',
            message: expect.stringContaining('invalid'),
          }),
        ])
      );
    });

    it('should allow empty API key', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          anthropicApiKey: '',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('Ollama URL Validation', () => {
    it('should reject empty Ollama URL', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          ollamaBaseUrl: '',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'ollamaBaseUrl',
            message: 'Ollama base URL is required',
          }),
        ])
      );
    });

    it('should reject invalid URL format', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          ollamaBaseUrl: 'not-a-url',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'ollamaBaseUrl',
            message: 'Invalid URL format',
          }),
        ])
      );
    });

    it('should test Ollama connectivity when URL changes', async () => {
      const mockFetch = jest.mocked(fetch);
      mockFetch.mockResolvedValueOnce({
        ok: true,
      } as Response);

      const response = await request(app)
        .put('/api/settings')
        .send({
          ollamaBaseUrl: 'http://newhost:11434',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
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

      const response = await request(app)
        .put('/api/settings')
        .send({
          ollamaBaseUrl: 'http://unreachable:11434',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'ollamaBaseUrl',
            message: expect.stringContaining('Cannot connect'),
          }),
        ])
      );
    });
  });

  describe('Provider and Theme Validation', () => {
    it('should reject invalid provider', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          defaultProvider: 'invalid',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'defaultProvider',
          }),
        ])
      );
    });

    it('should reject invalid theme', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          theme: 'invalid',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'theme',
          }),
        ])
      );
    });

    it('should accept valid provider and theme', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          defaultProvider: 'ollama',
          theme: 'light',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('Boolean Field Validation', () => {
    it('should reject invalid boolean values', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          requireApprovalForWrites: 'yes',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'requireApprovalForWrites',
          }),
        ])
      );
    });

    it('should accept valid boolean values', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          requireApprovalForWrites: 'true',
          requireApprovalForShell: 'false',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('Multiple Validation Errors', () => {
    it('should return all validation errors at once', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          workspacePath: '',
          anthropicApiKey: 'invalid',
          ollamaRetryMaxAttempts: '0',
          theme: 'invalid',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.errors.length).toBeGreaterThanOrEqual(4);
      
      // Check that errors contain field-specific information
      const fields = response.body.errors.map((e: any) => e.field);
      expect(fields).toContain('workspacePath');
      expect(fields).toContain('anthropicApiKey');
      expect(fields).toContain('ollamaRetryMaxAttempts');
      expect(fields).toContain('theme');
    });
  });
});
