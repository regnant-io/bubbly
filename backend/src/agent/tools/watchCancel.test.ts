/**
 * A blocking `watch` must never hold the session hostage.
 *
 * The bug this locks down: executeTool took no abort signal, so a blocking
 * watch kept waiting after the user pressed Stop — up to its full timeout (30
 * minutes at the time). The session looked frozen and nothing could recover it.
 * Two guarantees now:
 *   1. Abort resolves the call promptly.
 *   2. A blocking wait is capped at 60s no matter what was requested; anything
 *      longer is forced detached so it returns immediately instead of blocking.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeTool } from './index';
import { watchers } from './watchers';

jest.mock('../../db/index', () => ({
  getSetting: () => 'false',
  getDb: () => ({ prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }) }),
}));

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-watchcancel-')); });
afterEach(() => {
  watchers.cancelAll();
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('blocking watch is cancellable', () => {
  it('returns promptly when the signal aborts, instead of waiting out the timeout', async () => {
    const ctrl = new AbortController();
    const started = Date.now();

    // A condition that will never be met inside the test's lifetime.
    const p = executeTool(
      'watch',
      { action: 'wait', condition: 'file_exists', path: 'never-created.txt', timeout_seconds: 60 },
      ws,
      undefined,
      ctrl.signal,
    );

    setTimeout(() => ctrl.abort(), 300);
    const res = await p;

    expect(res.result).toMatch(/cancelled/i);
    // Must come back on abort, NOT after the 60s cap.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it('an already-aborted signal does not start a long wait', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const started = Date.now();
    const res = await executeTool(
      'watch',
      { action: 'wait', condition: 'file_exists', path: 'never.txt', timeout_seconds: 60 },
      ws,
      undefined,
      ctrl.signal,
    );
    expect(res.result).toMatch(/cancelled/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});

describe('long waits are forced detached, never blocking', () => {
  it('a request over the 60s cap returns immediately as a detached watcher', async () => {
    const started = Date.now();
    const res = await executeTool(
      'watch',
      { action: 'wait', condition: 'file_exists', path: 'slow-build-output.txt', timeout_seconds: 900 },
      ws,
    );
    // Returns at once with a watcher id — the session is never parked.
    expect(res.result).toMatch(/running in the background/i);
    expect(res.result).toMatch(/end your turn/i);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);

  it('explicit detached:true also returns immediately', async () => {
    const res = await executeTool(
      'watch',
      { action: 'wait', condition: 'file_exists', path: 'x.txt', detached: true },
      ws,
    );
    expect(res.result).toMatch(/running in the background/i);
  }, 15_000);

  it('a short gate still blocks and resolves normally when the condition is met', async () => {
    const target = path.join(ws, 'ready.txt');
    setTimeout(() => fs.writeFileSync(target, 'ok'), 400);
    const res = await executeTool(
      'watch',
      { action: 'wait', condition: 'file_exists', path: 'ready.txt', timeout_seconds: 10 },
      ws,
    );
    expect(res.result).toMatch(/DONE/);
  }, 15_000);
});
