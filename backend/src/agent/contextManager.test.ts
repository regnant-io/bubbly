import { compactHistory, estimateTokens, estimateTotalTokens } from './contextManager';
import type { Message } from '../types';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}
function toolResultMsg(id: string, content: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

describe('context manager', () => {
  it('estimates tokens roughly by characters', () => {
    expect(estimateTokens(userMsg('a'.repeat(40)))).toBe(10);
    expect(estimateTotalTokens([userMsg('abcd'), userMsg('abcd')])).toBe(2);
  });

  it('is a no-op when history is small', () => {
    const messages = [userMsg('do the thing'), assistantMsg('ok'), toolResultMsg('t1', 'result')];
    const result = compactHistory(messages, { maxTokens: 24000 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('compacts when over budget but preserves the goal (first user message)', () => {
    const goal = userMsg('GOAL: build the authentication system end to end');
    const filler: Message[] = [];
    for (let i = 0; i < 40; i++) {
      filler.push(assistantMsg('working '.repeat(200)));
      filler.push(toolResultMsg(`t${i}`, 'X'.repeat(8000)));
    }
    const recent = [assistantMsg('almost done'), userMsg('continue please')];
    const messages = [goal, ...filler, ...recent];

    const result = compactHistory(messages, { maxTokens: 8000, keepRecent: 6 });
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // The goal is always retained.
    const firstUser = result.messages.find((m) => m.role === 'user');
    expect(firstUser).toBeDefined();
    expect(typeof firstUser!.content === 'string' && firstUser!.content.includes('GOAL')).toBe(true);
  });

  it('keeps the most recent messages verbatim', () => {
    const goal = userMsg('the goal');
    const filler: Message[] = [];
    for (let i = 0; i < 30; i++) filler.push(toolResultMsg(`t${i}`, 'Y'.repeat(6000)));
    const lastMarker = assistantMsg('UNIQUE_RECENT_MARKER_42');
    const messages = [goal, ...filler, lastMarker];

    const result = compactHistory(messages, { maxTokens: 6000, keepRecent: 4 });
    const last = result.messages[result.messages.length - 1];
    expect(typeof last.content === 'string' && last.content.includes('UNIQUE_RECENT_MARKER_42')).toBe(true);
  });

  it('truncates oversized tool results rather than dropping them', () => {
    const goal = userMsg('goal');
    const filler: Message[] = [];
    for (let i = 0; i < 25; i++) filler.push(toolResultMsg(`t${i}`, 'Z'.repeat(9000)));
    const recent = [assistantMsg('recent work')];
    const messages = [goal, ...filler, ...recent];

    const result = compactHistory(messages, { maxTokens: 7000, keepRecent: 4, maxToolResultChars: 1000 });
    expect(result.compacted).toBe(true);
    // Result still has structure; nothing throws and budget reduced.
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('drops redundant "continue" nudges from the middle', () => {
    const goal = userMsg('goal');
    const middle: Message[] = [];
    for (let i = 0; i < 20; i++) {
      middle.push(assistantMsg('chunk ' + 'm'.repeat(1500)));
      middle.push(userMsg('please continue'));
    }
    const recent = [assistantMsg('end')];
    const messages = [goal, ...middle, ...recent];

    const result = compactHistory(messages, { maxTokens: 5000, keepRecent: 4 });
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});
