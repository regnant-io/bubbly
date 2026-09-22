/**
 * Naming a new thread must never hold up the thread.
 *
 * The title used to be generated with an `await` between `session_created`
 * and the start of the run, so a new thread sat blank for as long as the title
 * call took — up to its 20s timeout on a slow or rate-limited provider. From
 * the window it looked hung; reopening the thread later showed the steps had
 * happened after all. The title now runs alongside the turn and lands as its
 * own `thread_title` event whenever it is ready.
 */

import { runAgentLoop } from './orchestrator';
import { setSetting } from '../db/index';
import type { WSServerEvent } from '../types';

jest.setTimeout(15_000);

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
  createSession: jest.fn(() => ({ id: 'sess-title-race' })),
  updateSessionStatus: jest.fn(),
  saveMessage: jest.fn(),
  saveTurn: jest.fn(),
  getMessages: jest.fn(() => []),
  logAuditEvent: jest.fn(),
  updateFirstMessage: jest.fn(),
  updateThreadName: jest.fn(),
  getSession: jest.fn(() => null),
  updateSessionSpecId: jest.fn(),
}));

let releaseTitle: (title: string) => void = () => {};
jest.mock('./threadTitle', () => ({
  generateThreadTitle: jest.fn(() => new Promise<string>((resolve) => { releaseTitle = resolve; })),
}));

jest.mock('./tools/specs', () => ({
  lockSpecToSession: jest.fn(),
  getNextTask: jest.fn(),
  updateTaskStatus: jest.fn(),
  areAllTasksComplete: jest.fn(),
  updateSpec: jest.fn(),
}));

describe('a new thread is titled in parallel with its first turn', () => {
  const { callModel } = require('../models/index');
  const { updateThreadName } = require('../session/manager');

  beforeEach(() => {
    jest.clearAllMocks();
    setSetting('defaultProvider', 'ollama');
    setSetting('ollamaModel', 'llama3.1');
    setSetting('ollamaBaseUrl', 'http://localhost:11434');
    callModel.mockResolvedValue({
      textContent: 'Hello.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it('finishes the turn while the title call is still outstanding', async () => {
    const events: WSServerEvent[] = [];
    // The title promise never settles during the run. Before the fix this
    // await would hang here until the test timed out.
    await runAgentLoop({
      userMessage: 'hello there',
      workspacePath: '/test/workspace',
      onEvent: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('session_created');
    expect(types).toContain('run_started');
    expect(callModel).toHaveBeenCalled();
    expect(types).not.toContain('thread_title');

    // And when the title does arrive, it is stored and announced for the
    // thread it belongs to.
    releaseTitle('Greeting the agent');
    await new Promise((r) => setImmediate(r));
    expect(updateThreadName).toHaveBeenCalledWith('sess-title-race', 'Greeting the agent');
    const titled = events.find((e) => e.type === 'thread_title') as { sessionId: string; title: string } | undefined;
    expect(titled).toEqual({ type: 'thread_title', sessionId: 'sess-title-race', title: 'Greeting the agent' });
  });
});
