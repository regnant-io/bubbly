# Logger Service

Comprehensive structured logging service for Bubbly backend using Winston with daily file rotation and correlation tracking.

## Features

- ✅ **Structured Logging**: JSON format with timestamp, level, message, and context
- ✅ **Daily File Rotation**: Automatic rotation with 14 days retention
- ✅ **Correlation IDs**: UUID-based request tracking through the entire call chain
- ✅ **Child Loggers**: Context inheritance for hierarchical logging
- ✅ **Multiple Log Levels**: error, warn, info, debug
- ✅ **Environment-Aware**: Pretty console output for dev, JSON for production
- ✅ **Configurable**: Custom log directories, retention, and levels

## Quick Start

```typescript
import { logger } from './utils/logger';

// Basic logging
logger.info('Application started');
logger.warn('Configuration missing', { key: 'API_KEY' });
logger.error('Database connection failed', { error: 'timeout' });
logger.debug('Processing request', { userId: 123 });
```

## Correlation IDs

Track requests across the entire system:

```typescript
import { logger, Logger } from './utils/logger';

// Generate correlation ID at request entry point
const correlationId = Logger.generateCorrelationId();

logger.info('Request received', { 
  correlationId,
  method: 'POST',
  path: '/api/chat' 
});

// Pass through call chain
processRequest(correlationId);

logger.info('Request completed', { correlationId });
```

## Child Loggers

Create loggers with inherited context:

```typescript
// Session-level logger
const sessionLogger = logger.child({ 
  sessionId: 'abc-123',
  correlationId: Logger.generateCorrelationId()
});

sessionLogger.info('Session started', { workspacePath: '/workspace' });

// Tool-level logger (inherits session context)
const toolLogger = sessionLogger.child({ 
  tool: 'write_file',
  iteration: 1 
});

toolLogger.info('File write started', { path: 'src/index.ts' });
// Log includes: sessionId, correlationId, tool, iteration, path
```

## Configuration

### Default Configuration

```typescript
{
  logDir: './logs',
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 14, // 14 days retention
  level: 'info' // or from LOG_LEVEL env var
}
```

### Custom Logger

```typescript
import { createLogger } from './utils/logger';

const customLogger = createLogger(
  {
    logDir: './logs/custom',
    level: 'debug',
    maxFiles: 7,
    maxFileSize: 5 * 1024 * 1024 // 5MB
  },
  { component: 'my-component' }
);
```

### Environment Variables

- `NODE_ENV`: Set to `production` for JSON console output
- `LOG_LEVEL`: Override default log level (error, warn, info, debug)

## Log Levels

| Level | Usage |
|-------|-------|
| **error** | Failures requiring immediate attention (API errors, crashes) |
| **warn** | Recoverable issues (retries, validation failures) |
| **info** | Significant events (session start, tool execution, approvals) |
| **debug** | Detailed diagnostic information (iteration counts, buffer flushes) |

## File Structure

```
logs/
├── .audit.json                    # Rotation audit log
├── bubbly-2026-05-28.log         # Today's log file (JSON)
├── bubbly-2026-05-27.log         # Yesterday's log file
└── ...                            # Older log files (up to 14 days)
```

## Log Format

### Development (Console)
```
2026-05-28 13:39:42 [info]: Session started {
  "sessionId": "abc-123",
  "workspacePath": "/workspace"
}
```

### Production (Console & Files)
```json
{
  "level": "info",
  "message": "Session started",
  "sessionId": "abc-123",
  "workspacePath": "/workspace",
  "timestamp": "2026-05-28 13:39:42"
}
```

## Common Patterns

### Agent Loop Logging

```typescript
const sessionLogger = logger.child({ 
  sessionId,
  correlationId: Logger.generateCorrelationId()
});

sessionLogger.info('Agent loop starting', { workspacePath, messageLength });

for (let iteration = 1; iteration <= maxIterations; iteration++) {
  const iterationLogger = sessionLogger.child({ iteration });
  
  iterationLogger.debug('Iteration started');
  iterationLogger.info('Tool execution', { tool: 'read_file', path });
  iterationLogger.debug('Iteration completed', { tokensUsed, duration });
}

sessionLogger.info('Agent loop completed', { totalIterations, totalTokens });
```

### Error Handling

```typescript
try {
  logger.info('Operation starting', { correlationId });
  await riskyOperation();
  logger.info('Operation succeeded', { correlationId });
} catch (error) {
  logger.error('Operation failed', {
    correlationId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
}
```

### WebSocket Events

```typescript
const wsLogger = logger.child({ sessionId, component: 'websocket' });

wsLogger.info('Connection established', { clientId });
wsLogger.debug('Message sent', { type: 'text_delta', length });
wsLogger.warn('Connection lost', { reason, duration });
```

### Model API Calls

```typescript
const modelLogger = logger.child({ 
  sessionId,
  correlationId,
  component: 'model-api'
});

modelLogger.info('API call starting', { provider, model, messageCount });

try {
  const result = await callModel();
  modelLogger.info('API call succeeded', { duration, tokensUsed });
} catch (error) {
  modelLogger.error('API call failed', { error: error.message, provider });
}
```

## Testing

Run the test file to verify logger functionality:

```bash
npx ts-node src/utils/logger.test.ts
```

Check the `logs/` directory for generated log files.

## Integration Points

The logger should be integrated at these key points:

1. **Agent Orchestrator** (`src/agent/orchestrator.ts`)
   - Agent loop start/end
   - Iteration tracking
   - Tool execution
   - Approval requests

2. **Model Adapters** (`src/models/claude.ts`, `src/models/ollama.ts`)
   - API call start/end
   - Retry attempts
   - Token usage
   - Streaming events

3. **WebSocket Server** (`src/index.ts`)
   - Connection events
   - Message send/receive
   - Error handling

4. **Session Manager** (`src/session/manager.ts`)
   - Session creation
   - Message persistence
   - Thread operations

5. **File Operations** (`src/agent/tools/filesystem.ts`)
   - File read/write/delete
   - Verification attempts
   - Error recovery

## Best Practices

1. **Always use correlation IDs** for request tracking
2. **Create child loggers** for hierarchical context
3. **Log at appropriate levels** (don't overuse error/warn)
4. **Include relevant context** in log messages
5. **Log both start and end** of significant operations
6. **Include duration and metrics** for performance monitoring
7. **Use structured data** instead of string interpolation
8. **Don't log sensitive data** (passwords, tokens, API keys)

## Examples

See `logger.example.ts` for comprehensive usage examples covering:
- Basic logging
- Correlation IDs
- Child loggers
- Agent loop logging
- Error handling
- WebSocket events
- Model API calls
- Custom configuration
- Approval requests
- Performance monitoring
