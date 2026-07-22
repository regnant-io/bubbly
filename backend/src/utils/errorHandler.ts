/**
 * Error Handler Utility
 * 
 * Provides user-friendly error messages with actionable suggestions
 * for common error scenarios.
 */

import { logger } from './logger';

export interface ErrorContext {
  message: string;
  recoverable: boolean;
  suggestions: string[];
}

/**
 * Convert technical errors into user-friendly messages with actionable suggestions
 */
export function getUserFriendlyError(error: Error | unknown, context?: Record<string, unknown>): ErrorContext {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  
  // Log the full technical error
  logger.error('Error occurred', {
    error: errorMessage,
    stack: errorStack,
    context,
  });
  
  // Analyze error and provide user-friendly response
  
  // Network/Connection errors
  if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return {
      message: 'Unable to connect to the service. Please check your network connection and service configuration.',
      recoverable: true,
      suggestions: [
        'Verify your internet connection is working',
        'Check if the service URL is correct in Settings',
        'Ensure the service is running and accessible',
        'Try again in a few moments',
      ],
    };
  }
  
  if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
    return {
      message: 'The request timed out. The service may be slow or unavailable.',
      recoverable: true,
      suggestions: [
        'Check your internet connection speed',
        'Try again - the service may be temporarily slow',
        'If using Ollama, ensure your cloud instance is running',
        'Consider increasing timeout settings if this persists',
      ],
    };
  }
  
  // API Key errors
  if (errorMessage.includes('API key') || errorMessage.includes('authentication') || errorMessage.includes('401')) {
    return {
      message: 'Authentication failed. Your API key may be invalid or expired.',
      recoverable: true,
      suggestions: [
        'Verify your API key in Settings',
        'Check if your API key has expired',
        'Ensure you copied the entire API key without extra spaces',
        'Generate a new API key if needed',
      ],
    };
  }
  
  // Rate limiting
  if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
    return {
      message: 'Rate limit exceeded. Too many requests were sent to the service.',
      recoverable: true,
      suggestions: [
        'Wait a few minutes before trying again',
        'Reduce the frequency of your requests',
        'Check your API usage limits',
        'Consider upgrading your API plan if needed',
      ],
    };
  }
  
  // File system errors
  if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
    return {
      message: 'File or directory not found. The path may be incorrect or the file may have been deleted.',
      recoverable: true,
      suggestions: [
        'Verify the file path is correct',
        'Check if the file still exists',
        'Ensure you have permission to access the file',
        'Try refreshing the file explorer',
      ],
    };
  }
  
  if (errorMessage.includes('EACCES') || errorMessage.includes('permission denied')) {
    return {
      message: 'Permission denied. You do not have access to perform this operation.',
      recoverable: true,
      suggestions: [
        'Check file permissions',
        'Ensure you have write access to the directory',
        'Try running with appropriate permissions',
        'Contact your system administrator if needed',
      ],
    };
  }
  
  if (errorMessage.includes('ENOSPC') || errorMessage.includes('no space')) {
    return {
      message: 'Disk space full. There is not enough space to complete this operation.',
      recoverable: false,
      suggestions: [
        'Free up disk space by deleting unnecessary files',
        'Move files to another drive',
        'Check available disk space',
        'Clean up temporary files',
      ],
    };
  }
  
  // Database errors
  if (errorMessage.includes('database') || errorMessage.includes('sqlite')) {
    return {
      message: 'Database error occurred. The operation could not be completed.',
      recoverable: true,
      suggestions: [
        'Try the operation again',
        'Restart the application if the issue persists',
        'Check database file permissions',
        'Contact support if the problem continues',
      ],
    };
  }
  
  // Model/AI errors
  if ((errorMessage.includes('model') || errorMessage.includes('Model')) && errorMessage.includes('not found')) {
    return {
      message: 'AI model not found. The specified model may not be available.',
      recoverable: true,
      suggestions: [
        'Check the model name in Settings',
        'Verify the model is installed (for Ollama)',
        'Try a different model',
        'Pull the model using: ollama pull <model-name>',
      ],
    };
  }
  
  if (errorMessage.includes('context length') || errorMessage.includes('token limit')) {
    return {
      message: 'Message too long. The conversation has exceeded the model\'s context limit.',
      recoverable: true,
      suggestions: [
        'Start a new conversation',
        'Summarize previous messages',
        'Use a model with a larger context window',
        'Break your request into smaller parts',
      ],
    };
  }
  
  // Workspace errors
  if (errorMessage.includes('workspace') || errorMessage.includes('workspacePath')) {
    return {
      message: 'Workspace path is invalid or not set. Please configure your workspace.',
      recoverable: true,
      suggestions: [
        'Set a valid workspace path in Settings',
        'Ensure the workspace directory exists',
        'Check that you have access to the workspace',
        'Create the workspace directory if needed',
      ],
    };
  }
  
  // Generic fallback
  return {
    message: 'An unexpected error occurred. Please try again or contact support if the issue persists.',
    recoverable: true,
    suggestions: [
      'Try the operation again',
      'Refresh the page',
      'Check the console for more details',
      'Contact support with error details if the problem continues',
    ],
  };
}

/**
 * Send a user-friendly error event via WebSocket
 */
export function sendErrorEvent(
  sendFn: (event: { type: 'error'; message: string; recoverable?: boolean; suggestions?: string[] }) => void,
  error: Error | unknown,
  context?: Record<string, unknown>
): void {
  const errorContext = getUserFriendlyError(error, context);
  
  sendFn({
    type: 'error',
    message: errorContext.message,
    recoverable: errorContext.recoverable,
    suggestions: errorContext.suggestions,
  });
}
