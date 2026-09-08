import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runMigrations } from './migrationRunner';
import * as vault from '../secrets/vault';

/** Model credentials belong in the encrypted vault, never the settings DB. */
const SECRET_SETTINGS = new Map([
  ['anthropicApiKey', 'model:anthropic:api-key'],
  ['geminiApiKey', 'model:gemini:api-key'],
  ['openrouterApiKey', 'model:openrouter:api-key'],
]);

function readSecretSetting(db: Database.Database, key: string, legacyValue: string): string {
  // Unit tests deliberately use isolated SQLite databases and should not read
  // or mutate the developer's real credential vault.
  if (process.env.NODE_ENV === 'test') return legacyValue;
  const secretName = SECRET_SETTINGS.get(key);
  if (!secretName) return legacyValue;

  const stored = vault.getSecret(secretName);
  if (stored !== null) {
    if (legacyValue) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('', key);
    return stored;
  }

  // Transparently migrate installations that predate vault-backed model keys.
  // Keep the legacy value if a passphrase-locked vault is not currently open;
  // erasing it in that state would lose the credential.
  if (legacyValue && vault.isUnlocked()) {
    vault.setSecret(secretName, legacyValue);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('', key);
  }
  return legacyValue;
}

/**
 * Database location.
 *
 * Defaults to the real per-user database at ~/.bubbly/bubbly.db, but can be
 * redirected with BUBBLY_DB_PATH. Tests MUST set that override — without it the
 * suite reads and writes the user's actual settings/sessions, which both
 * corrupts real data and leaks state between test files (two settings tests
 * only pass in isolation because a previous suite leaves ollamaBaseUrl already
 * set to the value they're about to "change" it to).
 *
 * `:memory:` is honoured as-is for a throwaway in-process database.
 */
const DB_PATH = process.env.BUBBLY_DB_PATH || path.join(os.homedir(), '.bubbly', 'bubbly.db');

if (DB_PATH !== ':memory:') {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
    // Run any pending migrations
    runMigrations(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      status TEXT DEFAULT 'idle',
      provider TEXT DEFAULT 'claude',
      model TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      seq INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      preview TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool TEXT,
      args TEXT,
      result_summary TEXT,
      tokens_used INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);

    CREATE TABLE IF NOT EXISTS specs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'feature',
      status TEXT DEFAULT 'draft',
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('anthropicApiKey', ''),
      ('geminiApiKey', ''),
      ('openrouterApiKey', ''),
      ('ollamaBaseUrl', 'http://localhost:11434'),
      ('defaultProvider', 'claude'),
      ('claudeModel', 'claude-sonnet-4-5'),
      ('geminiModel', 'gemini-2.0-flash'),
      ('openrouterModel', 'anthropic/claude-3.5-sonnet'),
      ('ollamaModel', 'llama3.1'),
      ('workspacePath', ''),
      ('requireApprovalForWrites', 'true'),
      ('requireApprovalForShell', 'true'),
      ('theme', 'dark'),
      ('ollamaEnableThinking', 'false'),
      ('ollamaRetryMaxAttempts', '5'),
      ('ollamaRetryInitialDelayMs', '1000'),
      ('ollamaRetryBackoffMultiplier', '2'),
      ('autoValidate', 'true'),
      ('multiAgentSpec', 'false'),
      ('contextTokenBudget', '24000'),
      ('autoContextMigration', 'true'),
      ('contextMigrationThreshold', '0.85'),
      ('ollamaAutoNumCtx', 'true'),
      ('ollamaNumCtxCeiling', '32768'),
      ('ollamaNumCtx', '16384'),
      ('ollamaRequestTimeoutMs', '300000'),
      ('maxTaskIterations', '40'),
      ('editorFontSize', '13'),
      ('streamingSpeed', 'normal'),
      ('revealRightPanelOnDiff', 'false'),
      ('vibeWorkerThreshold', 'auto'),
      ('specDocsAsMarkdown', 'true'),
      ('terminalFontSize', '13'),
      ('tabSize', '2'),
      ('wordWrap', 'true'),
      ('formatOnSave', 'false'),
      ('autoSave', 'false'),
      ('mcpServers', '[]'),
      ('skills', '[]'),
      ('computerControlEnabled', 'false'),
      ('browserControlEnabled', 'false'),
      ('desktopNotifications', 'true'),
      ('notifyOnCommandFailure', 'false');
  `);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, readSecretSetting(db, r.key, r.value)]));
}

export function getSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return readSecretSetting(db, key, row?.value ?? '');
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  const secretName = SECRET_SETTINGS.get(key);
  if (secretName && process.env.NODE_ENV !== 'test') {
    if (value) vault.setSecret(secretName, value);
    else vault.deleteSecret(secretName);
    // Leave a row so old code/default discovery still sees the setting, but
    // never leave credential material in the SQLite file.
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, '');
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
