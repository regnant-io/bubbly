import { isCurrentBubblyOrigin } from './previewIdentity';

describe('preview identity', () => {
  it('recognizes the current renderer origin across paths', () => {
    expect(isCurrentBubblyOrigin('http://localhost:34123/project', 'http://localhost:34123/#/chat')).toBe(true);
  });

  it('does not confuse a project dev server on another port with Bubbly', () => {
    expect(isCurrentBubblyOrigin('http://localhost:5173', 'http://localhost:34123')).toBe(false);
  });

  it('fails open for malformed input so normal URL validation can explain it', () => {
    expect(isCurrentBubblyOrigin('http://[', 'http://localhost:34123')).toBe(false);
  });
});
