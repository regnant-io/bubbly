/**
 * Where Bubbly keeps secrets.
 *
 * Bubbly now holds things that can do real damage if they leak: GitHub and
 * GitLab tokens with push rights, SSH passphrases, remote host passwords. The
 * settings table is the wrong place for all of them — it is a plain SQLite file
 * that gets copied around, backed up, and read by anything that can read the
 * user's disk, and settings are dumped wholesale into `/api/settings` responses
 * and into logs.
 *
 * THE MODEL
 *
 * One master key, three ways of protecting it, chosen by what is available:
 *
 *   1. THE DESKTOP SHELL. Electron's `safeStorage` is backed by the real OS
 *      keychain — DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 *      Linux. The shell unwraps the master key at startup and passes it to this
 *      process in an environment variable, so the key at rest is protected by
 *      the OS and is never written anywhere by us. This is the good path.
 *   2. A KEY FILE. No Electron (a headless server, the CLI against a bare
 *      backend): a 32-byte random key in `~/.bubbly/vault.key` with 0600
 *      permissions. This protects against another USER on the machine and
 *      against a stray backup of bubbly.db — not against someone who already
 *      has the user's own read access, and the docs say so rather than
 *      implying otherwise.
 *   3. A PASSPHRASE. If the user sets one, it is mixed into the key with scrypt
 *      and the vault cannot be opened without it. Strongest, and the only
 *      option that survives an attacker with full read access to the disk.
 *
 * Secrets are encrypted individually with AES-256-GCM, so a corrupted or
 * tampered entry fails loudly on ITS OWN read rather than taking the vault with
 * it, and each has its own nonce.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Bubbly does not want to own credentials it does not have to. If the user
 * already has an ssh-agent, `~/.ssh/config`, a git credential helper or the
 * `gh` CLI logged in, those are used as-is — see `credentialSources.ts`. The
 * vault is for what is left over.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Paths are resolved lazily from BUBBLY_HOME (falling back to the real home
 * directory) rather than captured at import time. Tests point BUBBLY_HOME at a
 * temp directory; without the indirection they would either write to the
 * developer's real vault or need the module reloaded between cases.
 */
function vaultDir(): string {
  return path.join(process.env.BUBBLY_HOME || os.homedir(), '.bubbly');
}
function keyFile(): string { return path.join(vaultDir(), 'vault.key'); }
function vaultFile(): string { return path.join(vaultDir(), 'vault.json'); }

/** How the master key is protected right now. Reported in Settings. */
export type VaultBackend = 'os-keychain' | 'key-file' | 'passphrase' | 'locked';

interface VaultEntry {
  /** AES-256-GCM: iv, ciphertext and tag, all base64. */
  iv: string;
  data: string;
  tag: string;
  updatedAt: string;
}

interface VaultFile {
  version: 1;
  /** Present when a passphrase is in use — the salt for its scrypt derivation. */
  kdfSalt?: string;
  /** A known plaintext, encrypted. Lets a wrong passphrase fail immediately and
   *  clearly rather than producing garbage secrets three calls later. */
  check?: VaultEntry;
  entries: Record<string, VaultEntry>;
}

const CHECK_PLAINTEXT = 'bubbly-vault-v1';

let cachedKey: Buffer | null = null;
let cachedBackend: VaultBackend = 'locked';
let cachedFile: VaultFile | null = null;

