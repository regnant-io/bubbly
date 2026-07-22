import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createSession,
  getSession,
  updateFirstMessage,
  updateThreadName,
  getChildThreads,
  listThreads,
  deleteThread,
  searchThreadsByContent,
  getThreadStats,
} from './manager';

// Mock the database module
let testDb: Database.Database;
let testDbPath: string;

jest.mock('../db/index', () => ({
  getDb: () => testDb,
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Session Manager - Thread Management', () => {
  beforeEach(() => {
    // Create a temporary test database
    testDbPath = path.join(os.tmpdir(), `test-session-${Date.now()}.db`);
    testDb = new Database(testDbPath);
    testDb.pragma('foreign_keys = ON');

    // Initialize schema with thread management columns
    testDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        status TEXT DEFAULT 'idle',
        provider TEXT DEFAULT 'claude',
        model TEXT NOT NULL,
        thread_type TEXT DEFAULT 'vibe_coding',
        thread_name TEXT,
        parent_session_id TEXT REFERENCES sessions(id),
        first_message TEXT,
        spec_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        seq INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        preview TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool TEXT,
        args TEXT,
        result_summary TEXT,
        tokens_used INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_messages_session ON messages(session_id);
      CREATE INDEX idx_approvals_session ON approvals(session_id);
      CREATE INDEX idx_audit_session ON audit_events(session_id);
      CREATE INDEX idx_sessions_thread_type ON sessions(thread_type);
      CREATE INDEX idx_sessions_parent_id ON sessions(parent_session_id);
      CREATE INDEX idx_sessions_spec_id ON sessions(spec_id);
      CREATE INDEX idx_sessions_type_updated ON sessions(thread_type, updated_at DESC);
    `);
  });

  afterEach(() => {
    testDb.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('createSession', () => {
    it('should create a session with default thread type', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      });

      expect(session.id).toBeDefined();
      expect(session.threadType).toBe('vibe_coding');
      expect(session.workspacePath).toBe('/test/workspace');
      expect(session.provider).toBe('claude');
      expect(session.model).toBe('claude-sonnet-4-5');
    });

    it('should create a session with custom thread type', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'ollama',
        model: 'llama3.1',
        threadType: 'spec_session',
        threadName: 'My Feature Spec',
        specId: 'spec-123',
      });

      expect(session.threadType).toBe('spec_session');
      expect(session.threadName).toBe('My Feature Spec');
      expect(session.specId).toBe('spec-123');
    });

    it('should create a child thread with parent reference', () => {
      const parentSession = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      const childSession = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
        threadName: 'Child Thread',
        parentSessionId: parentSession.id,
      });

      expect(childSession.parentSessionId).toBe(parentSession.id);
      expect(childSession.threadType).toBe('vibe_coding');
    });
  });

  describe('getSession', () => {
    it('should retrieve a session with all thread metadata', () => {
      const created = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
        threadName: 'Test Thread',
        specId: 'spec-456',
      });

      const retrieved = getSession(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.threadType).toBe('spec_session');
      expect(retrieved?.threadName).toBe('Test Thread');
      expect(retrieved?.specId).toBe('spec-456');
    });

    it('should return null for non-existent session', () => {
      const session = getSession('non-existent-id');
      expect(session).toBeNull();
    });
  });

  describe('updateFirstMessage', () => {
    it('should update the first message preview', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      });

      const longMessage = 'This is a very long message that should be truncated to 100 characters for the preview in the thread history panel';
      updateFirstMessage(session.id, longMessage);

      const updated = getSession(session.id);
      expect(updated?.firstMessage).toBe(longMessage.slice(0, 100));
    });
  });

  describe('updateThreadName', () => {
    it('should update the thread name', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadName: 'Original Name',
      });

      updateThreadName(session.id, 'Updated Name');

      const updated = getSession(session.id);
      expect(updated?.threadName).toBe('Updated Name');
    });
  });

  describe('getChildThreads', () => {
    it('should retrieve all child threads for a parent', () => {
      const parent = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      const child1 = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
        parentSessionId: parent.id,
      });

      const child2 = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
        parentSessionId: parent.id,
      });

      const children = getChildThreads(parent.id);

      expect(children).toHaveLength(2);
      expect(children.map(c => c.id)).toContain(child1.id);
      expect(children.map(c => c.id)).toContain(child2.id);
    });

    it('should return empty array for session with no children', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      });

      const children = getChildThreads(session.id);
      expect(children).toHaveLength(0);
    });
  });

  describe('listThreads', () => {
    beforeEach(() => {
      // Create test sessions with different types
      createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
        threadName: 'Vibe Thread 1',
      });

      createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
        threadName: 'Spec Thread 1',
      });

      createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
        threadName: 'Child Thread 1',
      });
    });

    it('should list all threads', () => {
      const threads = listThreads();
      expect(threads.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter threads by type', () => {
      const specThreads = listThreads({ threadType: 'spec_session' });
      expect(specThreads).toHaveLength(1);
      expect(specThreads[0].threadType).toBe('spec_session');
    });

    it('should search threads by name', () => {
      const results = listThreads({ searchQuery: 'Vibe' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].threadName).toContain('Vibe');
    });

    it('should include message count', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      });

      // Add some messages
      testDb.prepare(`
        INSERT INTO messages (id, session_id, role, content)
        VALUES ('msg-1', ?, 'user', 'Hello'),
               ('msg-2', ?, 'assistant', 'Hi there')
      `).run(session.id, session.id);

      const threads = listThreads();
      const threadWithMessages = threads.find(t => t.id === session.id);
      
      expect(threadWithMessages?.messageCount).toBe(2);
    });

    it('should respect limit parameter', () => {
      const threads = listThreads({ limit: 2 });
      expect(threads.length).toBeLessThanOrEqual(2);
    });
  });

  describe('deleteThread', () => {
    it('should delete a thread and all associated data', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      });

      // Add a message
      testDb.prepare(`
        INSERT INTO messages (id, session_id, role, content)
        VALUES ('msg-1', ?, 'user', 'Test message')
      `).run(session.id);

      // Delete the thread
      deleteThread(session.id);

      // Verify session is deleted
      const retrieved = getSession(session.id);
      expect(retrieved).toBeNull();

      // Verify messages are deleted
      const messages = testDb.prepare('SELECT * FROM messages WHERE session_id = ?').all(session.id);
      expect(messages).toHaveLength(0);
    });
  });

  describe('searchThreadsByContent', () => {
    beforeEach(() => {
      // Create sessions with messages
      const session1 = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      const session2 = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      // Add messages with specific content
      testDb.prepare(`
        INSERT INTO messages (id, session_id, role, content)
        VALUES ('msg-1', ?, 'user', 'How do I implement authentication?'),
               ('msg-2', ?, 'assistant', 'Here is how to implement authentication...')
      `).run(session1.id, session1.id);

      testDb.prepare(`
        INSERT INTO messages (id, session_id, role, content)
        VALUES ('msg-3', ?, 'user', 'Create a database migration'),
               ('msg-4', ?, 'assistant', 'I will create the migration...')
      `).run(session2.id, session2.id);
    });

    it('should find threads by message content', () => {
      const results = searchThreadsByContent('authentication');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].messageCount).toBeGreaterThanOrEqual(2);
    });

    it('should filter search results by thread type', () => {
      const results = searchThreadsByContent('migration', { threadType: 'spec_session' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].threadType).toBe('spec_session');
    });

    it('should return empty array when no matches found', () => {
      const results = searchThreadsByContent('nonexistent-search-term-xyz');
      expect(results).toHaveLength(0);
    });

    it('should respect limit parameter', () => {
      const results = searchThreadsByContent('', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('getThreadStats', () => {
    beforeEach(() => {
      // Create various threads
      createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      const activeSession = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      // Add some messages
      testDb.prepare(`
        INSERT INTO messages (id, session_id, role, content)
        VALUES ('msg-1', ?, 'user', 'Test message 1'),
               ('msg-2', ?, 'assistant', 'Test response 1')
      `).run(activeSession.id, activeSession.id);
    });

    it('should return correct thread statistics', () => {
      const stats = getThreadStats();
      
      expect(stats.totalThreads).toBeGreaterThanOrEqual(2);
      expect(stats.threadsByType.vibe_coding).toBeGreaterThanOrEqual(1);
      expect(stats.threadsByType.spec_session).toBeGreaterThanOrEqual(1);
      expect(stats.totalMessages).toBeGreaterThanOrEqual(2);
      expect(stats.activeThreads).toBeGreaterThanOrEqual(1);
    });
  });
});

