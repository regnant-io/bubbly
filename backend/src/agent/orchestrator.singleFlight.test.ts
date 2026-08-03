/**
 * One thread runs once at a time.
 *
 * Before this guard existed, `runAgentLoop` started work for whatever it was
 * handed with no regard for whether that thread was ALREADY working. Two chat
 * messages for one session — a double-tap on Send, a reconnect replaying a
 * queued message, a second window open on the same thread — produced two
 * complete agent loops over one conversation. Both streamed into the same
 * socket, both appended to the same history, and both executed their tool
 * calls: the generation branched and every tool fired twice. The second loop
 * also overwrote the first's stop handle, so Stop reached only the newer one
 * while the older kept running and kept writing files.
 *
 * These tests pin the guard at both levels it has to hold: an existing session
 * (matched by id) and a brand-new thread (which has no id yet, so the
 * connection-level guard in index.ts is what catches it).
 */

import { runAgentLoop, isSessionRunning } from './orchestrator';
import { setSetting } from '../db/index';
import type { WSServerEvent } from '../types';

jest.setTimeout(30_000);

jest.mock('../models/index', () => ({ callModel: jest.fn() }));

jest.mock('./tools/index', () => ({
  TOOL_DEFINITIONS: [{ name: 'read_file', description: 'Read a file', input_schema: {} }],
  executeTool: jest.fn(),
  checkRequiresApproval: jest.fn(() => ({ required: false, autoDecline: false })),
}));

jest.mock('../steering/loader', () => ({
  loadSteeringContext: jest.fn(() => ''),
  loadReadme: jest.fn(() => ''),
  detectProjectType: jest.fn(() => 'node'),
}));

jest.mock('../session/manager', () => ({
  createSession: jest.fn(() => ({ id: 'sess-single-flight' })),
  updateSessionStatus: jest.fn(),
  saveMessage: jest.fn(),
  saveTurn: jest.fn(),
  getMessages: jest.fn(() => []),
  logAuditEvent: jest.fn(),
  updateFirstMessage: jest.fn(),
  getSession: jest.fn(() => null),
  updateSessionSpecId: jest.fn(),
}));

jest.mock('./tools/specs', () => ({
  lockSpecToSession: jest.fn(),
  getNextTask: jest.fn(),
  updateTaskStatus: jest.fn(),
  areAllTasksComplete: jest.fn(),
  updateSpec: jest.fn(),
}));

describe('a session runs single-flight', () => {
  const { callModel } = require('../models/index');

  beforeEach(() => {
    jest.clearAllMocks();
    setSetting('defaultProvider', 'ollama');
    setSetting('ollamaModel', 'llama3.1');
    setSetting('ollamaBaseUrl', 'http://localhost:11434');
    setSetting('requireApprovalForWrites', 'false');
    setSetting('requireApprovalForShell', 'false');
  });

  it('refuses a second run for a session that is already working', async () => {
    const SESSION = 'sess-already-busy';
    // Hold the first run inside the model call so the second arrives while it
    // is genuinely mid-flight — the exact race a double-send creates.
    let releaseFirst: () => void = () => {};
    const firstCallReached = new Promise<void>((resolve) => {
      callModel.mockImplementation(async () => {
        resolve();
        await new Promise<void>((r) => { releaseFirst = r; });
        return { textContent: 'done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      });
    });

    const firstEvents: WSServerEvent[] = [];
    const first = runAgentLoop({
      sessionId: SESSION,
      userMessage: 'first',
      workspacePath: '/test/workspace',
      onEvent: (e) => firstEvents.push(e),
    });

    await firstCallReached;
    expect(isSessionRunning(SESSION)).toBe(true);

    const secondEvents: WSServerEvent[] = [];
    await runAgentLoop({
      sessionId: SESSION,
      userMessage: 'second',
      workspacePath: '/test/workspace',
      onEvent: (e) => secondEvents.push(e),
    });

    // The second request must not have reached the model at all — one call,
    // from the first run, is the whole point.
    expect(callModel).toHaveBeenCalledTimes(1);
    const refusal = secondEvents.find((e) => e.type === 'error');
    expect(refusal).toBeDefined();
    expect((refusal as { message: string }).message).toMatch(/already running/i);

    releaseFirst();
    await first;
    // And the guard releases, so the thread is usable again afterwards.
    expect(isSessionRunning(SESSION)).toBe(false);
  });

  it('releases the guard even when the run throws', async () => {
    const SESSION = 'sess-throws';
    callModel.mockRejectedValue(new Error('API key invalid'));

    await runAgentLoop({
      sessionId: SESSION,
      userMessage: 'boom',
      workspacePath: '/test/workspace',
      onEvent: () => { /* ignore */ },
    }).catch(() => { /* the loop rethrows a first-iteration failure */ });

    // A failed run that left the thread permanently "busy" would be worse than
    // the bug this guard fixes — the user could never send anything again.
    expect(isSessionRunning(SESSION)).toBe(false);
  });

  it('lets a different session run concurrently', async () => {
    // Every in-flight model call parks on its own releaser — both runs reach
    // the model here, so a single shared one would strand whichever call
    // registered first.
    const parked: Array<() => void> = [];
    let onFirstCall: () => void = () => {};
    const aReached = new Promise<void>((resolve) => { onFirstCall = resolve; });
    callModel.mockImplementation(async () => {
      onFirstCall();
      await new Promise<void>((r) => parked.push(r));
      return { textContent: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const a = runAgentLoop({ sessionId: 'sess-a', userMessage: 'a', workspacePath: '/w', onEvent: () => {} });
    await aReached;

    const bEvents: WSServerEvent[] = [];
    const b = runAgentLoop({ sessionId: 'sess-b', userMessage: 'b', workspacePath: '/w', onEvent: (e) => bEvents.push(e) });

    // Separate threads are independent; the guard is per-session, not global.
    expect(bEvents.some((e) => e.type === 'error' && /already running/i.test(e.message))).toBe(false);

    // Let both model calls return. Poll rather than assume ordering: b's call
    // may not have been made yet at the moment we release.
    for (let i = 0; i < 100 && parked.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    while (parked.length) parked.pop()!();
    await Promise.all([a, b]);
  });
});
