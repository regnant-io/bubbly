import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

/**
 * Migration: Add thread management columns to sessions table
 * 
 * This migration adds support for:
 * - Thread types (vibe_coding, spec_session)
 * - Thread names for better organization
 * - Parent-child thread relationships
 * - First message preview for thread history
 */
export function up(db: Database.Database): void {
  logger.info('Running migration: 001_add_thread_management');

  // Add new columns to sessions table
  db.exec(`
    -- Add thread_type column (default to 'vibe_coding' for backward compatibility)
    ALTER TABLE sessions ADD COLUMN thread_type TEXT DEFAULT 'vibe_coding';
    
    -- Add thread_name column for user-defined names
    ALTER TABLE sessions ADD COLUMN thread_name TEXT;
    
    -- Add parent_session_id for thread relationships (e.g., debug threads spawned from main threads)
    ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id);
    
    -- Add first_message for thread preview in history
    ALTER TABLE sessions ADD COLUMN first_message TEXT;
    
    -- Add spec_id to link spec sessions to their specs
    ALTER TABLE sessions ADD COLUMN spec_id TEXT;
  `);

  // Create indexes for efficient thread queries
  db.exec(`
    -- Index for filtering by thread type
    CREATE INDEX IF NOT EXISTS idx_sessions_thread_type ON sessions(thread_type);
    
    -- Index for finding child threads
    CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON sessions(parent_session_id);
    
    -- Index for spec session lookups
    CREATE INDEX IF NOT EXISTS idx_sessions_spec_id ON sessions(spec_id);
    
    -- Composite index for thread history queries (type + updated_at)
    CREATE INDEX IF NOT EXISTS idx_sessions_type_updated ON sessions(thread_type, updated_at DESC);
  `);

  // Migrate existing sessions to have default thread_type
  db.exec(`
    -- Set existing sessions to 'vibe_coding' type (already default, but explicit for clarity)
    UPDATE sessions SET thread_type = 'vibe_coding' WHERE thread_type IS NULL;
  `);

  logger.info('Migration completed: 001_add_thread_management');
}

export function down(db: Database.Database): void {
  logger.info('Rolling back migration: 001_add_thread_management');

  // Drop indexes
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_thread_type;
    DROP INDEX IF EXISTS idx_sessions_parent_id;
    DROP INDEX IF EXISTS idx_sessions_spec_id;
    DROP INDEX IF EXISTS idx_sessions_type_updated;
  `);

  // Note: SQLite doesn't support DROP COLUMN directly in older versions
  // For a proper rollback, we would need to recreate the table without these columns
  // For now, we'll leave the columns but document the rollback limitation
  logger.warn('Note: SQLite does not support DROP COLUMN. Columns remain but indexes are removed.');
  
  logger.info('Migration rollback completed: 001_add_thread_management');
}
