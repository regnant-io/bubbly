import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import * as migration001 from './migrations/001_add_thread_management';
import * as migration002 from './migrations/002_add_message_sequence';
import * as migration003 from './migrations/003_add_thread_metadata';
import * as migration004 from './migrations/004_add_connections';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
  down: (db: Database.Database) => void;
}

// Registry of all migrations in order
const migrations: Migration[] = [
  {
    id: '001',
    name: 'add_thread_management',
    up: migration001.up,
    down: migration001.down,
  },
  {
    id: '002',
    name: 'add_message_sequence',
    up: migration002.up,
    down: migration002.down,
  },
  {
    id: '003',
    name: 'add_thread_metadata',
    up: migration003.up,
    down: migration003.down,
  },
  {
    id: '004',
    name: 'add_connections',
    up: migration004.up,
    down: migration004.down,
  },
];

/**
 * Initialize the migrations table to track which migrations have been applied
 */
function initMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Get list of applied migration IDs
 */
function getAppliedMigrations(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT id FROM migrations ORDER BY id')
    .all() as Array<{ id: string }>;
  
  return new Set(rows.map(row => row.id));
}

/**
 * Mark a migration as applied
 */
function recordMigration(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO migrations (id, name) VALUES (?, ?)').run(id, name);
}

/**
 * Remove a migration record (for rollback)
 */
function removeMigration(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM migrations WHERE id = ?').run(id);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
  logger.info('Starting database migrations');
  
  initMigrationsTable(db);
  const appliedMigrations = getAppliedMigrations(db);
  
  let migrationsRun = 0;
  
  for (const migration of migrations) {
    if (appliedMigrations.has(migration.id)) {
      logger.debug(`Migration ${migration.id} already applied, skipping`);
      continue;
    }
    
    logger.info(`Running migration ${migration.id}: ${migration.name}`);
    
    try {
      // Run migration in a transaction
      db.transaction(() => {
        migration.up(db);
        recordMigration(db, migration.id, migration.name);
      })();
      
      migrationsRun++;
      logger.info(`Migration ${migration.id} completed successfully`);
    } catch (error) {
      logger.error(`Migration ${migration.id} failed`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(`Migration ${migration.id} failed: ${error}`);
    }
  }
  
  if (migrationsRun === 0) {
    logger.info('No pending migrations');
  } else {
    logger.info(`Successfully ran ${migrationsRun} migration(s)`);
  }
}

/**
 * Rollback the last migration
 */
export function rollbackLastMigration(db: Database.Database): void {
  logger.info('Rolling back last migration');
  
  initMigrationsTable(db);
  const appliedMigrations = getAppliedMigrations(db);
  
  if (appliedMigrations.size === 0) {
    logger.info('No migrations to rollback');
    return;
  }
  
  // Find the last applied migration
  const lastMigrationId = Array.from(appliedMigrations).sort().pop()!;
  const migration = migrations.find(m => m.id === lastMigrationId);
  
  if (!migration) {
    logger.error(`Migration ${lastMigrationId} not found in registry`);
    throw new Error(`Migration ${lastMigrationId} not found`);
  }
  
  logger.info(`Rolling back migration ${migration.id}: ${migration.name}`);
  
  try {
    db.transaction(() => {
      migration.down(db);
      removeMigration(db, migration.id);
    })();
    
    logger.info(`Migration ${migration.id} rolled back successfully`);
  } catch (error) {
    logger.error(`Migration rollback ${migration.id} failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new Error(`Migration rollback ${migration.id} failed: ${error}`);
  }
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database.Database): {
  total: number;
  applied: number;
  pending: string[];
} {
  initMigrationsTable(db);
  const appliedMigrations = getAppliedMigrations(db);
  
  const pending = migrations
    .filter(m => !appliedMigrations.has(m.id))
    .map(m => `${m.id}: ${m.name}`);
  
  return {
    total: migrations.length,
    applied: appliedMigrations.size,
    pending,
  };
}
