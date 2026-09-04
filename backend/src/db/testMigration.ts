/**
 * Manual test script to verify migration runs correctly
 * Run with: npx ts-node src/db/testMigration.ts
 */

import { getDb } from './index';
import { getMigrationStatus } from './migrationRunner';
import { createSession, listThreads, updateFirstMessage } from '../session/manager';

console.log('Testing database migration...\n');

// Get database (this will run migrations automatically)
const db = getDb();

// Check migration status
const status = getMigrationStatus(db);
console.log('Migration Status:');
console.log(`  Total migrations: ${status.total}`);
console.log(`  Applied: ${status.applied}`);
console.log(`  Pending: ${status.pending.length > 0 ? status.pending.join(', ') : 'None'}`);
console.log();

// Test creating sessions with thread metadata
console.log('Creating test sessions...');

const chatSession = createSession({
  workspacePath: '/test/workspace',
  provider: 'claude',
  model: 'claude-sonnet-4-5',
  threadType: 'vibe_coding',
  threadName: 'General Chat',
});
console.log(`  Created vibe_coding session: ${chatSession.id}`);

const specSession = createSession({
  workspacePath: '/test/workspace',
  provider: 'ollama',
  model: 'llama3.1',
  threadType: 'spec_session',
  threadName: 'Feature Implementation',
  specId: 'spec-123',
});
console.log(`  Created spec_session: ${specSession.id}`);

const debugSession = createSession({
  workspacePath: '/test/workspace',
  provider: 'claude',
  model: 'claude-sonnet-4-5',
  threadType: 'vibe_coding',
  threadName: 'Debug Issue #42',
  parentSessionId: chatSession.id,
});
console.log(`  Created debug session: ${debugSession.id} (child of ${chatSession.id})`);
console.log();

// Update first message
updateFirstMessage(chatSession.id, 'Hello, I need help with implementing a new feature for my application.');
console.log('Updated first message preview for chat session');
console.log();

// List threads
console.log('Listing all threads:');
const allThreads = listThreads();
allThreads.forEach(thread => {
  console.log(`  - [${thread.threadType}] ${thread.threadName || 'Unnamed'} (${thread.messageCount} messages)`);
  if (thread.firstMessage) {
    console.log(`    Preview: ${thread.firstMessage}`);
  }
});
console.log();

// Filter by type
console.log('Listing spec_session threads only:');
const specThreads = listThreads({ threadType: 'spec_session' });
specThreads.forEach(thread => {
  console.log(`  - ${thread.threadName || 'Unnamed'} (spec_id: ${thread.specId})`);
});
console.log();

console.log('Migration test completed successfully! ✓');
