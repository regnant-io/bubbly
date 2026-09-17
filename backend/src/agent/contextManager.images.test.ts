import { historyHasImages, stripHistoryImages, sanitizeHistory } from './contextManager';
import type { Message } from '../types';

/**
 * The recovery that turns "this thread is dead" into "that one turn failed".
 *
 * A provider refuses an oversized image with a 400. The frame is already in the
 * history, so the retry, and every later turn, sends it again and fails
 * identically. Removing the images has to leave a history that is still VALID —
 * every tool_use still paired with its tool_result — or the fix trades one
 * permanent 400 for another.
 */
describe('stripHistoryImages', () => {
  const withImage = (): Message[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'browser_control', input: { action: 'screenshot' } }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'Screenshot captured of http://localhost:3000',
          images: [{ mediaType: 'image/png', data: 'AAAA' }],
        },
      ],
    },
  ];

  it('detects images anywhere in the history', () => {
    expect(historyHasImages(withImage())).toBe(true);
    expect(historyHasImages([{ role: 'user', content: 'plain text' }])).toBe(false);
    expect(
      historyHasImages([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'no picture' }] },
      ]),
    ).toBe(false);
  });

  it('removes the images and counts them', () => {
    const { messages, removed } = stripHistoryImages(withImage());
    expect(removed).toBe(1);
    expect(historyHasImages(messages)).toBe(false);
  });

  it('keeps the tool_result and its text, so the history stays valid', () => {
    const { messages } = stripHistoryImages(withImage());
    // The pairing survives: sanitizeHistory drops orphans, so an intact
    // conversation must come back unchanged in length.
    expect(sanitizeHistory(messages)).toHaveLength(2);
    const block = (messages[1].content as Array<{ type: string; content: string }>)[0];
    expect(block.type).toBe('tool_result');
    expect(block.content).toContain('Screenshot captured of http://localhost:3000');
  });

  it('tells the model it has not actually seen the picture', () => {
    const { messages } = stripHistoryImages(withImage());
    const block = (messages[1].content as Array<{ content: string }>)[0];
    expect(block.content).toMatch(/have NOT seen it/i);
  });

  it('leaves image-free messages untouched by identity', () => {
    const clean: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const { messages, removed } = stripHistoryImages(clean);
    expect(removed).toBe(0);
    expect(messages[0]).toBe(clean[0]);
    expect(messages[1]).toBe(clean[1]);
  });

  it('strips every image across several turns', () => {
    const many: Message[] = [
      ...withImage(),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: 'Two frames',
            images: [
              { mediaType: 'image/png', data: 'A' },
              { mediaType: 'image/png', data: 'B' },
            ],
          },
        ],
      },
    ];
    const { removed, messages } = stripHistoryImages(many);
    expect(removed).toBe(3);
    expect(historyHasImages(messages)).toBe(false);
  });
});
