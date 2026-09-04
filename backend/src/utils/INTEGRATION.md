# Logger Integration Guide

This guide shows how to integrate the Logger service into existing Bubbly backend components.

## Current Status

✅ Logger is already imported in `src/agent/orchestrator.ts`:
```typescript
import { logger } from '../utils/logger';
```

## Integration Checklist

### 1. Agent Orchestrator (`src/agent/orchestrator.ts`)

**Current**: Logger imported but not fully utilized
**Action**: Add comprehensive logging throughout agent loop

```typescript
import { logger, Logger } from '../utils/logger';

export async function runAgentLoop(params: AgentLoopParams) {
  // Generate correlation ID for this request
  const correlationId = Logger.generateCorrelationId();
  
  // Create session-specific logger
  const sessionLogger = logger.child({
    sessionId: params.sessionId,
    correlationId,
    workspacePath: params.workspacePath
  });

  sessionLogger.info('Agent loop starting', {
    messageLength: params.userMessage.length,
    provider: params.config.provider,
    model: params.config.model
  });

  try {
    // Log each iteration
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const iterationLogger = sessionLogger.child({ iteration });
      
      iterationLogger.debug('Iteration started');
      
      // Log tool execution
      if (toolUse) {
        iterationLogger.info('Tool execution', {
          tool: toolUse.name,
          args: toolUse.input
        });
      }
      
      iterationLogger.debug('Iteration completed', {
        tokensUsed: response.usage?.total_tokens,
        duration: Date.now() - iterationStart
      });
    }

    sessionLogger.info('Agent loop completed', {
      totalIterations: iteration,
      totalTokens: totalTokensUsed,
      duration: Date.now() - loopStart
    });

  } catch (error) {
    sessionLogger.error('Agent loop failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}
```

### 2. Model Adapters

#### Claude (`src/models/claude.ts`)

```typescript
import { logger } from '../utils/logger';

export async function callClaude(params: ModelParams) {
  const modelLogger = logger.child({
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    component: 'model-claude'
  });

  modelLogger.info('Claude API call starting', {
    model: params.model,
    messageCount: params.messages.length,
    maxTokens: params.maxTokens
  });

  const startTime = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
      stream: params.stream
    });

    const duration = Date.now() - startTime;

    modelLogger.info('Claude API call succeeded', {
      duration,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens
    });

    return response;

  } catch (error) {
    modelLogger.error('Claude API call failed', {
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    });
    throw error;
  }
}
```

#### Ollama (`src/models/ollama.ts`)

```typescript
import { logger } from '../utils/logger';

export async function callOllama(params: ModelParams) {
  const modelLogger = logger.child({
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    component: 'model-ollama'
  });

  modelLogger.info('Ollama API call starting', {
    model: params.model,
    messageCount: params.messages.length
  });

  // Log retry attempts
  const onRetry = (attempt: number, delayMs: number, error: string) => {
    modelLogger.warn('Ollama API retry', {
      attempt,
      delayMs,
      error
    });
  };

  try {
    const response = await fetchWithRetry(url, options, retryConfig, onRetry);
    
    modelLogger.info('Ollama API call succeeded', {
      duration: Date.now() - startTime
    });

    return response;

  } catch (error) {
    modelLogger.error('Ollama API call failed after all retries', {
      error: error instanceof Error ? error.message : String(error),
      maxAttempts: retryConfig.maxAttempts
    });
    throw error;
  }
}
```

### 3. WebSocket Server (`src/index.ts`)

```typescript
import { logger } from './utils/logger';

wss.on('connection', (ws: WebSocket) => {
  const clientId = generateClientId();
  const wsLogger = logger.child({ 
    clientId,
    component: 'websocket'
  });

  wsLogger.info('WebSocket connection established');

  ws.on('message', (data: string) => {
    wsLogger.debug('Message received', {
      type: 'incoming',
      length: data.length
    });

    try {
      const message = JSON.parse(data);
      // Handle message...
    } catch (error) {
      wsLogger.error('Failed to parse message', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  ws.on('close', () => {
    wsLogger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    wsLogger.error('WebSocket error', {
      error: error.message
    });
  });
});
```

### 4. Session Manager (`src/session/manager.ts`)

```typescript
import { logger } from '../utils/logger';

export function createSession(params: CreateSessionParams): Session {
  logger.info('Session created', {
    sessionId: params.id,
    workspacePath: params.workspacePath,
    provider: params.provider,
    model: params.model,
    threadType: params.threadType
  });

  // ... create session logic ...

  return session;
}

export function saveMessage(sessionId: string, message: Message): void {
  logger.debug('Message saved', {
    sessionId,
    role: message.role,
    contentLength: message.content.length
  });

  // ... save message logic ...
}

export function deleteThread(sessionId: string): void {
  logger.info('Thread deleted', { sessionId });

  // ... delete logic ...
}
```

