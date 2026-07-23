/**
 * Watcher system.
 *
 * The contract: a watcher must ALWAYS settle — met, failed, timed out, or
 * cancelled — because the agent parks on it. A watcher that can hang is worse
 * than the polling loop it replaces.
 */

import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { watchers } from './watchers';
import { backgroundProcesses } from './backgroundProcess';

jest.mock('../../db/index', () => ({ getSetting: () => 'false' }));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-watch-'));

afterEach(() => {
  watchers.cancelAll();
  backgroundProcesses.killAll();
});

/** Start a shell command and return its process id. */
function start(cmd: string, cwd: string): string {
  const r = backgroundProcesses.start(cmd, cwd);
  if (r.error) throw new Error(r.error);
  return r.id;
}

describe('process conditions', () => {
  it('settles when the watched process exits, and carries the exit code', async () => {
    const dir = tmp();
    const id = start('node -e "process.exit(3)"', dir);
    const c = watchers.create({ kind: 'process_exit', processId: id }, { timeoutMs: 15_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await watchers.wait(c.id)!;
    expect(r.outcome).toBe('met');
    expect(r.exitCode).toBe(3);
  }, 20_000);

  it('settles on a pattern in output without the process ever exiting', async () => {
    const dir = tmp();
    // Prints the marker, then stays alive — exactly a dev server's shape.
    const id = start('node -e "console.log(\'server ready in 200ms\'); setInterval(()=>{},1000)"', dir);
    const c = watchers.create(
      { kind: 'output_match', processId: id, pattern: 'ready in' },
      { timeoutMs: 15_000 },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await watchers.wait(c.id)!;
    expect(r.outcome).toBe('met');
    expect(r.output).toContain('ready in');
  }, 20_000);

  it('reports FAILED (not timeout) when the process dies before printing the pattern', async () => {
    const dir = tmp();
    const id = start('node -e "console.log(\'boom\'); process.exit(1)"', dir);
    const c = watchers.create(
      { kind: 'output_match', processId: id, pattern: 'never-appears' },
      { timeoutMs: 15_000 },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await watchers.wait(c.id)!;
    // The useful answer is "it died", delivered immediately — NOT a 15s timeout.
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/exited/i);
  }, 20_000);

  it('settles immediately when the condition was ALREADY true before watching', async () => {
    const dir = tmp();
    const id = start('node -e "process.exit(0)"', dir);
    // Wait for the process to ACTUALLY exit before creating the watcher, so the
    // event has demonstrably already fired. A fixed sleep is not enough here: on
    // a loaded machine the spawn alone can outlast it, and the test then
    // exercises the live-subscription path instead of the already-settled one.
    for (let i = 0; i < 100; i++) {
      if (backgroundProcesses.getInfo(id)?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(backgroundProcesses.getInfo(id)?.status).not.toBe('running');

    const c = watchers.create({ kind: 'process_exit', processId: id }, { timeoutMs: 15_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await watchers.wait(c.id)!;
    expect(r.outcome).toBe('met');
    expect(r.detail).toMatch(/already exited/i);
  }, 20_000);

  it('refuses a watcher on an unknown process instead of waiting for nothing', () => {
    const c = watchers.create({ kind: 'process_exit', processId: 'proc_nope' });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toMatch(/No background process/);
  });

  it('rejects an invalid regex up front', () => {
    const dir = tmp();
    const id = start('node -e "setInterval(()=>{},1000)"', dir);
    const c = watchers.create({ kind: 'output_match', processId: id, pattern: '([unclosed' });
    expect(c.ok).toBe(false);
  });
});

describe('polled conditions', () => {
  it('settles when a file appears', async () => {
    const dir = tmp();
    const target = path.join(dir, 'build-done.txt');
    const c = watchers.create({ kind: 'file_exists', path: target }, { timeoutMs: 10_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    setTimeout(() => fs.writeFileSync(target, 'ok'), 400);
    const r = await watchers.wait(c.id)!;
    expect(r.outcome).toBe('met');
  }, 15_000);

  it('settles when a port starts accepting connections', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      const c = watchers.create({ kind: 'port_open', port }, { timeoutMs: 10_000 });
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      const r = await watchers.wait(c.id)!;
      expect(r.outcome).toBe('met');
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }, 15_000);

  it('rejects a malformed url rather than polling it forever', () => {
    const c = watchers.create({ kind: 'url_live', url: 'localhost:3000' });
    expect(c.ok).toBe(false);
  });
});

describe('always settles', () => {
  it('times out on a condition that never becomes true', async () => {
    const dir = tmp();
    const c = watchers.create(
      { kind: 'file_exists', path: path.join(dir, 'never.txt') },
      { timeoutMs: 1_200 },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const r = await watchers.wait(c.id)!;
    expect(r.outcome).toBe('timeout');
    // The agent must be told it isn't necessarily dead, so it can decide.
    expect(r.detail).toMatch(/still be running|Timed out/i);
  }, 10_000);

  it('cancel settles any parked waiter', async () => {
    const dir = tmp();
    const c = watchers.create({ kind: 'file_exists', path: path.join(dir, 'x.txt') }, { timeoutMs: 20_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const p = watchers.wait(c.id)!;
    watchers.cancel(c.id);
    const r = await p;
    expect(r.outcome).toBe('cancelled');
  }, 10_000);

  it('several waiters on one watcher all resolve', async () => {
    const dir = tmp();
    const target = path.join(dir, 'shared.txt');
    const c = watchers.create({ kind: 'file_exists', path: target }, { timeoutMs: 10_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const all = Promise.all([watchers.wait(c.id)!, watchers.wait(c.id)!, watchers.wait(c.id)!]);
    setTimeout(() => fs.writeFileSync(target, 'ok'), 300);
    const rs = await all;
    expect(rs.every((r) => r.outcome === 'met')).toBe(true);
  }, 15_000);
});

describe('detached delivery', () => {
  it('holds a result for later collection, and only hands it over once', async () => {
    const dir = tmp();
    const target = path.join(dir, 'detached.txt');
    const c = watchers.create({ kind: 'file_exists', path: target }, { timeoutMs: 10_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    fs.writeFileSync(target, 'ok');
    // Give the poll a chance to observe it — nobody is awaiting this watcher.
    await new Promise((r) => setTimeout(r, 900));

    const first = watchers.collectUndelivered();
    expect(first.some((x) => x.id === c.id && x.outcome === 'met')).toBe(true);
    // Re-collecting must not replay it, or the agent sees the same event twice.
    expect(watchers.collectUndelivered().some((x) => x.id === c.id)).toBe(false);
  }, 15_000);

  it('a blocking wait marks the result delivered, so collect does not repeat it', async () => {
    const dir = tmp();
    const target = path.join(dir, 'once.txt');
    const c = watchers.create({ kind: 'file_exists', path: target }, { timeoutMs: 10_000 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    setTimeout(() => fs.writeFileSync(target, 'ok'), 300);
    await watchers.wait(c.id)!;
    expect(watchers.collectUndelivered().some((x) => x.id === c.id)).toBe(false);
  }, 15_000);
});
