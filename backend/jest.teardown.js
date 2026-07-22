'use strict';

/** Remove the per-run throwaway databases created by jest.setup.js. */

const os = require('os');
const path = require('path');
const fs = require('fs');

module.exports = async function globalTeardown() {
  const dir = path.join(os.tmpdir(), 'bubbly-test-db');
  try {
    // WAL mode leaves -wal/-shm siblings, so drop the whole directory.
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup — never fail a green run over temp files */
  }
};