### 5. File Operations (`src/agent/tools/filesystem.ts`)

```typescript
import { logger } from '../../utils/logger';

export async function writeFile(
  args: { path: string; content: string },
  workspacePath: string,
  sessionId: string
) {
  const fileLogger = logger.child({
    sessionId,
    tool: 'write_file',
    component: 'filesystem'
  });

  fileLogger.info('File write started', {
    path: args.path,
    size: args.content.length
  });

  try {
    await fs.promises.writeFile(fullPath, args.content, 'utf-8');

    // Verify write (when file verifier is implemented)
    const verification = await verifyFileWrite(fullPath, args.content);

    if (!verification.success) {
      fileLogger.error('File write verification failed', {
        path: args.path,
        attempts: verification.attempts,
        error: verification.error
      });
      throw new Error(`File write failed verification: ${verification.error}`);
    }

    fileLogger.info('File write completed and verified', {
      path: args.path,
      attempts: verification.attempts
    });

    return `File written and verified: ${args.path}`;

  } catch (error) {
    fileLogger.error('File write failed', {
      path: args.path,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
```

### 6. Approval System

```typescript
import { logger } from '../utils/logger';

export async function requestApproval(
  sessionId: string,
  tool: string,
  args: unknown
): Promise<boolean> {
  const approvalId = uuidv4();
  const approvalLogger = logger.child({
    sessionId,
    approvalId,
    component: 'approval'
  });

  approvalLogger.info('Approval request created', {
    tool,
    args
  });

  const startTime = Date.now();

  // Wait for approval...
  const approved = await waitForApproval(approvalId);

  const responseTime = Date.now() - startTime;

  if (approved) {
    approvalLogger.info('Approval granted', { responseTime });
  } else {
    approvalLogger.warn('Approval denied', { responseTime });
  }

  return approved;
}
```

## Environment Configuration

Add to `.env`:

```bash
# Logging configuration
LOG_LEVEL=info          # error, warn, info, debug
NODE_ENV=development    # development or production
```

## Testing Integration

After integrating the logger, test with:

```bash
# Start the backend
npm run dev

# Check logs directory
ls logs/

# View latest log file
tail -f logs/bubbly-$(date +%Y-%m-%d).log

# Or view with pretty formatting (requires jq)
tail -f logs/bubbly-$(date +%Y-%m-%d).log | jq
```

## Monitoring and Debugging

### View logs in real-time

```bash
# All logs
tail -f logs/bubbly-*.log

# Only errors
tail -f logs/bubbly-*.log | grep '"level":"error"'

# Specific session
tail -f logs/bubbly-*.log | grep 'session-abc-123'

# Specific correlation ID
tail -f logs/bubbly-*.log | grep 'correlation-xyz-789'
```

### Search logs

```bash
# Find all errors
grep '"level":"error"' logs/bubbly-*.log

# Find specific tool executions
grep '"tool":"write_file"' logs/bubbly-*.log

# Find slow operations (duration > 5000ms)
grep -E '"duration":[5-9][0-9]{3}' logs/bubbly-*.log
```

## Log Analysis

Use the structured JSON logs for analysis:

```bash
# Count errors by type
cat logs/bubbly-*.log | jq -r 'select(.level=="error") | .error' | sort | uniq -c

# Average API call duration
cat logs/bubbly-*.log | jq -r 'select(.component=="model-claude") | .duration' | awk '{sum+=$1; count++} END {print sum/count}'

# Most used tools
cat logs/bubbly-*.log | jq -r 'select(.tool) | .tool' | sort | uniq -c | sort -rn

# Token usage by session
cat logs/bubbly-*.log | jq -r 'select(.totalTokens) | "\(.sessionId) \(.totalTokens)"' | awk '{sum[$1]+=$2} END {for(s in sum) print s, sum[s]}'
```

## Best Practices

1. **Always create child loggers** for session/request context
2. **Generate correlation IDs** at entry points (HTTP, WebSocket)
3. **Log start and end** of significant operations
4. **Include duration and metrics** for performance tracking
5. **Use appropriate log levels** (don't overuse error/warn)
6. **Don't log sensitive data** (API keys, passwords, tokens)
7. **Include error stacks** for debugging
8. **Use structured context** instead of string interpolation

## Next Steps

1. ✅ Logger service implemented
2. ⏳ Integrate into orchestrator.ts
3. ⏳ Integrate into model adapters
4. ⏳ Integrate into WebSocket server
5. ⏳ Integrate into session manager
6. ⏳ Integrate into file operations
7. ⏳ Add log viewing UI (optional)
8. ⏳ Set up log aggregation (optional)
