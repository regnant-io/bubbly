import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

/**
 * Migration: deterministic message ordering.
 *
 * Messages were ordered by `created_at` (second/ms precision). When several
 * messages are written in the same instant (very common in a fast agent loop:
 * assistant turn + tool results), their relative order could scramble on
 * reload, breaking tool_use/tool_result pairing and corrupting memory.
 *
 * This adds a monotonically increasing `seq` column. New rows get the next
 * value; existing rows are backfilled by created_at then rowid.
 */
export function up(db: Database.Database): void {
  logger.info('Running migration: 002_add_message_sequence');

  // Idempotent: the column may already exist in fresh DBs (it's in the base
  // schema). Only add it if missing.
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  const hasSeq = cols.some((c) => c.name === 'seq');
  if (!hasSeq) {
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER;`);
  }

  // Backfill any NULL seq values deterministically using rowid as tiebreaker.
  db.exec(`
    UPDATE messages
    SET seq = (
      SELECT COUNT(*) FROM messages m2
      WHERE (m2.created_at < messages.created_at)
         OR (m2.created_at = messages.created_at AND m2.rowid <= messages.rowid)
    )
    WHERE seq IS NULL;
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);`);

  logger.info('Migration completed: 002_add_message_sequence');
}

export function down(db: Database.Database): void {
  logger.info('Rolling back migration: 002_add_message_sequence');
  db.exec(`DROP INDEX IF EXISTS idx_messages_session_seq;`);
  logger.warn('Note: SQLite cannot DROP COLUMN easily; leaving seq column in place.');
  logger.info('Migration rollback completed: 002_add_message_sequence');
}
