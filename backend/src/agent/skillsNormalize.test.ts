import { normalizeSkills, selectSkills } from './skills';

describe('normalizeSkills', () => {
  it('parses the native array form', () => {
    const out = normalizeSkills(JSON.stringify([
      { id: 's1', name: 'Testing', description: 'd', instructions: 'do x', keywords: ['test'], enabled: true },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Testing');
    expect(out[0].keywords).toEqual(['test']);
  });

  it('parses an object keyed by skill name', () => {
    const out = normalizeSkills({ 'Code Review': { description: 'reviews', instructions: 'review carefully' } });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Code Review');
    expect(out[0].id).toBe('code-review');
    expect(out[0].enabled).toBe(true);
  });

  it('accepts instruction field variations', () => {
    expect(normalizeSkills([{ name: 'a', content: 'c' }])[0].instructions).toBe('c');
    expect(normalizeSkills([{ name: 'b', body: 'bod' }])[0].instructions).toBe('bod');
    expect(normalizeSkills([{ name: 'c', prompt: 'p' }])[0].instructions).toBe('p');
    expect(normalizeSkills([{ name: 'd', text: 't' }])[0].instructions).toBe('t');
  });

  it('accepts keywords as a delimited string and triggers/tags aliases', () => {
    expect(normalizeSkills([{ name: 'a', instructions: 'x', keywords: 'one, two\nthree' }])[0].keywords)
      .toEqual(['one', 'two', 'three']);
    expect(normalizeSkills([{ name: 'b', instructions: 'x', triggers: ['t1'] }])[0].keywords).toEqual(['t1']);
    expect(normalizeSkills([{ name: 'c', instructions: 'x', tags: 'tag1 ,tag2' }])[0].keywords).toEqual(['tag1', 'tag2']);
  });

  it('honors disabled:true and enabled:false', () => {
    expect(normalizeSkills([{ name: 'a', instructions: 'x', disabled: true }])[0].enabled).toBe(false);
    expect(normalizeSkills([{ name: 'b', instructions: 'x', enabled: false }])[0].enabled).toBe(false);
  });

  it('skips entries without a name and never throws on garbage', () => {
    expect(normalizeSkills([{ instructions: 'no name' }])).toHaveLength(0);
    expect(normalizeSkills('not json')).toEqual([]);
    expect(normalizeSkills(null)).toEqual([]);
  });

  it('gives distinct ids to duplicate-named skills', () => {
    const out = normalizeSkills([{ name: 'dup', instructions: 'a' }, { name: 'dup', instructions: 'b' }]);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it('integrates with selectSkills (keyword + always-on)', () => {
    const skills = normalizeSkills([
      { name: 'always', instructions: 'x' },
      { name: 'kw', instructions: 'y', keywords: ['deploy'] },
    ]);
    expect(selectSkills('hello world', { skills }).map((s) => s.name)).toEqual(['always']);
    expect(selectSkills('please deploy now', { skills }).map((s) => s.name).sort())
      .toEqual(['always', 'kw']);
  });

  it('matches a trigger as a WORD, not as a substring', () => {
    // The whole skill system depends on this. A substring match for "api" fires
    // on "rapid", "css" on "success", "go" on "going" — and within a handful of
    // skills every message activates every skill.
    const skills = normalizeSkills([{ name: 'api', instructions: 'y', keywords: ['api'] }]);
    expect(selectSkills('rapid prototyping', { skills })).toHaveLength(0);
    expect(selectSkills('the api returns 404', { skills })).toHaveLength(1);
  });

  it('still matches a trigger next to punctuation and underscores', () => {
    const skills = normalizeSkills([{ name: 'api', instructions: 'y', keywords: ['api'] }]);
    expect(selectSkills('read api_key from env', { skills })).toHaveLength(1);
    expect(selectSkills('(api)', { skills })).toHaveLength(1);
  });

  it('matches a multi-word trigger however it is separated', () => {
    const skills = normalizeSkills([
      { name: 'race', instructions: 'y', keywords: ['race condition'] },
    ]);
    for (const text of ['a race condition', 'a race-condition', 'a race_condition']) {
      expect(selectSkills(text, { skills })).toHaveLength(1);
    }
    expect(selectSkills('a race in the condition', { skills })).toHaveLength(0);
  });

  it('activates on the file types in play, not only on words', () => {
    const skills = normalizeSkills([
      { name: 'react', instructions: 'y', keywords: ['react'], fileHints: ['tsx'] },
    ]);
    // "fix this" names no technology — the open file is the only signal there is.
    expect(selectSkills('fix this', { skills, contextFiles: ['src/App.tsx'] })).toHaveLength(1);
    expect(selectSkills('fix this', { skills, contextFiles: ['main.go'] })).toHaveLength(0);
  });

  it('ranks a more specific trigger above a vaguer one', () => {
    const skills = normalizeSkills([
      { name: 'vague', instructions: 'y', keywords: ['test'] },
      { name: 'specific', instructions: 'y', keywords: ['flaky test'] },
    ]);
    const ranked = selectSkills('this flaky test again', { skills });
    expect(ranked[0].name).toBe('specific');
  });

  it('caps how many skills can be active at once', () => {
    const many = normalizeSkills(
      Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, instructions: 'y', keywords: ['deploy'] })),
    );
    expect(selectSkills('deploy', { skills: many }).length).toBeLessThanOrEqual(8);
  });
});
