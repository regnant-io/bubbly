import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { logger } from '../utils/logger';
import type { Session, Message, DBMessage, ThreadType, ThreadMetadata, PlanStep, SessionChange, ModelProvider } from '../types';

export function createSession(params: {
  workspacePath: string;
  provider: ModelProvider;
  model: string;
  threadType?: ThreadType;
  threadName?: string;
  parentSessionId?: string;
  specId?: string;
}): Session {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const threadType = params.threadType || 'vibe_coding';

  logger.info('Creating new session', {
    sessionId: id,
    workspacePath: params.workspacePath,
    provider: params.provider,
    model: params.model,
    threadType,
    threadName: params.threadName,
    parentSessionId: params.parentSessionId,
    specId: params.specId,
  });

  db.prepare(
    `INSERT INTO sessions (
      id, workspace_path, status, provider, model, 
      thread_type, thread_name, parent_session_id, spec_id,
      created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, 
    params.workspacePath, 
    params.provider, 
    params.model,
    threadType,
    params.threadName ?? null,
    params.parentSessionId ?? null,
    params.specId ?? null,
    now, 
    now
  );

  return {
    id,
    workspacePath: params.workspacePath,
    status: 'active',
    provider: params.provider,
    model: params.model,
    threadType,
    threadName: params.threadName,
    parentSessionId: params.parentSessionId,
    specId: params.specId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Safely parse a nullable JSON text column; returns undefined on empty/invalid. */
function parseJsonColumn<T>(raw: unknown): T | undefined {
  if (raw == null || raw === '') return undefined;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return undefined;
  }
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as Record<string, string> | undefined;
  
  if (!row) {
    logger.debug('Session not found', { sessionId: id });
    return null;
  }
  
  logger.debug('Session retrieved', { sessionId: id, status: row.status });
  
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    status: row.status as Session['status'],
    provider: row.provider as ModelProvider,
    model: row.model,
    threadType: (row.thread_type as ThreadType) || 'chat',
    threadName: row.thread_name || undefined,
    parentSessionId: row.parent_session_id || undefined,
    firstMessage: row.first_message || undefined,
    specId: row.spec_id || undefined,
    plan: parseJsonColumn<PlanStep[]>(row.plan),
    sessionChanges: parseJsonColumn<SessionChange[]>(row.session_changes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSessions(): Session[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50')
    .all() as Record<string, string>[];
  
  logger.debug('Sessions listed', { count: rows.length });
  
  return rows.map((row) => ({
    id: row.id,
    workspacePath: row.workspace_path,
    status: row.status as Session['status'],
    provider: row.provider as ModelProvider,
    model: row.model,
    threadType: (row.thread_type as ThreadType) || 'chat',
    threadName: row.thread_name || undefined,
    parentSessionId: row.parent_session_id || undefined,
    firstMessage: row.first_message || undefined,
    specId: row.spec_id || undefined,
    plan: parseJsonColumn<PlanStep[]>(row.plan),
    sessionChanges: parseJsonColumn<SessionChange[]>(row.session_changes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function updateSessionStatus(id: string, status: Session['status']): void {
  const db = getDb();
  
  logger.info('Session status updated', { sessionId: id, status });
  
  db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    id
  );
}

/**
 * Persist the agent's working plan (update_plan) for a session so the
 * collapsible plan strip can be restored exactly on reopen/refresh.
 */
export function saveSessionPlan(sessionId: string, plan: PlanStep[]): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET plan = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(plan ?? []),
    new Date().toISOString(),
    sessionId
  );
  logger.debug('Session plan saved', { sessionId, steps: plan?.length ?? 0 });
}

/**
 * Record file changes for a session. Each call MERGES the given changes into
 * the persisted list (keyed by path — the latest change to a path wins) so a
 * thread accumulates the full set of files it touched across turns.
 */
export function recordSessionChanges(sessionId: string, changes: SessionChange[]): void {
  if (!changes || changes.length === 0) return;
  const db = getDb();
  const row = db.prepare('SELECT session_changes FROM sessions WHERE id = ?').get(sessionId) as
    | { session_changes: string | null }
    | undefined;
  const existing = parseJsonColumn<SessionChange[]>(row?.session_changes) ?? [];
  const byPath = new Map<string, SessionChange>();
  for (const c of existing) byPath.set(c.path, c);
  for (const c of changes) byPath.set(c.path, c);
  const merged = Array.from(byPath.values());
  db.prepare('UPDATE sessions SET session_changes = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(merged),
    new Date().toISOString(),
    sessionId
  );
  logger.debug('Session changes recorded', { sessionId, total: merged.length });
}

/** Read the persisted working plan for a session (empty array if none). */
export function getSessionPlan(sessionId: string): PlanStep[] {
  const db = getDb();
  const row = db.prepare('SELECT plan FROM sessions WHERE id = ?').get(sessionId) as
    | { plan: string | null }
    | undefined;
  return parseJsonColumn<PlanStep[]>(row?.plan) ?? [];
}

/** Read the persisted file changes for a session (empty array if none). */
export function getSessionChanges(sessionId: string): SessionChange[] {
  const db = getDb();
  const row = db.prepare('SELECT session_changes FROM sessions WHERE id = ?').get(sessionId) as
    | { session_changes: string | null }
    | undefined;
  return parseJsonColumn<SessionChange[]>(row?.session_changes) ?? [];
}

export function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  toolCalls?: unknown
): string {
  const db = getDb();
  const id = uuidv4();

  // Monotonic per-DB sequence guarantees correct ordering even when many
  // messages are written in the same millisecond (critical for tool pairing).
  const nextSeqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages').get() as { next: number };
  const seq = nextSeqRow.next;

  logger.debug('Saving message', {
    sessionId,
    messageId: id,
    role,
    seq,
    contentLength: content.length,
    hasToolCalls: !!toolCalls,
  });

  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, tool_calls, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    seq,
    new Date().toISOString()
  );
  return id;
}

/**
 * Persist a full assistant/user turn, preserving structured content blocks
 * (text + tool_use / tool_result) so the conversation reloads losslessly.
 * This is the memory-safe path the agent loop should use.
 */
export function saveTurn(sessionId: string, message: Message): string {
  if (typeof message.content === 'string') {
    return saveMessage(sessionId, message.role, message.content);
  }
  // Structured content: store the blocks as tool_calls JSON, and keep a plain
  // text projection in `content` for previews/search.
  const textProjection = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return saveMessage(sessionId, message.role, textProjection, message.content);
}

export function getMessages(sessionId: string): Message[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC, created_at ASC')
    .all(sessionId) as DBMessage[];

  logger.debug('Messages retrieved', { sessionId, count: rows.length });

  return rows.map((row) => {
    const toolCalls = (row as unknown as Record<string, string>).tool_calls;
    if (toolCalls) {
      try {
        const parsed = JSON.parse(toolCalls);
        // Structured content blocks were stored — reload them losslessly.
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { role: row.role as 'user' | 'assistant', content: parsed };
        }
      } catch {
        // fall through to plain text
      }
    }
    return { role: row.role as 'user' | 'assistant', content: row.content };
  });
}

/**
 * Get messages with full UI reconstruction data
 * This includes tool calls, tool results, and approval information
 * formatted for frontend consumption
 */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: string; // JSON string of tool calls
  createdAt: string;
}

export function getMessagesForUI(sessionId: string): UIMessage[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC, created_at ASC')
    .all(sessionId) as Array<{
      id: string;
      session_id: string;
      role: string;
      content: string;
      tool_calls: string | null;
      created_at: string;
    }>;

  logger.debug('Messages for UI retrieved', { sessionId, count: rows.length });

  return rows.map((row) => ({
    id: row.id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Get all approvals for a session
 */
export function getApprovals(sessionId: string): Array<{
  id: string;
  tool: string;
  args: string;
  preview?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as Array<{
      id: string;
      session_id: string;
      tool: string;
      args: string;
      preview: string | null;
      status: string;
      created_at: string;
    }>;

  logger.debug('Approvals retrieved', { sessionId, count: rows.length });

  return rows.map((row) => ({
    id: row.id,
    tool: row.tool,
    args: row.args,
    preview: row.preview ?? undefined,
    status: row.status as 'pending' | 'approved' | 'rejected',
    createdAt: row.created_at,
  }));
}

export function logAuditEvent(params: {
  sessionId: string;
  eventType: string;
  tool?: string;
  args?: unknown;
  resultSummary?: string;
  tokensUsed?: number;
}): void {
  const db = getDb();
  const id = uuidv4();
  
  logger.debug('Audit event logged', { 
    sessionId: params.sessionId,
    eventType: params.eventType,
    tool: params.tool,
    tokensUsed: params.tokensUsed
  });
  
  db.prepare(
    `INSERT INTO audit_events (id, session_id, event_type, tool, args, result_summary, tokens_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.sessionId,
    params.eventType,
    params.tool ?? null,
    params.args ? JSON.stringify(params.args) : null,
    params.resultSummary ?? null,
    params.tokensUsed ?? null,
    new Date().toISOString()
  );
}

export function getAuditEvents(sessionId: string): unknown[] {
  const db = getDb();
  const events = db
    .prepare('SELECT * FROM audit_events WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId);
  
  logger.debug('Audit events retrieved', { sessionId, count: events.length });
  
  return events;
}

/**
 * Update the first message preview for a session
 * This is used to show a preview in the thread history
 */
export function updateFirstMessage(sessionId: string, message: string): void {
  const db = getDb();
  const preview = message.slice(0, 100); // First 100 chars
  
  logger.debug('Updating first message preview', { sessionId, previewLength: preview.length });
  
  db.prepare('UPDATE sessions SET first_message = ? WHERE id = ?').run(preview, sessionId);
}

/**
 * Update the thread name for a session
 */
export function updateThreadName(sessionId: string, threadName: string): void {
  const db = getDb();
  
  logger.info('Updating thread name', { sessionId, threadName });
  
  db.prepare('UPDATE sessions SET thread_name = ?, updated_at = ? WHERE id = ?').run(
    threadName,
    new Date().toISOString(),
    sessionId
  );
}

/**
 * Get child threads for a parent session
 */
export function getChildThreads(parentSessionId: string): Session[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC')
    .all(parentSessionId) as Record<string, string>[];
  
  logger.debug('Child threads retrieved', { parentSessionId, count: rows.length });
  
  return rows.map((row) => ({
    id: row.id,
    workspacePath: row.workspace_path,
    status: row.status as Session['status'],
    provider: row.provider as ModelProvider,
    model: row.model,
    threadType: (row.thread_type as ThreadType) || 'chat',
    threadName: row.thread_name || undefined,
    parentSessionId: row.parent_session_id || undefined,
    firstMessage: row.first_message || undefined,
    specId: row.spec_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * List threads with filtering and search capabilities
 */
export function listThreads(filters?: {
  threadType?: ThreadType;
  searchQuery?: string;
  limit?: number;
}): ThreadMetadata[] {
  const db = getDb();
  
  let query = `
    SELECT 
      s.*,
      COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
  `;
  
  const conditions: string[] = [];
  const params: unknown[] = [];
  
  if (filters?.threadType) {
    conditions.push('s.thread_type = ?');
    params.push(filters.threadType);
  }
  
  if (filters?.searchQuery) {
    conditions.push('(s.first_message LIKE ? OR s.thread_name LIKE ?)');
    const searchPattern = `%${filters.searchQuery}%`;
    params.push(searchPattern, searchPattern);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  query += ' GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?';
  params.push(filters?.limit ?? 50);
  
  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  
  logger.debug('Threads listed with filters', { 
    filters, 
    count: rows.length 
  });
  
  return rows.map(row => ({
    id: row.id as string,
    threadType: (row.thread_type as ThreadType) || 'chat',
    specId: (row.spec_id as string) || undefined,
    firstMessage: (row.first_message as string) || '',
    messageCount: row.message_count as number,
    provider: row.provider as ModelProvider,
    model: row.model as string,
    status: row.status as Session['status'],
    threadName: (row.thread_name as string) || undefined,
    parentSessionId: (row.parent_session_id as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Delete a thread and all associated data.
 *
 * Tolerant by design: a thread that was created improperly (e.g. the session
 * row never persisted, or it has orphaned messages/approvals) must still be
 * fully removable. We delete every associated record by session_id regardless
 * of whether the session row itself exists, and never throw on a missing row.
 * Returns the total number of rows removed so callers can report accurately.
 */
export function deleteThread(sessionId: string): number {
  const db = getDb();

  logger.info('Deleting thread', { sessionId });

  let removed = 0;
  const run = (sql: string) => {
    try {
      const info = db.prepare(sql).run(sessionId);
      removed += info.changes ?? 0;
    } catch (err) {
      // A single failing delete (e.g. a table that doesn't exist on an older
      // DB) must not abort the rest of the cleanup.
      logger.warn('deleteThread: partial delete failed (continuing)', {
        sessionId, sql, error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Order matters only when FK constraints are enforced; deleting children
  // first keeps it valid either way.
  run('DELETE FROM audit_events WHERE session_id = ?');
  run('DELETE FROM approvals WHERE session_id = ?');
  run('DELETE FROM messages WHERE session_id = ?');
  run('DELETE FROM sessions WHERE id = ?');

  logger.info('Thread deleted', { sessionId, rowsRemoved: removed });
  return removed;
}

/**
 * Remove orphaned thread data: messages / approvals / audit rows whose
 * session_id no longer points at an existing session row. These accumulate
 * when a thread is created improperly (the session insert failed but children
 * were written, or older bugs left stragglers). Used by "Delete all" to
 * guarantee a clean slate. Returns the number of rows removed.
 */
export function purgeOrphanedThreadData(): number {
  const db = getDb();
  let removed = 0;
  const run = (sql: string) => {
    try {
      const info = db.prepare(sql).run();
      removed += info.changes ?? 0;
    } catch (err) {
      logger.warn('purgeOrphanedThreadData: a sweep failed (continuing)', {
        sql, error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  run('DELETE FROM audit_events WHERE session_id NOT IN (SELECT id FROM sessions)');
  run('DELETE FROM approvals WHERE session_id NOT IN (SELECT id FROM sessions)');
  run('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)');
  if (removed > 0) logger.info('Purged orphaned thread data', { rowsRemoved: removed });
  return removed;
}

/**
 * Search threads by message content (deep search)
 * This searches through all messages, not just the first message preview
 */
export function searchThreadsByContent(
  searchQuery: string,
  filters?: {
    threadType?: ThreadType;
    limit?: number;
  }
): ThreadMetadata[] {
  const db = getDb();
  
  let query = `
    SELECT DISTINCT
      s.*,
      COUNT(DISTINCT m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE m.content LIKE ?
  `;
  
  const params: unknown[] = [`%${searchQuery}%`];
  
  if (filters?.threadType) {
    query += ' AND s.thread_type = ?';
    params.push(filters.threadType);
  }
  
  query += ' GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?';
  params.push(filters?.limit ?? 50);
  
  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  
  logger.debug('Threads searched by content', { 
    searchQuery,
    filters, 
    count: rows.length 
  });
  
  return rows.map(row => ({
    id: row.id as string,
    threadType: (row.thread_type as ThreadType) || 'chat',
    specId: (row.spec_id as string) || undefined,
    firstMessage: (row.first_message as string) || '',
    messageCount: row.message_count as number,
    provider: row.provider as ModelProvider,
    model: row.model as string,
    status: row.status as Session['status'],
    threadName: (row.thread_name as string) || undefined,
    parentSessionId: (row.parent_session_id as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Get thread statistics
 */
export function getThreadStats(): {
  totalThreads: number;
  threadsByType: Record<ThreadType, number>;
  totalMessages: number;
  activeThreads: number;
} {
  const db = getDb();
  
  const totalThreads = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  
  const threadsByType = db.prepare(`
    SELECT thread_type, COUNT(*) as count 
    FROM sessions 
    GROUP BY thread_type
  `).all() as Array<{ thread_type: ThreadType; count: number }>;
  
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  
  const activeThreads = db.prepare(`
    SELECT COUNT(*) as count 
    FROM sessions 
    WHERE status IN ('active', 'running')
  `).get() as { count: number };
  
  const typeMap: Record<ThreadType, number> = {
    vibe_coding: 0,
    spec_session: 0,
  };
  
  threadsByType.forEach(row => {
    typeMap[row.thread_type] = row.count;
  });
  
  logger.debug('Thread statistics retrieved', {
    totalThreads: totalThreads.count,
    totalMessages: totalMessages.count,
    activeThreads: activeThreads.count,
  });
  
  return {
    totalThreads: totalThreads.count,
    threadsByType: typeMap,
    totalMessages: totalMessages.count,
    activeThreads: activeThreads.count,
  };
}

export interface UsageStats {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  /** Last 70 days, oldest first — one entry per calendar day. */
  heatmap: Array<{ date: string; count: number }>;
}

/**
 * Aggregate usage stats for the welcome screen. `range` limits sessions/messages
 * counts to the trailing window (all-time when omitted); the streak/heatmap are
 * always computed over full history since a streak can't be judged from a
 * truncated window.
 */
export function getUsageStats(range?: '7d' | '30d'): UsageStats {
  const db = getDb();
  const since = range === '7d' ? 7 : range === '30d' ? 30 : null;
  const sinceClause = since ? `WHERE created_at >= datetime('now', '-${since} days')` : '';

  const sessions = (db.prepare(`SELECT COUNT(*) as count FROM sessions ${sinceClause}`).get() as { count: number }).count;
  const messages = (db.prepare(`SELECT COUNT(*) as count FROM messages ${sinceClause}`).get() as { count: number }).count;

  const totalTokens = (db.prepare(
    `SELECT COALESCE(SUM(tokens_used), 0) as total FROM audit_events WHERE event_type = 'session_complete' ${since ? `AND created_at >= datetime('now', '-${since} days')` : ''}`
  ).get() as { total: number }).total;

  const favoriteModelRow = db.prepare(
    `SELECT model, COUNT(*) as count FROM sessions WHERE model IS NOT NULL AND model != '' GROUP BY model ORDER BY count DESC LIMIT 1`
  ).get() as { model: string; count: number } | undefined;

  const peakHourRow = db.prepare(
    `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
     FROM messages GROUP BY hour ORDER BY count DESC LIMIT 1`
  ).get() as { hour: number; count: number } | undefined;

  // Distinct active calendar days across sessions + messages, full history.
  const dayRows = db.prepare(`
    SELECT DISTINCT date(created_at) as day FROM (
      SELECT created_at FROM sessions
      UNION ALL
      SELECT created_at FROM messages
    ) ORDER BY day ASC
  `).all() as Array<{ day: string }>;
  const activeDaySet = new Set(dayRows.map((r) => r.day));

  // Streaks: walk backward from today; longest streak scans the sorted day list.
  let currentStreak = 0;
  const cursor = new Date();
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (!activeDaySet.has(key)) break;
    currentStreak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  let longestStreak = 0;
  let running = 0;
  let prevDay: Date | null = null;
  for (const { day } of dayRows) {
    const d = new Date(day + 'T00:00:00Z');
    if (prevDay) {
      const diffDays = Math.round((d.getTime() - prevDay.getTime()) / 86_400_000);
      running = diffDays === 1 ? running + 1 : 1;
    } else {
      running = 1;
    }
    longestStreak = Math.max(longestStreak, running);
    prevDay = d;
  }

  // Heatmap: last 70 days, oldest first, zero-filled for days with no activity.
  const countByDay = new Map<string, number>();
  for (const { day } of dayRows) countByDay.set(day, (countByDay.get(day) ?? 0) + 1);
  const heatmap: Array<{ date: string; count: number }> = [];
  const today = new Date();
  for (let i = 69; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    heatmap.push({ date: key, count: countByDay.get(key) ?? 0 });
  }

  return {
    sessions,
    messages,
    totalTokens,
    activeDays: activeDaySet.size,
    currentStreak,
    longestStreak,
    peakHour: peakHourRow ? peakHourRow.hour : null,
    favoriteModel: favoriteModelRow ? favoriteModelRow.model : null,
    heatmap,
  };
}

/**
 * Update the spec_id for a session
 * This is used when a spec is created in a Spec Session thread
 */
export function updateSessionSpecId(sessionId: string, specId: string): void {
  const db = getDb();
  
  logger.info('Updating session spec_id', { sessionId, specId });
  
  db.prepare('UPDATE sessions SET spec_id = ?, updated_at = ? WHERE id = ?').run(
    specId,
    new Date().toISOString(),
    sessionId
  );
  
  logger.info('Session spec_id updated successfully', { sessionId, specId });
}

/**
 * Check if a session has any messages (to prevent thread type changes)
 */
export function sessionHasMessages(sessionId: string): boolean {
  const db = getDb();

  const result = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number };

  const hasMessages = result.count > 0;

  logger.debug('Session message check', { sessionId, hasMessages, messageCount: result.count });

  return hasMessages;
}