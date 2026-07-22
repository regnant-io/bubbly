/**
 * Tests for Error Handler Utility
 */

import { getUserFriendlyError, sendErrorEvent } from './errorHandler';

describe('Error Handler', () => {
  describe('getUserFriendlyError', () => {
    it('should handle connection refused errors', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Unable to connect');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Verify your internet connection is working');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
    
    it('should handle timeout errors', () => {
      const error = new Error('Request timeout after 30000ms');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('timed out');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Check your internet connection speed');
    });
    
    it('should handle authentication errors', () => {
      const error = new Error('Invalid API key provided');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Authentication failed');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Verify your API key in Settings');
    });
    
    it('should handle rate limit errors', () => {
      const error = new Error('Rate limit exceeded: 429');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Rate limit exceeded');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Wait a few minutes before trying again');
    });
    
    it('should handle file not found errors', () => {
      const error = new Error('ENOENT: no such file or directory');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('File or directory not found');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Verify the file path is correct');
    });
    
    it('should handle permission denied errors', () => {
      const error = new Error('EACCES: permission denied');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Permission denied');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Check file permissions');
    });
    
    it('should handle disk space errors', () => {
      const error = new Error('ENOSPC: no space left on device');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Disk space full');
      expect(result.recoverable).toBe(false);
      expect(result.suggestions).toContain('Free up disk space by deleting unnecessary files');
    });
    
    it('should handle database errors', () => {
      const error = new Error('SQLite database is locked');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Database error');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Try the operation again');
    });
    
    it('should handle model not found errors', () => {
      const error = new Error('Model llama3.2 not found');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('AI model not found');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Check the model name in Settings');
    });
    
    it('should handle context length errors', () => {
      const error = new Error('Context length exceeded: token limit reached');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Message too long');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Start a new conversation');
    });
    
    it('should handle workspace errors', () => {
      const error = new Error('Invalid workspacePath provided');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('Workspace path is invalid');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Set a valid workspace path in Settings');
    });
    
    it('should handle generic errors with fallback', () => {
      const error = new Error('Something completely unexpected happened');
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('unexpected error');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions).toContain('Try the operation again');
    });
    
    it('should handle non-Error objects', () => {
      const error = 'String error message';
      const result = getUserFriendlyError(error);
      
      expect(result.message).toContain('unexpected error');
      expect(result.recoverable).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
    
    it('should include context in logs', () => {
      const error = new Error('Test error');
      const context = { sessionId: 'test-123', iteration: 5 };
      
      // Should not throw
      expect(() => getUserFriendlyError(error, context)).not.toThrow();
    });
  });
  
  describe('sendErrorEvent', () => {
    it('should send error event with user-friendly message', () => {
      const mockSend = jest.fn();
      const error = new Error('ECONNREFUSED');
      
      sendErrorEvent(mockSend, error);
      
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Unable to connect'),
          recoverable: true,
          suggestions: expect.arrayContaining([
            expect.stringContaining('internet connection')
          ]),
        })
      );
    });
    
    it('should handle context parameter', () => {
      const mockSend = jest.fn();
      const error = new Error('Test error');
      const context = { sessionId: 'test-456' };
      
      sendErrorEvent(mockSend, error, context);
      
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.any(String),
          recoverable: expect.any(Boolean),
          suggestions: expect.any(Array),
        })
      );
    });
  });
});
