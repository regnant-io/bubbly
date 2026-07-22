'use strict';

/**
 * Give every test FILE its own throwaway sqlite database.
 *
 * Runs via `setupFiles`, i.e. before any module is imported — which matters,
 * because src/db/index.ts resolves its path at import time.
 *
 * Without this, tests ran against the user's real ~/.bubbly/bubbly.db. That
 * corrupted real settings and leaked state across suites: settings.integration
 * asserts behaviour that only fires when ollamaBaseUrl CHANGES, so once another
 * suite had already written that value the assertions silently stopped holding
 * (they passed alone, failed in a full run).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(os.tmpdir(), 'bubbly-test-db');
fs.mkdirSync(dir, { recursive: true });

// pid + random so parallel workers and repeat runs never collide.
const unique = `${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`;
process.env.BUBBLY_DB_PATH = path.join(dir, unique);
