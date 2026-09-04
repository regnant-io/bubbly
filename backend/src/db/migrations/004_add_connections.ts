import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

/**
 * Migration: remote sources.
 *
 * Three additions, all of which exist because a workspace is no longer always a
 * directory on this machine:
 *
 *   `ssh_connections`  — saved hosts. NEVER holds a secret: passphrases and
 *                        passwords live in the vault under `ssh:<id>:*`, and a
 *                        row here is only enough to know WHERE and HOW, not to
 *                        get in.
 *   `forge_accounts`   — GitHub/GitLab accounts, likewise secret-free. Most rows
 *                        will have `token_source` pointing at something the user
 *                        already had (`gh` CLI, environment), in which case
 *                        Bubbly stores no credential at all.
 *   `sessions.source_*`— which source a thread is working in. Without this, a
 *                        thread reopened after a restart would not know its
 *                        files live on another machine, and would happily
 *                        resolve them against a local path that does not exist —
 *                        or, far worse, against one that does.
 *
 * Idempotent throughout: every statement is guarded so a partially-applied
 * migration can be re-run safely.
 */
export function up(db: Database.Database): void {
  logger.info('Running migration: 004_add_connections');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      auth TEXT NOT NULL DEFAULT 'agent',
      private_key_path TEXT,
      default_path TEXT,
      from_ssh_config INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS forge_accounts (
      id TEXT PRIMARY KEY,
      forge TEXT NOT NULL,
      host TEXT NOT NULL,
      username TEXT,
      token_source TEXT NOT NULL DEFAULT 'vault',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_accounts_host ON forge_accounts(forge, host);
  `);

  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);

  // 'local' | 'ssh' | 'git'. Defaulted rather than nullable so every existing
  // thread is unambiguously local instead of merely unlabelled — an unlabelled
  // thread would have to be guessed about on every read.
  if (!has('source_kind')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local';`);
  }
  // The full source descriptor as JSON: connection id + remote path for ssh,
  // clone URL + branch + local path for git.
  if (!has('source_config')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN source_config TEXT;`);
  }

  logger.info('Migration completed: 004_add_connections');
}

export function down(db: Database.Database): void {
  logger.info('Rolling back migration: 004_add_connections');
  db.exec(`
    DROP INDEX IF EXISTS idx_forge_accounts_host;
    DROP TABLE IF EXISTS forge_accounts;
    DROP TABLE IF EXISTS ssh_connections;
  `);
  logger.warn('Note: SQLite cannot easily DROP COLUMN; leaving sessions.source_kind/source_config in place.');
  logger.info('Migration rollback completed: 004_add_connections');
}
