/**
 * Integration test for error recovery in orchestrator
 * 
 * This test verifies that:
 * 1. Model API failures are retried up to 3 times
 * 2. Tool execution failures are caught and reported with suggestions
 * 3. The agent loop continues after errors instead of crashing
 * 4. Appropriate error messages and suggestions are provided
 */

import { runAgentLoop } from './orchestrator';
import { setSetting } from '../db/index';
import type { WSServerEvent } from '../types';

// The retry tests below exercise the REAL backoff (the loop sleeps ~1s between
// model attempts), so a full 3-retry path can comfortably exceed Jest's 5s
// default once the machine is busy — which made this suite fail intermittently
// in full runs while passing in isolation. Give it room to actually finish.
jest.setTimeout(30_000);

// Mock the model call to simulate failures
jest.mock('../models/index', () => ({
  callModel: jest.fn(),
}));

// Mock the tools
jest.mock('./tools/index', () => ({
  TOOL_DEFINITIONS: [
    { name: 'write_file', description: 'Write a file', input_schema: {} },
    { name: 'read_file', description: 'Read a file', input_schema: {} },
    { name: 'run_command', description: 'Run a command', input_schema: {} },
  ],
  executeTool: jest.fn(),
  checkRequiresApproval: jest.fn(() => ({ required: false, autoDecline: false })),
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
  updateSessionSpecId: jest.fn(),
}));

// Mock spec tools
jest.mock('./tools/specs', () => ({
  lockSpecToSession: jest.fn(),
  getNextTask: jest.fn(),
  updateTaskStatus: jest.fn(),
  areAllTasksComplete: jest.fn(),
  updateSpec: jest.fn(),
}));

