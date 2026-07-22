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
    expect(selectSkills('hello world', skills).map((s) => s.name)).toEqual(['always']);
    expect(selectSkills('please deploy now', skills).map((s) => s.name).sort()).toEqual(['always', 'kw']);
  });
});
