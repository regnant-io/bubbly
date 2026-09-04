/**
 * Logger Service Usage Examples
 * 
 * This file demonstrates how to use the Logger service throughout the application.
 */

import { logger, Logger, createLogger } from './logger';

// ============================================================================
// Example 1: Basic Logging
// ============================================================================

export function basicLoggingExample() {
  // Use the global logger instance for simple logging
  logger.info('Application started');
  logger.warn('Configuration file not found, using defaults');
  logger.error('Failed to connect to database', { 
    error: 'Connection timeout',
    retries: 3 
  });
  logger.debug('Processing request', { 
    method: 'POST',
    path: '/api/sessions' 
  });
}

// ============================================================================
// Example 2: Correlation IDs for Request Tracking
// ============================================================================

export function correlationIdExample() {
  // Generate a correlation ID at the start of a request
  const correlationId = Logger.generateCorrelationId();
  
  logger.info('Request received', { 
    correlationId,
    method: 'POST',
    path: '/api/chat' 
  });
  
  // Pass correlation ID through the call chain
  processRequest(correlationId);
  
  logger.info('Request completed', { 
    correlationId,
    duration: 1234 
  });
}

function processRequest(correlationId: string) {
  logger.debug('Processing business logic', { correlationId });
  // ... business logic ...
}

// ============================================================================
// Example 3: Child Loggers with Context Inheritance
// ============================================================================

export function childLoggerExample() {
  // Create a session-specific logger
  const sessionId = 'session-abc-123';
  const sessionLogger = logger.child({ 
    sessionId,
    correlationId: Logger.generateCorrelationId()
  });
  
  // All logs from this logger will include sessionId and correlationId
  sessionLogger.info('Session started', { 
    workspacePath: '/path/to/workspace',
    provider: 'claude',
    model: 'claude-3-5-sonnet-20241022'
  });
  
  // Create a tool-specific logger from the session logger
  const toolLogger = sessionLogger.child({ 
    tool: 'write_file',
    iteration: 1 
  });
  
  // This log will include sessionId, correlationId, tool, and iteration
  toolLogger.info('File write started', { 
    path: 'src/index.ts',
    size: 1024 
  });
  
  toolLogger.info('File write completed', { 
    path: 'src/index.ts',
    success: true 
  });
}

// ============================================================================
// Example 4: Agent Loop Logging
// ============================================================================

export function agentLoopExample() {
  const sessionId = 'session-xyz-789';
  const correlationId = Logger.generateCorrelationId();
  
  // Create session logger
  const sessionLogger = logger.child({ sessionId, correlationId });
  
  sessionLogger.info('Agent loop starting', {
    workspacePath: '/workspace',
    messageLength: 150,
    provider: 'claude'
  });
  
  // Log each iteration
  for (let iteration = 1; iteration <= 3; iteration++) {
    const iterationLogger = sessionLogger.child({ iteration });
    
    iterationLogger.debug('Iteration started');
    
    // Log tool execution
    iterationLogger.info('Tool execution', {
      tool: 'read_file',
      args: { path: 'src/config.ts' }
    });
    
    iterationLogger.debug('Iteration completed', {
      tokensUsed: 1500,
      duration: 2300
    });
  }
  
  sessionLogger.info('Agent loop completed', {
    totalIterations: 3,
    totalTokens: 4500,
    duration: 7200
  });
}

// ============================================================================
// Example 5: Error Handling and Recovery
// ============================================================================

export async function errorHandlingExample() {
  const correlationId = Logger.generateCorrelationId();
  
  try {
    logger.info('Starting risky operation', { correlationId });
    
    // Simulate an operation that might fail
    await riskyOperation();
    
    logger.info('Operation succeeded', { correlationId });
    
  } catch (error) {
    logger.error('Operation failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Log retry attempt
    logger.warn('Retrying operation', { 
      correlationId,
      attempt: 2,
      delayMs: 1000 
    });
  }
}

async function riskyOperation() {
  // Simulated operation
  throw new Error('Connection timeout');
}

// ============================================================================
// Example 6: WebSocket Event Logging
// ============================================================================

export function websocketEventExample() {
  const sessionId = 'session-123';
  const wsLogger = logger.child({ sessionId, component: 'websocket' });
  
  wsLogger.info('WebSocket connection established', {
    clientId: 'client-456'
  });
  
  wsLogger.debug('Message sent', {
    type: 'text_delta',
    length: 50
  });
  
  wsLogger.debug('Message received', {
    type: 'user_message',
    length: 200
  });
  
  wsLogger.warn('WebSocket connection lost', {
    reason: 'Client disconnected',
    duration: 12345
  });
}

// ============================================================================
// Example 7: Model API Call Logging
// ============================================================================

export async function modelApiCallExample() {
  const sessionId = 'session-789';
  const correlationId = Logger.generateCorrelationId();
  const modelLogger = logger.child({ 
    sessionId,
    correlationId,
    component: 'model-api'
  });
  
  modelLogger.info('API call starting', {
    provider: 'claude',
    model: 'claude-3-5-sonnet-20241022',
    messageCount: 5
  });
  
  try {
    // Simulate API call
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const duration = Date.now() - startTime;
    
    modelLogger.info('API call succeeded', {
      duration,
      tokensUsed: 2500,
      responseLength: 1500
    });
    
  } catch (error) {
    modelLogger.error('API call failed', {
      error: error instanceof Error ? error.message : String(error),
      provider: 'claude'
    });
  }
}

// ============================================================================
// Example 8: Custom Logger Configuration
// ============================================================================

export function customLoggerExample() {
  // Create a logger with custom configuration for a specific component
  const customLogger = createLogger(
    {
      logDir: './logs/custom-component',
      level: 'debug',
      maxFiles: 7, // Keep logs for 7 days
      maxFileSize: 5 * 1024 * 1024 // 5MB per file
    },
    {
      component: 'custom-component',
      version: '1.0.0'
    }
  );
  
  customLogger.debug('Custom component initialized');
  customLogger.info('Processing data', { records: 100 });
}

// ============================================================================
// Example 9: Approval Request Logging
// ============================================================================

export function approvalRequestExample() {
  const sessionId = 'session-456';
  const correlationId = Logger.generateCorrelationId();
  const approvalLogger = logger.child({ 
    sessionId,
    correlationId,
    component: 'approval'
  });
  
  approvalLogger.info('Approval request created', {
    tool: 'write_file',
    path: 'src/important.ts',
    approvalId: 'approval-123'
  });
  
  approvalLogger.info('Approval granted', {
    approvalId: 'approval-123',
    responseTime: 5000
  });
  
  approvalLogger.debug('Tool execution after approval', {
    approvalId: 'approval-123',
    tool: 'write_file'
  });
}

// ============================================================================
// Example 10: Performance Monitoring
// ============================================================================

export function performanceMonitoringExample() {
  const correlationId = Logger.generateCorrelationId();
  const perfLogger = logger.child({ correlationId, component: 'performance' });
  
  const startTime = Date.now();
  
  perfLogger.debug('Operation started', { operation: 'file-scan' });
  
  // Simulate operation
  const filesScanned = 1000;
  
  const duration = Date.now() - startTime;
  
  perfLogger.info('Operation completed', {
    operation: 'file-scan',
    duration,
    filesScanned,
    filesPerSecond: Math.round(filesScanned / (duration / 1000))
  });
  
  // Log warning if operation is slow
  if (duration > 5000) {
    perfLogger.warn('Slow operation detected', {
      operation: 'file-scan',
      duration,
      threshold: 5000
    });
  }
}
