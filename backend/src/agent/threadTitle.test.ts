import { cleanThreadTitle } from './threadTitle';

describe('thread title', () => {
  it('normalizes a model response into one line', () => {
    expect(cleanThreadTitle('  Title: "Fix   sidebar\n navigation."  ', 'ignored'))
      .toBe('Fix sidebar navigation');
  });

  it('falls back to a short slice of the prompt', () => {
    expect(cleanThreadTitle('', 'Investigate the watcher race and fix thread isolation across windows please'))
      .toBe('Investigate the watcher race and fix thread isolation');
  });
});
