import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { sessionsRouter } from './routes/sessions';
import { filesRouter } from './routes/files';
import { settingsRouter } from './routes/settings';
import { mcpRouter } from './routes/mcp';
import { runAgentLoop, resolveApproval, resolveQuestion, stopSession } from './agent/orchestrator';
import { registerPreviewClient, unregisterPreviewClient, setPreviewCapability, resolvePreviewAction } from './agent/tools/previewBridge';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db/index';
import { logger } from './utils/logger';
import { sendErrorEvent } from './utils/errorHandler';
import { terminalManager } from './terminal/terminalManager';
import { initTreeSitter } from './agent/intelligence/treeSitter';
import type { WSClientMessage, WSServerEvent } from './types';

// Initialize DB on startup
getDb();

const app = express();
const server = http.createServer(app);

/**
 * This server can read/write files and run shell commands, so it must never be
 * reachable by arbitrary web pages or LAN peers. Two layers of defense:
 *  1. Bind to loopback only (below) — nothing off-machine can connect.
 *  2. Allow only local origins for CORS and WebSocket upgrades — a malicious
 *     website open in the user's browser can still reach localhost, so we
 *     reject any browser request whose Origin isn't Bubbly itself.
 * Requests with NO origin (curl, Electron main process, same-origin fetches)
 * are allowed — those already run with local user privileges.
 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true; // non-browser or file:// (Electron)
  return LOCAL_ORIGIN_RE.test(origin);
}

app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)),
}));
app.use(express.json({ limit: '50mb' }));

// API routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/files', filesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/mcp', mcpRouter);

// Health check (must be registered before the SPA catch-all below)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

// Serve built frontend in production.
// The desktop shell (Electron) can override the location via BUBBLY_FRONTEND_DIST.
const frontendDist = process.env.BUBBLY_FRONTEND_DIST
  ? path.resolve(process.env.BUBBLY_FRONTEND_DIST)
  : path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// WebSocket server. verifyClient rejects cross-origin browser pages — without
// this, ANY website could open ws://localhost:<port>/ws and drive the agent
// (file writes + shell). Browsers always send Origin on WebSocket upgrades.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }: { origin?: string }) => {
    const ok = isAllowedOrigin(origin);
    if (!ok) logger.warn('Rejected WebSocket upgrade from disallowed origin', { origin });
    return ok;
  },
});

function send(ws: WebSocket, event: WSServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  logger.info('WebSocket client connected', { clientId });

  // Subscribe this connection to interactive terminal output/exit events.
  const offTermOutput = terminalManager.onOutput((terminalId, chunk) => {
    send(ws, { type: 'term_data', terminalId, data: chunk });
  });
  const offTermExit = terminalManager.onExit((terminalId, code) => {
    send(ws, { type: 'term_exit', terminalId, code });
  });
  const offTermInput = terminalManager.onInputRequired((terminalId, detection) => {
    send(ws, {
      type: 'term_input_required',
      terminalId,
      kind: detection.kind,
      prompt: detection.prompt,
      suggestedReply: detection.suggestedReply,
    });
  });

  // Let the agent drive THIS client's live Bubbly Preview webview. Registered
  // per-client so a stale socket closing can never disable a healthy live one.
  registerPreviewClient(clientId, (event) => send(ws, event));

  ws.on('message', async (raw) => {
    let msg: WSClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as WSClientMessage;
    } catch (err) {
      logger.error('Invalid WebSocket message', { error: err instanceof Error ? err.message : String(err) });
      send(ws, { type: 'error', message: 'Invalid JSON message' });
      return;
    }

    logger.debug('WebSocket message received', { type: msg.type });

    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'approve') {
      logger.info('Approval received', { approvalId: msg.approvalId });
      const ok = resolveApproval(msg.approvalId, true);
      if (!ok) {
        logger.warn('Approval not found or expired', { approvalId: msg.approvalId });
        send(ws, { type: 'error', message: `Approval ${msg.approvalId} not found or expired` });
      }
      return;
    }

    if (msg.type === 'reject') {
      logger.info('Rejection received', { approvalId: msg.approvalId });
      const ok = resolveApproval(msg.approvalId, false);
      if (!ok) {
        logger.warn('Approval not found or expired', { approvalId: msg.approvalId });
        send(ws, { type: 'error', message: `Approval ${msg.approvalId} not found or expired` });
      }
      return;
    }

    if (msg.type === 'stop') {
      logger.info('Stop session requested', { sessionId: msg.sessionId });
      stopSession(msg.sessionId);
      return;
    }

    if (msg.type === 'answer') {
      logger.info('User answer received', { questionId: msg.questionId });
      const ok = resolveQuestion(msg.questionId, msg.answer);
      if (!ok) {
        send(ws, { type: 'error', message: `Question ${msg.questionId} not found or expired` });
      }
      return;
    }

    if (msg.type === 'preview_ready') {
      setPreviewCapability(clientId, {
        capable: msg.capable,
        desktop: msg.desktop,
        hasWebview: msg.hasWebview,
        url: msg.url ?? null,
      });
      return;
    }

    if (msg.type === 'preview_result') {
      const ok = resolvePreviewAction(msg.id, { ok: msg.ok, result: msg.result, image: msg.image, url: msg.url, reason: msg.reason });
      if (!ok) logger.warn('Late or unknown preview_result (already resolved/timed out)', { id: msg.id });
      return;
    }

    // --- Interactive terminal sessions (IDE integrated terminal) ---
    if (msg.type === 'term_create') {
      if (!msg.workspacePath || !fs.existsSync(msg.workspacePath)) {
        send(ws, { type: 'error', message: 'Cannot open terminal: workspace path is not set or does not exist.', recoverable: true });
        return;
      }
      const session = terminalManager.create({ workspacePath: msg.workspacePath, title: msg.title, cols: msg.cols, rows: msg.rows });
      send(ws, { type: 'term_created', terminalId: session.id, title: session.title, cwd: session.cwd, clientRef: msg.clientRef });
      // Backfill any banner output that was produced before the listener attached.
      const backfill = terminalManager.getScrollback(session.id);
      if (backfill) send(ws, { type: 'term_data', terminalId: session.id, data: backfill });
      return;
    }

    if (msg.type === 'term_input') {
      terminalManager.write(msg.terminalId, msg.data);
      return;
    }

    if (msg.type === 'term_resize') {
      // Resize the real PTY so the shell wraps/redraws at the client's size.
      terminalManager.resize(msg.terminalId, msg.cols, msg.rows);
      return;
    }

    if (msg.type === 'term_kill') {
      terminalManager.kill(msg.terminalId);
      return;
    }

    if (msg.type === 'chat') {
      if (!msg.workspacePath) {
        logger.error('Chat message missing workspacePath');
        send(ws, { 
          type: 'error', 
          message: 'Workspace path is required. Please set it in Settings.',
          recoverable: true,
          suggestions: [
            'Open Settings and set a valid workspace path',
            'Ensure the path points to your project directory',
            'The workspace path should be an absolute path',
          ],
        });
        return;
      }

      if (!fs.existsSync(msg.workspacePath)) {
        logger.error('Workspace path does not exist', { workspacePath: msg.workspacePath });
        send(ws, {
          type: 'error',
          message: `Workspace path does not exist: ${msg.workspacePath}. Please set a valid path in Settings.`,
          recoverable: true,
          suggestions: [
            'Verify the workspace path is correct',
            'Create the directory if it doesn\'t exist',
            'Check for typos in the path',
            'Ensure you have permission to access the directory',
          ],
        });
        return;
      }

      logger.info('Starting agent loop', { 
        workspacePath: msg.workspacePath,
        sessionId: msg.sessionId,
        messageLength: msg.message.length,
        threadType: msg.threadType,
        specId: msg.specId
      });

      // Run agent loop (non-blocking, streams events back via WebSocket)
      runAgentLoop({
        sessionId: msg.sessionId,
        userMessage: msg.message,
        workspacePath: msg.workspacePath,
        threadType: msg.threadType,
        specId: msg.specId,
        onEvent: (event) => send(ws, event),
      }).catch((err) => {
        logger.error('Agent loop error', { error: err instanceof Error ? err.message : String(err) });
        sendErrorEvent((event) => send(ws, event), err, { sessionId: msg.sessionId });
      });
    }
  });

  ws.on('close', () => {
    logger.info('WebSocket client disconnected', { clientId });
    offTermOutput();
    offTermExit();
    offTermInput();
    unregisterPreviewClient(clientId);
  });

  ws.on('error', (err) => {
    logger.error('WebSocket error', { error: err.message, stack: err.stack });
  });

  // Connection ready - no welcome message to avoid polluting chat
});

// Global error handlers - catch unhandled exceptions and rejections
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
    name: error.name,
  });
  
  // Log but don't crash - allow the server to continue running
  console.error('❌ Uncaught exception:', error.message);
  console.error('   Stack:', error.stack);
  console.error('   Server continues running...\n');
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : undefined;
  
  logger.error('Unhandled promise rejection', {
    reason: errorMessage,
    stack: errorStack,
    promise: String(promise),
  });
  
  // Log but don't crash - allow the server to continue running
  console.error('❌ Unhandled promise rejection:', errorMessage);
  if (errorStack) {
    console.error('   Stack:', errorStack);
  }
  console.error('   Server continues running...\n');
});

// Express error handling middleware - must be after all routes
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Express error handler', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    body: req.body,
  });
  
  // Send user-friendly error response
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred. Please try again or contact support if the issue persists.',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

const PORT = Number(process.env.PORT ?? 3001);
// Loopback-only by default: this process can edit files and run commands, so
// it must not be reachable from the network. Set HOST explicitly (e.g. in a
// trusted container) to override.
const HOST = process.env.HOST ?? '127.0.0.1';

// Clean up long-lived child processes on shutdown so nothing leaks.
function shutdownCleanup(): void {
  try {
    terminalManager.killAll();
  } catch { /* ignore */ }
  try {
    const { backgroundProcesses } = require('./agent/tools/backgroundProcess');
    backgroundProcesses.killAll();
  } catch { /* ignore */ }
  try {
    const { mcpManager } = require('./mcp/manager');
    mcpManager.closeAll();
  } catch { /* ignore */ }
  try {
    const { closeBrowserSession } = require('./agent/tools/browserControl');
    closeBrowserSession();
  } catch { /* ignore */ }
}
process.on('SIGINT', () => { shutdownCleanup(); process.exit(0); });
process.on('SIGTERM', () => { shutdownCleanup(); process.exit(0); });

