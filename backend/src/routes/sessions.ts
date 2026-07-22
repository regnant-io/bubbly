import { Router } from 'express';
import {
  listSessions,
  getSession,
  getAuditEvents,
  listThreads,
  deleteThread,
  purgeOrphanedThreadData,
  getMessages,
  getMessagesForUI,
  getApprovals,
  createSession,
  updateThreadName,
  getUsageStats
} from '../session/manager';
import { listSpecs } from '../agent/tools/specs';
import { logger } from '../utils/logger';
import type { ThreadType, ModelProvider } from '../types';

export const sessionsRouter = Router();

sessionsRouter.get('/', (_req, res) => {
  logger.info('Listing sessions');
  const sessions = listSessions();
  res.json(sessions);
});

/**
 * GET /api/sessions/stats?range=7d|30d
 * Usage stats for the welcome screen (sessions/messages/tokens/streaks/heatmap).
 * Omit `range` for all-time counts.
 */
sessionsRouter.get('/stats', (req, res) => {
  const range = req.query.range as '7d' | '30d' | undefined;
  if (range && range !== '7d' && range !== '30d') {
    return res.status(400).json({ error: 'range must be "7d" or "30d"' });
  }
  const stats = getUsageStats(range);
  res.json(stats);
});

// Thread management endpoints - must come before /:id routes to avoid conflicts

/**
 * GET /api/sessions/threads
 * List threads with optional filtering
 * Query params:
 *   - threadType: 'vibe_coding' | 'spec_session'
 *   - search: search query for thread name or first message
 *   - limit: max number of threads to return (default: 50)
 */
