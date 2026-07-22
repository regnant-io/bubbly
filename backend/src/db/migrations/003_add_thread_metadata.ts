import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

/**
 * Migration: per-thread persisted metadata.
 *
 * Two pieces of session state must survive a refresh / reopen:
 *   - `plan`           — the agent's working plan (update_plan), as JSON, so the
 *                        collapsible plan strip can be restored exactly.
 *   - `session_changes`— the list of file changes made during the thread
 *                        (path + change type + counts), as JSON, so each thread
 *                        records what it actually changed.
 *
 * Both are nullable TEXT columns holding JSON. Idempotent: only added if absent.
 */
export function up(db: Database.Database): void {
  logger.info('Running migration: 003_add_thread_metadata');

  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);

  if (!has('plan')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT;`);
  }
  if (!has('session_changes')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN session_changes TEXT;`);
  }

  logger.info('Migration completed: 003_add_thread_metadata');
}

export function down(_db: Database.Database): void {
  logger.info('Rolling back migration: 003_add_thread_metadata');
  logger.warn('Note: SQLite cannot easily DROP COLUMN; leaving plan/session_changes in place.');
  logger.info('Migration rollback completed: 003_add_thread_metadata');
}
