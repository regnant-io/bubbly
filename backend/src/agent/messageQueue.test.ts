import { queueUserMessage, queuedMessageCount, clearQueuedMessages } from './orchestrator';

/**
 * MESSAGES TYPED WHILE THE AGENT IS ALREADY WORKING.
 *
 * A run is single-flight — two loops over one thread duplicate every tool call
 * — so a second `chat` for a busy thread is refused. That protection is right
 * and the experience around it was wrong: the moment you most need to say
 * something is the moment you are watching the agent do the wrong thing, and
 * "wait until it finishes" is not an answer.
 *
 * The queue is the answer, and it has exactly three properties worth pinning:
 * it is bounded, it hands everything over at once when asked, and a Stop gives
 * the unsent text back rather than eating it.
 */
describe('mid-run message queue', () => {
  const thread = () => `queue_test_${Math.random().toString(36).slice(2, 10)}`;

  afterEach(() => { /* each test uses a fresh id, so nothing leaks between them */ });

  it('accepts messages up to the cap and refuses the next one with a reason', () => {
    const id = thread();
    expect(queueUserMessage(id, 'one')).toEqual({ ok: true, queued: 1 });
    expect(queueUserMessage(id, 'two')).toEqual({ ok: true, queued: 2 });
    expect(queueUserMessage(id, 'three')).toEqual({ ok: true, queued: 3 });

    const refused = queueUserMessage(id, 'four');
    expect(refused.ok).toBe(false);
    expect(refused.queued).toBe(3);
    // The reason has to be readable: it is shown to the user verbatim.
    if (!refused.ok) expect(refused.error).toMatch(/3 already are|Up to 3/);
    expect(queuedMessageCount(id)).toBe(3);

    clearQueuedMessages(id);
  });

  it('refuses an empty message rather than queueing a blank turn', () => {
    const id = thread();
    const r = queueUserMessage(id, '   ');
    expect(r.ok).toBe(false);
    expect(queuedMessageCount(id)).toBe(0);
  });

  it('keeps queues separate per thread', () => {
    const a = thread();
    const b = thread();
    queueUserMessage(a, 'for a');
    expect(queuedMessageCount(a)).toBe(1);
    expect(queuedMessageCount(b)).toBe(0);
    clearQueuedMessages(a);
  });

  it('hands back what was never delivered, so a Stop does not eat it', () => {
    const id = thread();
    queueUserMessage(id, 'first thought');
    queueUserMessage(id, 'second thought');

    const unsent = clearQueuedMessages(id);
    expect(unsent).toEqual(['first thought', 'second thought']);
    expect(queuedMessageCount(id)).toBe(0);
    // Draining twice must not resurrect anything.
    expect(clearQueuedMessages(id)).toEqual([]);
  });

  it('trims what it stores, so trailing whitespace is not delivered as content', () => {
    const id = thread();
    queueUserMessage(id, '  not that file  ');
    expect(clearQueuedMessages(id)).toEqual(['not that file']);
  });
});