sessionsRouter.get('/threads', (req, res) => {
  const threadType = req.query.threadType as ThreadType | undefined;
  const searchQuery = req.query.search as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  
  logger.info('Listing threads', { threadType, searchQuery, limit });
  
  // Validate threadType if provided
  if (threadType && !['vibe_coding', 'spec_session'].includes(threadType)) {
    logger.warn('Invalid thread type', { threadType });
    return res.status(400).json({ error: 'Invalid thread type. Must be vibe_coding or spec_session' });
  }
  
  // Validate limit if provided
  if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 100)) {
    logger.warn('Invalid limit', { limit });
    return res.status(400).json({ error: 'Invalid limit. Must be between 1 and 100' });
  }
  
  try {
    const threads = listThreads({
      threadType,
      searchQuery,
      limit
    });
    
    logger.info('Threads listed successfully', { count: threads.length });
    res.json(threads);
  } catch (err) {
    logger.error('Failed to list threads', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

/**
 * GET /api/sessions/specs
 * List all available specs from the workspace
 * Query params:
 *   - workspacePath: string (required)
 */
sessionsRouter.get('/specs', (req, res) => {
  const workspacePath = req.query.workspacePath as string | undefined;
  
  logger.info('Listing specs', { workspacePath });
  
  if (!workspacePath || typeof workspacePath !== 'string') {
    logger.warn('Missing or invalid workspacePath');
    return res.status(400).json({ error: 'workspacePath is required and must be a string' });
  }
  
  try {
    const specs = listSpecs(workspacePath);
    logger.info('Specs listed successfully', { count: specs.length });
    res.json(specs);
  } catch (err) {
    logger.error('Failed to list specs', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    res.status(500).json({ error: 'Failed to list specs' });
  }
});

/**
 * GET /api/sessions/:id/messages
 * Get all messages and approvals for a specific thread
 * Returns data formatted for UI reconstruction
 */
sessionsRouter.get('/:id/messages', (req, res) => {
  const sessionId = req.params.id;
  logger.info('Getting messages for thread', { sessionId });
  
  try {
    // First check if session exists
    const session = getSession(sessionId);
    if (!session) {
      logger.warn('Session not found', { sessionId });
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const messages = getMessagesForUI(sessionId);
    const approvals = getApprovals(sessionId);
    
    logger.info('Messages and approvals retrieved successfully', { 
      sessionId, 
      messageCount: messages.length,
      approvalCount: approvals.length
    });
    
    // Include persisted thread metadata so the UI can restore the agent plan
    // strip and the session's file-change list on reload/refresh.
    res.json({
      messages,
      approvals,
      plan: session.plan ?? [],
      sessionChanges: session.sessionChanges ?? [],
    });
  } catch (err) {
    logger.error('Failed to get messages', { 
      sessionId,
      error: err instanceof Error ? err.message : String(err) 
    });
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * POST /api/sessions
 * Create a new thread/session
 * Body:
 *   - workspacePath: string (required)
 *   - provider: 'claude' | 'ollama' (required)
 *   - model: string (required)
 *   - threadType: 'vibe_coding' | 'spec_session' (optional, default: 'vibe_coding')
 *   - threadName: string (optional)
 *   - parentSessionId: string (optional)
 *   - specId: string (optional)
 */
sessionsRouter.post('/', (req, res) => {
  const { workspacePath, provider, model, threadType, threadName, parentSessionId, specId } = req.body;
  
  logger.info('Creating new session', { 
    workspacePath, 
    provider, 
    model, 
    threadType,
    threadName,
    parentSessionId,
    specId
  });
  
  // Validate required fields
  if (!workspacePath || typeof workspacePath !== 'string') {
    logger.warn('Missing or invalid workspacePath');
    return res.status(400).json({ error: 'workspacePath is required and must be a string' });
  }
  
  if (!provider || !['claude', 'ollama', 'gemini'].includes(provider)) {
    logger.warn('Missing or invalid provider', { provider });
    return res.status(400).json({ error: 'provider is required and must be claude, ollama, or gemini' });
  }
  
  if (!model || typeof model !== 'string') {
    logger.warn('Missing or invalid model');
    return res.status(400).json({ error: 'model is required and must be a string' });
  }
  
  // Validate optional fields
  if (threadType && !['vibe_coding', 'spec_session'].includes(threadType)) {
    logger.warn('Invalid thread type', { threadType });
    return res.status(400).json({ error: 'threadType must be vibe_coding or spec_session' });
  }
  
  if (threadName && typeof threadName !== 'string') {
    logger.warn('Invalid thread name type');
    return res.status(400).json({ error: 'threadName must be a string' });
  }
  
  if (parentSessionId && typeof parentSessionId !== 'string') {
    logger.warn('Invalid parent session ID type');
    return res.status(400).json({ error: 'parentSessionId must be a string' });
  }
  
  if (specId && typeof specId !== 'string') {
    logger.warn('Invalid spec ID type');
    return res.status(400).json({ error: 'specId must be a string' });
  }
  
  try {
    const session = createSession({
      workspacePath,
      provider: provider as ModelProvider,
      model,
      threadType: threadType as ThreadType,
      threadName,
      parentSessionId,
      specId
    });
    
    logger.info('Session created successfully', { sessionId: session.id });
    res.status(201).json(session);
  } catch (err) {
    logger.error('Failed to create session', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * PATCH /api/sessions/:id
 * Update a thread (currently supports updating thread name)
 * Body:
 *   - threadName: string (optional)
 */
sessionsRouter.patch('/:id', (req, res) => {
  const sessionId = req.params.id;
  const { threadName } = req.body;
  
  logger.info('Updating session', { sessionId, threadName });
  
  // Check if session exists
  const session = getSession(sessionId);
  if (!session) {
    logger.warn('Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Validate threadName if provided
  if (threadName !== undefined && typeof threadName !== 'string') {
    logger.warn('Invalid thread name type');
    return res.status(400).json({ error: 'threadName must be a string' });
  }
  
  try {
    if (threadName !== undefined) {
      updateThreadName(sessionId, threadName);
    }
    
    // Get updated session
    const updatedSession = getSession(sessionId);
    
    logger.info('Session updated successfully', { sessionId });
    res.json(updatedSession);
  } catch (err) {
    logger.error('Failed to update session', { 
      sessionId,
      error: err instanceof Error ? err.message : String(err) 
    });
    res.status(500).json({ error: 'Failed to update session' });
  }
});

/**
 * DELETE /api/sessions
 * Delete all threads — including any improperly-created / orphaned ones.
 */
sessionsRouter.delete('/', (_req, res) => {
  logger.info('Deleting all threads');

  try {
    // Delete every known thread first.
    const threads = listThreads({ limit: 100 });
    let totalRows = 0;
    for (const thread of threads) {
      totalRows += deleteThread(thread.id);
    }

    // Sweep up any orphaned rows that aren't attached to a listable session
    // (half-created threads, rows left by older bugs). This guarantees a clean
    // slate so "Delete all" never leaves stragglers behind.
    totalRows += purgeOrphanedThreadData();

    logger.info('All threads deleted', { count: threads.length, totalRows });
    res.json({ success: true, message: `Deleted ${threads.length} threads` });
  } catch (err) {
    logger.error('Failed to delete all threads', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to delete all threads' });
  }
});

/**
 * DELETE /api/sessions/:id
 * Delete a thread and all associated data. Tolerant of improperly-created
 * threads: if the session row is missing we still purge any orphaned
 * messages/approvals/audit rows for that id, and report success.
 */
sessionsRouter.delete('/:id', (req, res) => {
  const sessionId = req.params.id;
  logger.info('Deleting thread', { sessionId });

  try {
    const rowsRemoved = deleteThread(sessionId);
    logger.info('Thread deleted', { sessionId, rowsRemoved });
    res.json({ success: true, message: 'Thread deleted', rowsRemoved });
  } catch (err) {
    logger.error('Failed to delete thread', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// Routes with :id parameter - must come after specific routes like /threads and /:id/messages

sessionsRouter.get('/:id/audit', (req, res) => {
  const sessionId = req.params.id;
  logger.info('Getting audit events', { sessionId });
  
  const events = getAuditEvents(sessionId);
  res.json(events);
});

sessionsRouter.get('/:id', (req, res) => {
  const sessionId = req.params.id;
  logger.info('Getting session', { sessionId });
  
  const session = getSession(sessionId);
  if (!session) {
    logger.warn('Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }
  return res.json(session);
});
