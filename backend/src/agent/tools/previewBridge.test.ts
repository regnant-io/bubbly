/**
 * Regression tests for the preview bridge reliability contract — the layer that
 * stops agent browser tools from hanging / burning tokens.
 */

import {
  registerPreviewClient,
  unregisterPreviewClient,
  setPreviewCapability,
  isPreviewClientAvailable,
  hasEverSeenCapableClient,
  runPreviewAction,
  resolvePreviewAction,
} from './previewBridge';

// Silence logger noise.
jest.mock('../../utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

describe('previewBridge reliability', () => {
  afterEach(() => {
    // Best-effort cleanup between tests.
    for (const id of ['a', 'b', 'c']) unregisterPreviewClient(id);
  });

  it('a merely-connected client is NOT considered available until it reports capability', () => {
    registerPreviewClient('a', () => {});
    expect(isPreviewClientAvailable()).toBe(false); // connected but not capable
    setPreviewCapability('a', { capable: true, desktop: true, hasWebview: false, url: null });
    expect(isPreviewClientAvailable()).toBe(true);
  });

  it('a stale client closing does NOT disable a healthy live client', () => {
    registerPreviewClient('a', () => {}); // old socket
    registerPreviewClient('b', () => {}); // new socket
    setPreviewCapability('b', { capable: true, desktop: true, hasWebview: true, url: 'http://x' });
    expect(isPreviewClientAvailable()).toBe(true);
    // The old socket's close fires AFTER the new one connected — must not clear b.
    unregisterPreviewClient('a');
    expect(isPreviewClientAvailable()).toBe(true);
  });

  it('a disconnect resolves in-flight actions immediately with transportFailed (no 30s stall)', async () => {
    let sent = false;
    registerPreviewClient('a', () => { sent = true; /* never replies */ });
    setPreviewCapability('a', { capable: true, desktop: true, hasWebview: true, url: 'http://x' });

    const p = runPreviewAction('click', { text: 'Go' });
    // Give the microtask a tick so the pending entry is registered + emitted.
    await Promise.resolve();
    expect(sent).toBe(true);

    unregisterPreviewClient('a'); // client vanishes mid-action
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.transportFailed).toBe(true);
  });

  it('no capable client → transportFailed without waiting', async () => {
    const r = await runPreviewAction('snapshot', {});
    expect(r.ok).toBe(false);
    expect(r.transportFailed).toBe(true);
  });

  it("a renderer reply with reason:'no_webview' is flagged transportFailed", async () => {
    let capturedId = '';
    registerPreviewClient('a', (e) => { capturedId = e.id; });
    setPreviewCapability('a', { capable: true, desktop: true, hasWebview: false, url: null });

    const p = runPreviewAction('click', { text: 'X' });
    await Promise.resolve();
    // Renderer answers that it has no webview to drive.
    resolvePreviewAction(capturedId, { ok: false, result: 'no page', reason: 'no_webview' });
    const r = await p;
    expect(r.transportFailed).toBe(true);
  });

  it('a normal page result is NOT a transport failure', async () => {
    let capturedId = '';
    registerPreviewClient('a', (e) => { capturedId = e.id; });
    setPreviewCapability('a', { capable: true, desktop: true, hasWebview: true, url: 'http://x' });

    const p = runPreviewAction('click', { text: 'Submit' });
    await Promise.resolve();
    resolvePreviewAction(capturedId, { ok: true, result: 'Clicked Submit.' });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.transportFailed).toBeFalsy();
  });

  it('remembers that a capable client was ever seen (for fallback consent)', () => {
    registerPreviewClient('a', () => {});
    setPreviewCapability('a', { capable: true, desktop: true, hasWebview: true, url: null });
    unregisterPreviewClient('a');
    expect(hasEverSeenCapableClient()).toBe(true);
  });
});
