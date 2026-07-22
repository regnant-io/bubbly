/**
 * Integration test for Ollama retry configuration in orchestrator
 * 
 * This test verifies that:
 * 1. Retry configuration is read from settings
 * 2. Configuration is passed to the Ollama model
 * 3. Retry events are emitted to the frontend
 */

import { runAgentLoop } from './orchestrator';
import { getAllSettings, setSetting } from '../db/index';
import type { WSServerEvent } from '../types';

// Mock the model call to simulate retries
jest.mock('../models/index', () => ({
  callModel: jest.fn(),
  StreamBuffer: jest.requireActual('../models/streamBuffer').StreamBuffer,
}));

// Mock the tools
jest.mock('./tools/index', () => ({
  TOOL_DEFINITIONS: [],
  executeTool: jest.fn(),
  checkRequiresApproval: jest.fn(() => false),
}));

// Mock the steering loader
jest.mock('../steering/loader', () => ({
  loadSteeringContext: jest.fn(() => ''),
  loadReadme: jest.fn(() => ''),
  detectProjectType: jest.fn(() => 'node'),
}));

// Mock session manager
jest.mock('../session/manager', () => ({
  createSession: jest.fn(() => ({ id: 'test-session-id' })),
  updateSessionStatus: jest.fn(),
  saveMessage: jest.fn(),
  saveTurn: jest.fn(),
  getMessages: jest.fn(() => []),
  logAuditEvent: jest.fn(),
  updateFirstMessage: jest.fn(),
  getSession: jest.fn(() => null),
}));

describe('Orchestrator - Ollama Retry Configuration', () => {
  const { callModel } = require('../models/index');

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set default settings
    setSetting('defaultProvider', 'ollama');
    setSetting('ollamaModel', 'llama3.1');
    setSetting('ollamaBaseUrl', 'http://localhost:11434');
    setSetting('ollamaRetryMaxAttempts', '3');
    setSetting('ollamaRetryInitialDelayMs', '500');
    setSetting('ollamaRetryBackoffMultiplier', '2.5');
    setSetting('requireApprovalForWrites', 'false');
    setSetting('requireApprovalForShell', 'false');
  });

  it('should read retry configuration from settings and pass to callModel', async () => {
    const events: WSServerEvent[] = [];
    
    // Mock successful response
    callModel.mockResolvedValueOnce({
      textContent: 'Hello!',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await runAgentLoop({
      userMessage: 'Hello',
      workspacePath: '/test/workspace',
      onEvent: (event) => events.push(event),
    });

    // Verify callModel was called with retry config from settings
    expect(callModel).toHaveBeenCalledWith(
      expect.objectContaining({
        ollamaRetryConfig: {
          maxAttempts: 3,
          initialDelayMs: 500,
          backoffMultiplier: 2.5,
          timeoutMs: 300000,
        },
      })
    );
  });

  it('should emit retry events when Ollama retries occur', async () => {
    const events: WSServerEvent[] = [];
    
    // Mock callModel to trigger retry callback
    callModel.mockImplementationOnce(async (params: any) => {
      // Simulate 2 retries
      if (params.onOllamaRetry) {
        params.onOllamaRetry(1, 3, 500, 'ETIMEDOUT');
        params.onOllamaRetry(2, 3, 1250, 'ECONNREFUSED');
      }
      
      return {
        textContent: 'Success after retries',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });

    await runAgentLoop({
      userMessage: 'Test retry events',
      workspacePath: '/test/workspace',
      onEvent: (event) => events.push(event),
    });

    // Verify retry events were emitted
    const retryEvents = events.filter(e => e.type === 'ollama_retry');
    expect(retryEvents).toHaveLength(2);
    
    expect(retryEvents[0]).toEqual({
      type: 'ollama_retry',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      error: 'ETIMEDOUT',
    });
    
    expect(retryEvents[1]).toEqual({
      type: 'ollama_retry',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1250,
      error: 'ECONNREFUSED',
    });
  });

  it('should use default retry config when settings are missing', async () => {
    const events: WSServerEvent[] = [];
    
    // Remove retry settings to test defaults
    setSetting('ollamaRetryMaxAttempts', '');
    setSetting('ollamaRetryInitialDelayMs', '');
    setSetting('ollamaRetryBackoffMultiplier', '');
    
    callModel.mockResolvedValueOnce({
      textContent: 'Hello!',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await runAgentLoop({
      userMessage: 'Hello',
      workspacePath: '/test/workspace',
      onEvent: (event) => events.push(event),
    });

    // Verify callModel was called with default retry config
    expect(callModel).toHaveBeenCalledWith(
      expect.objectContaining({
        ollamaRetryConfig: {
          maxAttempts: 5, // default
          initialDelayMs: 1000, // default
          backoffMultiplier: 2, // default
          timeoutMs: 300000,
        },
      })
    );
  });

  it('should not pass retry config when using Claude provider', async () => {
    const events: WSServerEvent[] = [];
    
    // Switch to Claude provider
    setSetting('defaultProvider', 'claude');
    setSetting('claudeModel', 'claude-sonnet-4-5');
    setSetting('anthropicApiKey', 'sk-ant-test-key');
    
    callModel.mockResolvedValueOnce({
      textContent: 'Hello from Claude!',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await runAgentLoop({
      userMessage: 'Hello',
      workspacePath: '/test/workspace',
      onEvent: (event) => events.push(event),
    });

    // Verify callModel was called without retry config (undefined for Claude)
    expect(callModel).toHaveBeenCalledWith(
      expect.objectContaining({
        ollamaRetryConfig: undefined,
      })
    );
  });
});
