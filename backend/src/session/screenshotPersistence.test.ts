/**
 * A screenshot must not outlive the turn it was taken in.
 *
 * Two problems, one fix. The first is size: a frame is a multi-megabyte base64
 * string, and persisting it means re-reading it on every load of that thread
 * forever, for a picture the model has already looked at.
 *
 * The second is the one that produced a bug report. If a frame is one the
 * provider refuses (too large, too many pixels), persisting it makes that
 * refusal PERMANENT — the thread reloads with the poison still in it and 400s
 * on every subsequent turn, so the conversation can never be used again. Live
 * images, stored text: the worst case becomes one bad turn.
 */
import { createSession, saveTurn, getMessages } from './manager';
import { sanitizeHistory } from '../agent/contextManager';
import type { ContentBlock } from '../types';

describe('screenshot persistence', () => {
  const seedTurn = (sessionId: string, imageCount: number) => {
    saveTurn(sessionId, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'browser_control', input: { action: 'screenshot' } }],
    });
    saveTurn(sessionId, {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: 'Screenshot captured of http://localhost:3000',
          images: Array.from({ length: imageCount }, () => ({ mediaType: 'image/png', data: 'x'.repeat(64) })),
        },
      ],
    });
  };

  it('does not write image data to the database', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    seedTurn(s.id, 1);

    const reloaded = getMessages(s.id);
    const toolResult = (reloaded[1].content as ContentBlock[])[0];
    expect(toolResult.type).toBe('tool_result');
    expect((toolResult as { images?: unknown[] }).images).toBeUndefined();
  });

  it('keeps the result text, and says a picture was there', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    seedTurn(s.id, 1);

    const toolResult = (getMessages(s.id)[1].content as ContentBlock[])[0] as { content: string };
    expect(toolResult.content).toContain('Screenshot captured of http://localhost:3000');
    expect(toolResult.content).toMatch(/screenshot was shown to the model/i);
  });

  it('counts several frames correctly in the note', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    seedTurn(s.id, 3);

    const toolResult = (getMessages(s.id)[1].content as ContentBlock[])[0] as { content: string };
    expect(toolResult.content).toMatch(/3 screenshots were shown/i);
  });

  it('leaves the reloaded history valid — the tool pairing survives', () => {
    const s = createSession({ workspacePath: process.cwd(), provider: 'claude', model: 'm' });
    seedTurn(s.id, 1);

    // sanitizeHistory drops orphaned tool_use / tool_result blocks, so a
    // history that comes back the same length is one the providers will accept.
    const reloaded = getMessages(s.id);
    expect(sanitizeHistory(reloaded)).toHaveLength(reloaded.length);
  });
});
