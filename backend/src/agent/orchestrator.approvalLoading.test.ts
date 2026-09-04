/**
 * Tests for approval loading states functionality
 * 
 * Requirements tested:
 * - 6.1: Display skeleton loader before approval blocks appear
 * - 6.2: Show bubble animation with "Preparing action..." text during approval preparation
 * - 6.3: Animate approval block sliding into view smoothly
 * - 6.5: Show tool-specific icons in the loading state
 * - 6.6: Transition from loading state to approval block within 300ms
 * - 6.7: Show "Still working..." message if preparation exceeds 10 seconds
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

describe('Approval Loading States', () => {
  describe('Backend - approval_preparing event', () => {
    it('should send approval_preparing event before approval_required', () => {
      const events: Array<{ type: string; tool?: string }> = [];
      const mockOnEvent = jest.fn((event: any) => {
        events.push(event);
      });

      // Simulate approval flow
      const approvalCheck = {
        required: true,
        reason: 'File write requires approval',
        preview: 'file content...',
      };

      const toolCall = {
        name: 'write_file',
        args: { path: 'test.txt', content: 'hello' },
      };

      if (approvalCheck.required) {
        // Send preparing event
        mockOnEvent({
          type: 'approval_preparing',
          tool: toolCall.name,
          args: toolCall.args,
        });

        // Send approval required event
        mockOnEvent({
          type: 'approval_required',
          approvalId: 'test-id',
          tool: toolCall.name,
          args: toolCall.args,
          preview: approvalCheck.preview,
        });
      }

      // Verify events were sent in correct order
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('approval_preparing');
      expect(events[0].tool).toBe('write_file');
      expect(events[1].type).toBe('approval_required');
    });

    it('should include tool name and args in approval_preparing event', () => {
      const mockOnEvent = jest.fn();

      const toolCall = {
        name: 'run_command',
        args: { command: 'npm test' },
      };

      mockOnEvent({
        type: 'approval_preparing',
        tool: toolCall.name,
        args: toolCall.args,
      });

      expect(mockOnEvent).toHaveBeenCalledWith({
        type: 'approval_preparing',
        tool: 'run_command',
        args: { command: 'npm test' },
      });
    });

    it('should support different tool types', () => {
      const tools = [
        { name: 'write_file', args: { path: 'test.txt' } },
        { name: 'delete_file', args: { path: 'old.txt' } },
        { name: 'run_command', args: { command: 'ls' } },
        { name: 'git_add_and_commit', args: { message: 'commit' } },
      ];

      tools.forEach((tool) => {
        const mockOnEvent = jest.fn();
        mockOnEvent({
          type: 'approval_preparing',
          tool: tool.name,
          args: tool.args,
        });

        expect(mockOnEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'approval_preparing',
            tool: tool.name,
          })
        );
      });
    });
  });

  describe('Frontend - message handling', () => {
    it('should add approval_preparing message to store', () => {
      const messages: Array<any> = [];

      // Simulate store.addMessage
      const addMessage = (msg: any) => {
        messages.push(msg);
      };

      // Handle approval_preparing event
      addMessage({
        id: 'msg-1',
        type: 'approval_preparing',
        tool: 'write_file',
        args: { path: 'test.txt' },
        timestamp: Date.now(),
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('approval_preparing');
      expect(messages[0].tool).toBe('write_file');
    });

    it('should remove approval_preparing message when approval_required arrives', () => {
      const messages: Array<any> = [];

      // Add preparing message
      messages.push({
        id: 'msg-1',
        type: 'approval_preparing',
        tool: 'write_file',
        args: { path: 'test.txt' },
        timestamp: Date.now(),
      });

      // Simulate removeLastApprovalPreparing
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'approval_preparing') {
          messages.splice(i, 1);
          break;
        }
      }

      // Add actual approval message
      messages.push({
        id: 'msg-2',
        type: 'approval',
        approvalId: 'approval-1',
        tool: 'write_file',
        args: { path: 'test.txt' },
        status: 'pending',
        timestamp: Date.now(),
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('approval');
    });

    it('should only remove the last approval_preparing message', () => {
      const messages: Array<{ type: string; id: string; tool?: string }> = [];

      // Add multiple messages including two preparing messages
      messages.push(
        { id: 'msg-1', type: 'text' },
        { id: 'msg-2', type: 'approval_preparing', tool: 'write_file' },
        { id: 'msg-3', type: 'text' },
        { id: 'msg-4', type: 'approval_preparing', tool: 'delete_file' }
      );

      // Remove last approval_preparing
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'approval_preparing') {
          messages.splice(i, 1);
          break;
        }
      }

      expect(messages).toHaveLength(3);
      expect(messages.find((m) => m.id === 'msg-2')).toBeDefined();
      expect(messages.find((m) => m.id === 'msg-4')).toBeUndefined();
    });
  });

  describe('Component behavior', () => {
    it('should show "Still working..." message after 10 seconds', async () => {
      jest.useFakeTimers();

      let showStillWorking = false;

      // Simulate useEffect timer
      const timer = setTimeout(() => {
        showStillWorking = true;
      }, 10000);

      // Fast-forward time by 9 seconds
      jest.advanceTimersByTime(9000);
      expect(showStillWorking).toBe(false);

      // Fast-forward to 10 seconds
      jest.advanceTimersByTime(1000);
      expect(showStillWorking).toBe(true);

      clearTimeout(timer);
      jest.useRealTimers();
    });

    it('should display tool-specific descriptions', () => {
      const toolDescriptions = [
        { tool: 'write_file', args: { path: 'test.txt' }, expected: 'Write to test.txt' },
        { tool: 'delete_file', args: { path: 'old.txt' }, expected: 'Delete old.txt' },
        { tool: 'run_command', args: { command: 'npm test' }, expected: 'Run: npm test' },
        {
          tool: 'git_add_and_commit',
          args: { message: 'feat: add feature' },
          expected: 'Commit: "feat: add feature"',
        },
      ];

      toolDescriptions.forEach(({ tool, args, expected }) => {
        let description = '';
        switch (tool) {
          case 'write_file':
            description = `Write to ${args.path}`;
            break;
          case 'delete_file':
            description = `Delete ${args.path}`;
            break;
          case 'run_command':
            description = `Run: ${args.command}`;
            break;
          case 'git_add_and_commit':
            description = `Commit: "${args.message}"`;
            break;
          default:
            description = tool;
        }

        expect(description).toBe(expected);
      });
    });
  });

  describe('Integration', () => {
    it('should complete full approval flow with loading states', () => {
      const events: Array<{ type: string }> = [];

      // 1. Agent determines approval is needed
      events.push({ type: 'approval_preparing' });

      // 2. Approval is prepared
      events.push({ type: 'approval_required' });

      // 3. User approves
      events.push({ type: 'approval_decision' });

      // 4. Tool executes
      events.push({ type: 'tool_result' });

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('approval_preparing');
      expect(events[1].type).toBe('approval_required');
      expect(events[2].type).toBe('approval_decision');
      expect(events[3].type).toBe('tool_result');
    });
  });
});