function ensureDir(): void {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readVaultFile(): VaultFile {
  if (cachedFile) return cachedFile;
  try {
    if (fs.existsSync(vaultFile())) {
      const parsed = JSON.parse(fs.readFileSync(vaultFile(), 'utf8')) as VaultFile;
      if (parsed && parsed.version === 1 && parsed.entries) {
        cachedFile = parsed;
        return parsed;
      }
    }
  } catch (err) {
    logger.warn('Vault file could not be read; starting a new one', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cachedFile = { version: 1, entries: {} };
  return cachedFile;
}

function writeVaultFile(file: VaultFile): void {
  ensureDir();
  cachedFile = file;
  // Write-then-rename so an interrupted write cannot leave a half-file that
  // takes every stored credential with it.
  const target = vaultFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * The master key.
 *
 * Order matters: the OS keychain path wins whenever the desktop shell provided
 * a key, because it is the only one where the key at rest is protected by
 * something other than file permissions.
 */
function loadMasterKey(passphrase?: string): { key: Buffer; backend: VaultBackend } | null {
  const file = readVaultFile();

  // 1. Passphrase, when the vault was created with one.
  if (file.kdfSalt) {
    if (!passphrase) return null; // locked until the user supplies it
    const key = crypto.scryptSync(passphrase, Buffer.from(file.kdfSalt, 'base64'), 32, {
      N: 16384, r: 8, p: 1,
    });
    return { key, backend: 'passphrase' };
  }

  // 2. The desktop shell's OS-keychain-protected key.
  const fromShell = process.env.BUBBLY_VAULT_KEY;
  if (fromShell) {
    try {
      const key = Buffer.from(fromShell, 'base64');
      if (key.length === 32) return { key, backend: 'os-keychain' };
      logger.warn('BUBBLY_VAULT_KEY is not a 32-byte base64 key; ignoring it');
    } catch { /* fall through to the key file */ }
  }

  // 3. A local key file, created on first use.
  ensureDir();
  try {
    if (fs.existsSync(keyFile())) {
      const key = fs.readFileSync(keyFile());
      if (key.length === 32) return { key, backend: 'key-file' };
      logger.warn('vault.key is the wrong size; regenerating it (stored secrets will need re-entering)');
    }
  } catch (err) {
    logger.warn('Could not read vault.key', { error: err instanceof Error ? err.message : String(err) });
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile(), key, { mode: 0o600 });
  // On Windows, mode is advisory — narrow the ACL to the current user so the
  // key is not readable by every account on a shared machine.
  if (process.platform === 'win32') restrictWindowsAcl(keyFile());
  return { key, backend: 'key-file' };
}

/**
 * Windows ignores POSIX file modes, so `mode: 0o600` on the key file is
 * decorative there. icacls is how you actually say "only this user".
 * Best-effort: a failure means the key file is merely as protected as the
 * user's profile directory, which is still not world-readable by default.
 */
function restrictWindowsAcl(file: string): void {
  try {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const user = process.env.USERNAME;
    if (!user) return;
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true });
  } catch { /* advisory only */ }
}

function key(passphrase?: string): Buffer | null {
  if (cachedKey) return cachedKey;
  const loaded = loadMasterKey(passphrase);
  if (!loaded) { cachedBackend = 'locked'; return null; }
  cachedKey = loaded.key;
  cachedBackend = loaded.backend;
  return cachedKey;
}

function encrypt(k: Buffer, plaintext: string): VaultEntry {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

function decrypt(k: Buffer, entry: VaultEntry): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
}

// --- Public API -------------------------------------------------------------

/** Is the vault currently openable? False when a passphrase is set and unentered. */
export function isUnlocked(): boolean {
  return key() !== null;
}

export function backend(): VaultBackend {
  key();
  return cachedBackend;
}

/** Unlock a passphrase-protected vault. Returns false if the passphrase is wrong. */
export function unlock(passphrase: string): boolean {
  cachedKey = null;
  const k = key(passphrase);
  if (!k) return false;
  const file = readVaultFile();
  if (file.check) {
    try {
      if (decrypt(k, file.check) !== CHECK_PLAINTEXT) { cachedKey = null; return false; }
    } catch {
      cachedKey = null;
      return false;
    }
  }
  return true;
}

/** Lock the vault, forgetting the in-memory key. */
export function lock(): void {
  cachedKey = null;
  cachedBackend = 'locked';
}

/**
 * Turn on passphrase protection, re-encrypting everything already stored.
 *
 * Deliberately re-encrypts rather than starting fresh: a user who adds a
 * passphrase after connecting three servers should not silently lose those
 * three connections.
 */
export function setPassphrase(passphrase: string): void {
  const existing: Record<string, string> = {};
  const current = key();
  const file = readVaultFile();
  if (current) {
    for (const [name, entry] of Object.entries(file.entries)) {
      try { existing[name] = decrypt(current, entry); } catch { /* drop what we cannot read */ }
    }
  }

  const salt = crypto.randomBytes(16);
  const newKey = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  cachedKey = newKey;
  cachedBackend = 'passphrase';

  const next: VaultFile = {
    version: 1,
    kdfSalt: salt.toString('base64'),
    check: encrypt(newKey, CHECK_PLAINTEXT),
    entries: {},
  };
  for (const [name, value] of Object.entries(existing)) next.entries[name] = encrypt(newKey, value);
  writeVaultFile(next);
  logger.info('Vault passphrase set', { entries: Object.keys(existing).length });
}

/** Store a secret. Overwrites any existing value under the same name. */
export function setSecret(name: string, value: string): void {
  const k = key();
  if (!k) throw new Error('The credential vault is locked. Unlock it with your passphrase first.');
  const file = readVaultFile();
  file.entries[name] = encrypt(k, value);
  writeVaultFile(file);
}

/**
 * Read a secret. Returns null when absent or unreadable.
 *
 * Never throws on a decryption failure: a single tampered or stale entry must
 * not take down the connection list, and "this one credential needs re-entering"
 * is a far better outcome than a 500 on the settings page.
 */
export function getSecret(name: string): string | null {
  const k = key();
  if (!k) return null;
  const entry = readVaultFile().entries[name];
  if (!entry) return null;
  try {
    return decrypt(k, entry);
  } catch {
    logger.warn('A stored credential could not be decrypted; it needs re-entering', { name });
    return null;
  }
}

export function hasSecret(name: string): boolean {
  return !!readVaultFile().entries[name];
}

export function deleteSecret(name: string): void {
  const file = readVaultFile();
  if (!file.entries[name]) return;
  delete file.entries[name];
  writeVaultFile(file);
}

/** Every stored secret NAME. Never the values — this feeds the settings UI. */
export function listSecretNames(): string[] {
  return Object.keys(readVaultFile().entries).sort();
}

/** Drop every secret. Used by "disconnect everything" and by tests. */
export function clearAll(): void {
  writeVaultFile({ version: 1, entries: {} });
}

/**
 * Test seam: forget every cached key and file handle.
 *
 * Tests point BUBBLY_HOME at a temp directory and call this between cases;
 * without it the module's caches would carry one case's key into the next.
 */
export function __resetForTests(): void {
  cachedKey = null;
  cachedFile = null;
  cachedBackend = 'locked';
}
