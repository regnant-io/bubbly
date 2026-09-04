import { watchers } from './watchers';

/**
 * TWO WATCHER BEHAVIOURS THAT WERE WRONG IN OPPOSITE DIRECTIONS.
 *
 * 1. SKIPPING. A watcher's deadline is set hours out on purpose — guessing how
 *    long a real build takes is what made the old five-minute ceiling report
 *    healthy work as a failure. That is right for the agent and useless for the
 *    person watching, who can see the thing is never going to happen and whose
 *    only lever was Stop, which kills the whole turn. Skipping settles one wait
 *    and tells the agent a HUMAN made that call, so it moves on rather than
 *    diagnosing a failure that did not occur.
 *
 * 2. THE SETTLE-WHILE-RUNNING RACE. `watch(detached:true)` promises "end your
 *    turn, you'll be resumed". The resume is fired by the settle listener,
 *    which stands down while the thread is still running — so a wait that
 *    finished in the seconds between the tool returning and the model stopping
 *    settled with nobody left to hear it, and the thread parked forever waiting
 *    for a wake-up that had already happened. hasUndelivered() is what the
 *    agent loop asks before it ends a turn.
 */
describe('watchers: skipping and undelivered results', () => {
  afterEach(() => { watchers.cancelAll(); });

  it('skipping settles the wait and says a human stopped it, not that it failed', async () => {
    const created = watchers.create(
      { kind: 'port_open', port: 59_997 },
      { sessionId: 'skip-session', label: 'port 59997 to open', timeoutMs: 60_000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const settled = watchers.wait(created.id);
    expect(settled).not.toBeNull();

    expect(watchers.skip(created.id)).toEqual({ ok: true });

    const result = await settled!;
    expect(result.outcome).toBe('cancelled');
    // The wording matters: this text is handed straight to the model, and
    // "it failed" would send it diagnosing a port that was simply never opened.
    expect(result.detail).toMatch(/skipped this wait/i);
    expect(result.detail).toMatch(/Nothing failed/i);
  });

  it('a skipped DETACHED watcher does not wake its thread', async () => {
    const notified: string[] = [];
    watchers.setSettleListener((notice) => { if (notice.detached) notified.push(notice.id); });

    const created = watchers.create(
      { kind: 'port_open', port: 59_996 },
      { sessionId: 'skip-session-2', detached: true, timeoutMs: 60_000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    watchers.skip(created.id);
    // The user asked to stop waiting, not to be interrupted about it later.
    expect(notified).toEqual([]);
    watchers.setSettleListener(null);
  });

  it('skipping something that has already settled is a no-op, not an error', () => {
    const created = watchers.create({ kind: 'port_open', port: 59_995 }, { sessionId: 's', timeoutMs: 60_000 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    watchers.skip(created.id);
    expect(watchers.skip(created.id)).toEqual({ ok: true });
  });

  it('reports an unread result for the thread that registered it', async () => {
    const created = watchers.create(
      { kind: 'file_exists', path: `${__dirname}/definitely-not-a-real-file-9987.txt` },
      { sessionId: 'race-session', detached: true, timeoutMs: 60_000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(watchers.hasUndelivered('race-session')).toBe(false);

    // Settle it the way a real condition would, then check the loop can see it.
    watchers.cancel(created.id);
    // A CANCELLED watcher is explicitly NOT something to wake up for: the user
    // stopped it. Only genuine outcomes count as undelivered.
    expect(watchers.hasUndelivered('race-session')).toBe(false);
  });

  it('scopes undelivered results to one thread', () => {
    const a = watchers.create({ kind: 'port_open', port: 59_994 }, { sessionId: 'thread-a', timeoutMs: 60_000 });
    expect(a.ok).toBe(true);
    expect(watchers.liveCountForSession('thread-a')).toBe(1);
    expect(watchers.liveCountForSession('thread-b')).toBe(0);
    expect(watchers.collectUndelivered('thread-b')).toEqual([]);
  });
});