describe('Orchestrator - Error Recovery', () => {
  const { callModel } = require('../models/index');
  const { executeTool } = require('./tools/index');

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set default settings
    setSetting('defaultProvider', 'ollama');
    setSetting('ollamaModel', 'llama3.1');
    setSetting('ollamaBaseUrl', 'http://localhost:11434');
    setSetting('requireApprovalForWrites', 'false');
    setSetting('requireApprovalForShell', 'false');
  });

  describe('Model API Retry Logic', () => {
    it('should retry model API calls up to 3 times on failure', async () => {
      const events: WSServerEvent[] = [];
      let callCount = 0;
      
      // Mock to fail 2 times, then succeed
      callModel.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Network timeout');
        }
        return {
          textContent: 'Success after retries',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      });

      await runAgentLoop({
        userMessage: 'Test retry',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have called model 3 times (2 failures + 1 success)
      expect(callModel).toHaveBeenCalledTimes(3);
      
      // Should have status events for retries
      const statusEvents = events.filter(e => e.type === 'status' && e.content?.includes('Retrying'));
      expect(statusEvents.length).toBeGreaterThan(0);
    });

    it('should fail after 3 retry attempts on first iteration', async () => {
      const events: WSServerEvent[] = [];
      
      // Mock to always fail
      callModel.mockRejectedValue(new Error('API key invalid'));

      await runAgentLoop({
        userMessage: 'Test failure',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have called model 4 times (initial + 3 retries)
      expect(callModel).toHaveBeenCalledTimes(4);
      
      // Should have an error event with user-friendly message
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
      // The error handler converts "API key invalid" to a user-friendly message
      expect(errorEvents[0].message).toContain('Authentication failed');
    }, 15000); // Increase timeout to 15 seconds

    it('should continue with conversation after model failure on later iterations', async () => {
      const events: WSServerEvent[] = [];
      let callCount = 0;
      
      // First call succeeds with tool call, second call fails 3 times then succeeds
      callModel.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            textContent: 'Let me write a file',
            toolCalls: [
              { id: 'tool-1', name: 'write_file', args: { path: 'test.txt', content: 'hello' } }
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        // Second through fourth calls fail
        if (callCount >= 2 && callCount <= 4) {
          throw new Error('Model unavailable');
        }
        // Fifth call succeeds
        return {
          textContent: 'Recovered from error',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      });

      executeTool.mockResolvedValue({ result: 'File written successfully' });

      await runAgentLoop({
        userMessage: 'Write a test file',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have attempted model call 5 times (1 success + 3 failures + 1 success)
      expect(callModel).toHaveBeenCalledTimes(5);
      
      // Should have status event about retrying
      const retryEvents = events.filter(e => 
        e.type === 'status' && e.content?.includes('Retrying')
      );
      expect(retryEvents.length).toBeGreaterThan(0);
    }, 15000); // 15 seconds should be enough for 3 retries
  });

  describe('Tool Execution Error Recovery', () => {
    it('should catch tool execution errors and continue', async () => {
      const events: WSServerEvent[] = [];
      
      callModel.mockResolvedValueOnce({
        textContent: 'Let me write a file',
        toolCalls: [
          { id: 'tool-1', name: 'write_file', args: { path: 'test.txt', content: 'hello' } }
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }).mockResolvedValueOnce({
        textContent: 'I see the error, let me try a different approach',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      // Tool execution fails
      executeTool.mockRejectedValue(new Error('Permission denied'));

      await runAgentLoop({
        userMessage: 'Write a test file',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have called model twice (initial + recovery)
      expect(callModel).toHaveBeenCalledTimes(2);
      
      // Should have tool_result event with error
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents[0].result).toContain('Tool execution failed');
      
      // Should have status event about tool failure
      const statusEvents = events.filter(e => 
        e.type === 'status' && e.content?.includes('Tool execution failed')
      );
      expect(statusEvents.length).toBeGreaterThan(0);
    });

    it('should provide specific suggestions for file operation errors', async () => {
      const events: WSServerEvent[] = [];
      
      callModel.mockResolvedValueOnce({
        textContent: 'Let me read the file',
        toolCalls: [
          { id: 'tool-1', name: 'read_file', args: { path: 'missing.txt' } }
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }).mockResolvedValueOnce({
        textContent: 'File not found',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      executeTool.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      await runAgentLoop({
        userMessage: 'Read the file',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have tool_result with file-specific suggestions
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents[0].result).toContain('file path is correct');
      expect(toolResultEvents[0].result).toContain('workspace root');
    });

    it('should provide specific suggestions for command execution errors', async () => {
      const events: WSServerEvent[] = [];
      
      callModel.mockResolvedValueOnce({
        textContent: 'Let me run the command',
        toolCalls: [
          { id: 'tool-1', name: 'run_command', args: { command: 'invalid-cmd' } }
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }).mockResolvedValueOnce({
        textContent: 'Command not found',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      executeTool.mockRejectedValue(new Error('Command not found'));

      await runAgentLoop({
        userMessage: 'Run the command',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have tool_result with command-specific suggestions
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents[0].result).toContain('command is available');
      expect(toolResultEvents[0].result).toContain('command syntax');
    }, 10000); // Increase timeout to 10 seconds

    it('should provide specific suggestions for git operation errors', async () => {
      const events: WSServerEvent[] = [];
      
      callModel.mockResolvedValueOnce({
        textContent: 'Let me commit the changes',
        toolCalls: [
          { id: 'tool-1', name: 'git_commit', args: { message: 'test' } }
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }).mockResolvedValueOnce({
        textContent: 'Git error',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      executeTool.mockRejectedValue(new Error('Not a git repository'));

      await runAgentLoop({
        userMessage: 'Commit changes',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have tool_result with git-specific suggestions
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents[0].result).toContain('git repository');
      expect(toolResultEvents[0].result).toContain('git is installed');
    }, 10000); // Increase timeout to 10 seconds

    it('should handle multiple tool failures in sequence', async () => {
      const events: WSServerEvent[] = [];
      
      callModel.mockResolvedValueOnce({
        textContent: 'Let me try multiple operations',
        toolCalls: [
          { id: 'tool-1', name: 'write_file', args: { path: 'test1.txt', content: 'hello' } },
          { id: 'tool-2', name: 'write_file', args: { path: 'test2.txt', content: 'world' } },
          { id: 'tool-3', name: 'read_file', args: { path: 'test3.txt' } }
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }).mockResolvedValueOnce({
        textContent: 'All operations had errors',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      // All tools fail
      executeTool.mockRejectedValue(new Error('Operation failed'));

      await runAgentLoop({
        userMessage: 'Do multiple operations',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have 3 tool_result events with errors
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(3);
      toolResultEvents.forEach(event => {
        expect(event.result).toContain('Tool execution failed');
      });
      
      // Should have called model twice (initial + recovery)
      expect(callModel).toHaveBeenCalledTimes(2);
    });
  });

  describe('Combined Error Scenarios', () => {
    it('should handle both model and tool errors in same session', async () => {
      const events: WSServerEvent[] = [];
      let modelCallCount = 0;
      
      callModel.mockImplementation(async () => {
        modelCallCount++;
        
        // First call succeeds with tool
        if (modelCallCount === 1) {
          return {
            textContent: 'Let me write a file',
            toolCalls: [
              { id: 'tool-1', name: 'write_file', args: { path: 'test.txt', content: 'hello' } }
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        
        // Second call fails once then succeeds
        if (modelCallCount === 2) {
          throw new Error('Temporary model error');
        }
        
        return {
          textContent: 'Recovered from errors',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      });

      // Tool fails
      executeTool.mockRejectedValue(new Error('Tool error'));

      await runAgentLoop({
        userMessage: 'Test combined errors',
        workspacePath: '/test/workspace',
        onEvent: (event) => events.push(event),
      });

      // Should have recovered from both errors
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(0); // No fatal errors
      
      const statusEvents = events.filter(e => e.type === 'status');
      expect(statusEvents.length).toBeGreaterThan(0);
    });
  });
});
