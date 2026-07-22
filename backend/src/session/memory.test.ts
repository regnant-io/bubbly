/**
 * Memory integrity regression tests.
 *
 * Guards the fix for the bug where a tool-only assistant turn lost its tool_use
 * on save, which orphaned the next turn's tool_result and silently wiped the
 * conversation's memory on the very next message.
 */
import { createSession, saveTurn, saveMessage, getMessages } from './manager';
import { sanitizeHistory } from '../agent/contextManager';
import type { Message } from '../types';

describe('conversation memory integrity', () => {
  it('remembers a plain multi-turn conversation', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    saveMessage(s.id, 'user', 'Remember the number 42.');
    saveTurn(s.id, { role: 'assistant', content: 'Got it, 42.' });
    saveMessage(s.id, 'user', 'What number?');
    const reloaded = getMessages(s.id);
    expect(reloaded.length).toBe(3);
    expect(reloaded[0].content).toContain('42');
    expect(reloaded[2].content).toContain('What number');
  });

  it('preserves a tool-only assistant turn and its tool_result pairing', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    saveMessage(s.id, 'user', 'Read a.txt');
    saveTurn(s.id, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
    });
    saveTurn(s.id, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hello world' }],
    });

    const reloaded = getMessages(s.id);
    const assistant = reloaded[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    expect((assistant.content as any[]).some((b) => b.type === 'tool_use' && b.id === 'tu1')).toBe(true);
    const toolResult = reloaded[2];
    expect((toolResult.content as any[]).some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu1')).toBe(true);
  });

  it('keeps correct order for a burst of same-millisecond writes', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    for (let i = 0; i < 12; i++) saveMessage(s.id, i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`);
    const texts = getMessages(s.id).map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(texts).toEqual(['msg-0','msg-1','msg-2','msg-3','msg-4','msg-5','msg-6','msg-7','msg-8','msg-9','msg-10','msg-11']);
  });

  it('sanitizeHistory drops an orphaned tool_use (loop stopped before result saved)', () => {
    const history: Message[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'run_command', input: {} }] },
    ];
    const cleaned = sanitizeHistory(history);
    expect(cleaned.some((m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use' && b.id === 'orphan'))).toBe(false);
    expect(cleaned[0].content).toBe('do it');
  });

  it('sanitizeHistory keeps valid tool_use/tool_result pairs intact', () => {
    const history: Message[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'k', name: 'read_file', input: { path: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k', content: 'data' }] },
      { role: 'assistant', content: 'done' },
    ];
    expect(sanitizeHistory(history).length).toBe(4);
  });
});
