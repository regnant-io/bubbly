import Database from 'better-sqlite3';
import { up, down } from './001_add_thread_management';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Migration 001: Add Thread Management', () => {
  let db: Database.Database;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary test database
    testDbPath = path.join(os.tmpdir(), `test-migration-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma('foreign_keys = ON');

    // Create the base sessions table (as it would exist before migration)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        status TEXT DEFAULT 'idle',
        provider TEXT DEFAULT 'claude',
        model TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert a test session
    db.prepare(`
      INSERT INTO sessions (id, workspace_path, status, provider, model)
      VALUES ('test-session-1', '/test/workspace', 'active', 'claude', 'claude-sonnet-4-5')
    `).run();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should add thread management columns to sessions table', () => {
    // Run the migration
    up(db);

    // Verify columns were added by querying table info
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('thread_type');
    expect(columnNames).toContain('thread_name');
    expect(columnNames).toContain('parent_session_id');
    expect(columnNames).toContain('first_message');
    expect(columnNames).toContain('spec_id');
  });

  it('should create indexes for thread queries', () => {
    up(db);

    // Verify indexes were created
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_sessions_thread_type');
    expect(indexNames).toContain('idx_sessions_parent_id');
    expect(indexNames).toContain('idx_sessions_spec_id');
    expect(indexNames).toContain('idx_sessions_type_updated');
  });

  it('should set default thread_type for existing sessions', () => {
    up(db);

    // Check that existing session has default thread_type
    const session = db.prepare('SELECT thread_type FROM sessions WHERE id = ?').get('test-session-1') as { thread_type: string };
    
    expect(session.thread_type).toBe('vibe_coding');
  });

  it('should allow inserting sessions with thread metadata', () => {
    up(db);

    // Insert a new session with thread metadata
    db.prepare(`
      INSERT INTO sessions (
        id, workspace_path, status, provider, model,
        thread_type, thread_name, parent_session_id, spec_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-session-2',
      '/test/workspace',
      'active',
      'ollama',
      'llama3.1',
      'spec_session',
      'My Spec Thread',
      'test-session-1',
      'spec-123'
    );

    // Verify the data was inserted correctly
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-session-2') as Record<string, string>;
    
    expect(session.thread_type).toBe('spec_session');
    expect(session.thread_name).toBe('My Spec Thread');
    expect(session.parent_session_id).toBe('test-session-1');
    expect(session.spec_id).toBe('spec-123');
  });

  it('should allow querying by thread_type using index', () => {
    up(db);

    // Insert sessions with different thread types
    db.prepare(`
      INSERT INTO sessions (id, workspace_path, model, thread_type)
      VALUES ('chat-1', '/test', 'model', 'vibe_coding'),
             ('spec-1', '/test', 'model', 'spec_session'),
             ('debug-1', '/test', 'model', 'vibe_coding')
    `).run();

    // Query by thread type
    const specSessions = db.prepare('SELECT id FROM sessions WHERE thread_type = ?').all('spec_session') as Array<{ id: string }>;
    
    expect(specSessions).toHaveLength(1);
    expect(specSessions[0].id).toBe('spec-1');
  });

  it('should allow querying child threads using parent_session_id index', () => {
    up(db);

    // Insert parent and child sessions
    db.prepare(`
      INSERT INTO sessions (id, workspace_path, model, thread_type, parent_session_id)
      VALUES ('parent-1', '/test', 'model', 'vibe_coding', NULL),
             ('child-1', '/test', 'model', 'vibe_coding', 'parent-1'),
             ('child-2', '/test', 'model', 'vibe_coding', 'parent-1')
    `).run();

    // Query child threads
    const childThreads = db.prepare('SELECT id FROM sessions WHERE parent_session_id = ?').all('parent-1') as Array<{ id: string }>;
    
    expect(childThreads).toHaveLength(2);
    expect(childThreads.map(t => t.id)).toContain('child-1');
    expect(childThreads.map(t => t.id)).toContain('child-2');
  });

  it('should drop indexes on rollback', () => {
    up(db);
    down(db);

    // Verify indexes were removed
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).not.toContain('idx_sessions_thread_type');
    expect(indexNames).not.toContain('idx_sessions_parent_id');
    expect(indexNames).not.toContain('idx_sessions_spec_id');
    expect(indexNames).not.toContain('idx_sessions_type_updated');
  });
});