// How many times to step to the next port when the desired one is occupied.
// This is a DETERMINISTIC fallback (PORT, PORT+1, PORT+2, …) — never a random
// port — so the desktop build stays predictable. PORT=0 (used by nothing now,
// but still valid) binds an OS-assigned port on the first try and never steps.
const MAX_PORT_ATTEMPTS = 10;

function announceReady(): void {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : 'sh';
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;

  logger.info('Bubbly backend started', {
    port: actualPort,
    httpUrl: `http://localhost:${actualPort}`,
    wsUrl: `ws://localhost:${actualPort}/ws`,
    dbPath: '~/.bubbly/bubbly.db',
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    shell,
    isWindows,
  });

  console.log(`\n🫧  Bubbly backend running on http://localhost:${actualPort}`);
  console.log(`   WebSocket: ws://localhost:${actualPort}/ws`);
  console.log(`   DB: ~/.bubbly/bubbly.db`);
  console.log(`   Platform: ${process.platform} (${process.arch})`);
  console.log(`   Shell: ${shell}\n`);

  // Emit a machine-readable ready signal for the desktop shell (Electron).
  // The shell parses this line to learn the actual port to connect to.
  console.log(`BUBBLY_READY {"port":${actualPort}}`);

  // If the parent launched us over an IPC channel, notify it directly too.
  if (typeof process.send === 'function') {
    process.send({ type: 'bubbly-ready', port: actualPort });
  }
}

function listenWithFallback(port: number, attempt = 0): void {
  const onError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
      const next = port + 1;
      logger.warn(`Port ${port} is in use — deterministically trying ${next}`, { attempt });
      server.removeListener('error', onError);
      setTimeout(() => listenWithFallback(next, attempt + 1), 40);
      return;
    }
    logger.error('Bubbly backend could not bind a port', { port, error: err.message });
    // Surface a clear signal to the desktop shell / logs, then exit non-zero.
    console.error(`BUBBLY_PORT_ERROR ${err.code ?? err.message}`);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    announceReady();
  });
}

listenWithFallback(PORT);

// Warm up tree-sitter (WASM runtime + grammars) in the background. Symbol
// extraction is synchronous and on the hot indexing path, so the grammars are
// loaded once here rather than lazily mid-index. Until this resolves, symbol
// extraction transparently uses the heuristic fallback — so a slow or failed
// load delays precision, never startup.
void initTreeSitter();

export { app, server };
