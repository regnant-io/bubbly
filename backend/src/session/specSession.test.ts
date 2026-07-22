import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createSession,
  getSession,
  updateSessionSpecId,
  sessionHasMessages,
  saveMessage,
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
    child: jest.fn(() => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

describe('Spec Session Management', () => {
  beforeEach(() => {
    // Create a temporary test database
    testDbPath = path.join(os.tmpdir(), `test-spec-session-${Date.now()}.db`);
    testDb = new Database(testDbPath);
    testDb.pragma('foreign_keys = ON');

    // Initialize schema
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

      CREATE INDEX idx_messages_session ON messages(session_id);
      CREATE INDEX idx_sessions_spec_id ON sessions(spec_id);
    `);
  });

  afterEach(() => {
    testDb.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('createSession with spec_session thread type', () => {
    it('should create a session with spec_session thread type', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      expect(session.threadType).toBe('spec_session');
      expect(session.specId).toBeUndefined();
    });

    it('should create a session with spec_id', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
        specId: 'feature-12345',
      });

      expect(session.threadType).toBe('spec_session');
      expect(session.specId).toBe('feature-12345');
    });
  });

  describe('updateSessionSpecId', () => {
    it('should update the spec_id for a session', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      updateSessionSpecId(session.id, 'feature-67890');

      const updated = getSession(session.id);
      expect(updated?.specId).toBe('feature-67890');
    });

    it('should update spec_id for existing session without spec_id', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'vibe_coding',
      });

      expect(session.specId).toBeUndefined();

      updateSessionSpecId(session.id, 'feature-11111');

      const updated = getSession(session.id);
      expect(updated?.specId).toBe('feature-11111');
    });
  });

  describe('sessionHasMessages', () => {
    it('should return false for session with no messages', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      expect(sessionHasMessages(session.id)).toBe(false);
    });

    it('should return true for session with messages', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      saveMessage(session.id, 'user', 'Hello, create a spec for me');

      expect(sessionHasMessages(session.id)).toBe(true);
    });

    it('should return true for session with multiple messages', () => {
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      saveMessage(session.id, 'user', 'First message');
      saveMessage(session.id, 'assistant', 'Response');
      saveMessage(session.id, 'user', 'Second message');

      expect(sessionHasMessages(session.id)).toBe(true);
    });
  });

  describe('Spec Session workflow', () => {
    it('should support complete spec session workflow', () => {
      // 1. Create a spec session
      const session = createSession({
        workspacePath: '/test/workspace',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        threadType: 'spec_session',
      });

      expect(session.threadType).toBe('spec_session');
      expect(session.specId).toBeUndefined();

      // 2. User sends first message
      saveMessage(session.id, 'user', 'Create a spec for user authentication');
      expect(sessionHasMessages(session.id)).toBe(true);

      // 3. Agent creates spec and locks it to session
      const specId = 'feature-auth-12345';
      updateSessionSpecId(session.id, specId);

      // 4. Verify spec is locked to session
      const updated = getSession(session.id);
      expect(updated?.specId).toBe(specId);
      expect(updated?.threadType).toBe('spec_session');

      // 5. Agent continues working on tasks
      saveMessage(session.id, 'assistant', 'I created the spec. Now working on task 1...');
      saveMessage(session.id, 'user', 'Continue');

      // Session should still have the spec locked
      const final = getSession(session.id);
      expect(final?.specId).toBe(specId);
    });
  });
});
