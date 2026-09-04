import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { 
  createSession, 
  saveMessage, 
  getMessagesForUI, 
  getApprovals 
} from './manager';

// Mock the getDb function to use our test database
let testDb: Database.Database;

jest.mock('../db', () => ({
  getDb: () => testDb,
}));

// Import after mocking
import { getDb } from '../db';

describe('Thread Loading and Restoration', () => {
  beforeEach(() => {
    // Use in-memory database for testing
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    
    // Initialize schema
    testDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thread_type TEXT DEFAULT 'vibe_coding',
        thread_name TEXT,
        parent_session_id TEXT,
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
    `);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should load messages with UI format', () => {
    // Create a session
    const session = createSession({
      workspacePath: '/test',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      threadType: 'vibe_coding',
    });

    // Save some messages
    saveMessage(session.id, 'user', 'Hello');
    saveMessage(session.id, 'assistant', 'Hi there!');

    // Load messages for UI
    const messages = getMessagesForUI(session.id);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Hello',
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Hi there!',
    });
  });

  it('should load messages with tool calls', () => {
    const session = createSession({
      workspacePath: '/test',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      threadType: 'vibe_coding',
    });

    // Save a message with tool calls
    const toolCalls = [
      {
        type: 'text',
        text: 'Let me read that file',
      },
      {
        type: 'tool_use',
        id: 'call1',
        name: 'read_file',
        input: { path: 'test.txt' },
      },
    ];

    saveMessage(session.id, 'assistant', '', toolCalls);

    const messages = getMessagesForUI(session.id);

    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls).toBeDefined();
    
    const parsedToolCalls = JSON.parse(messages[0].toolCalls!);
    expect(parsedToolCalls).toHaveLength(2);
    expect(parsedToolCalls[0].type).toBe('text');
    expect(parsedToolCalls[1].type).toBe('tool_use');
  });

  it('should load approvals for a session', () => {
    const session = createSession({
      workspacePath: '/test',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      threadType: 'vibe_coding',
    });

    // Insert an approval directly
    testDb.prepare(
      `INSERT INTO approvals (id, session_id, tool, args, preview, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'approval1',
      session.id,
      'write_file',
      JSON.stringify({ path: 'test.txt', content: 'new content' }),
      'Writing to test.txt',
      'approved',
      new Date().toISOString()
    );

    const approvals = getApprovals(session.id);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      id: 'approval1',
      tool: 'write_file',
      status: 'approved',
      preview: 'Writing to test.txt',
    });

    const args = JSON.parse(approvals[0].args);
    expect(args).toMatchObject({
      path: 'test.txt',
      content: 'new content',
    });
  });

  it('should handle multiple messages and approvals', () => {
    const session = createSession({
      workspacePath: '/test',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      threadType: 'spec_session',
    });

    // Save multiple messages
    saveMessage(session.id, 'user', 'Write a file');
    
    const toolCalls = [
      {
        type: 'text',
        text: 'I will write the file',
      },
      {
        type: 'tool_use',
        id: 'approval1',
        name: 'write_file',
        input: { path: 'test.txt', content: 'content' },
      },
    ];
    saveMessage(session.id, 'assistant', '', toolCalls);

    // Add approval
    testDb.prepare(
      `INSERT INTO approvals (id, session_id, tool, args, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'approval1',
      session.id,
      'write_file',
      JSON.stringify({ path: 'test.txt', content: 'content' }),
      'approved',
      new Date().toISOString()
    );

    // Add tool result
    const toolResults = [
      {
        type: 'tool_result',
        tool_use_id: 'approval1',
        content: 'File written successfully',
      },
    ];
    saveMessage(session.id, 'assistant', '', toolResults);

    const messages = getMessagesForUI(session.id);
    const approvals = getApprovals(session.id);

    expect(messages).toHaveLength(3);
    expect(approvals).toHaveLength(1);
    
    // Verify the approval matches the tool call
    expect(approvals[0].id).toBe('approval1');
  });

  it('should preserve message order', () => {
    const session = createSession({
      workspacePath: '/test',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      threadType: 'vibe_coding',
    });

    // Save messages in order
    saveMessage(session.id, 'user', 'First');
    saveMessage(session.id, 'assistant', 'Second');
    saveMessage(session.id, 'user', 'Third');
    saveMessage(session.id, 'assistant', 'Fourth');

    const messages = getMessagesForUI(session.id);

    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
    expect(messages[3].content).toBe('Fourth');
  });
});
