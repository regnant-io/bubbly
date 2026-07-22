import { toEarsProperty, normalizeRequirements } from './specs';

describe('normalizeRequirements (crash fix)', () => {
  it('passes through a clean string array', () => {
    expect(normalizeRequirements(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('wraps a single string into one requirement', () => {
    expect(normalizeRequirements('just one requirement')).toEqual(['just one requirement']);
  });
  it('splits a newline-delimited blob', () => {
    expect(normalizeRequirements('first\nsecond\nthird')).toEqual(['first', 'second', 'third']);
  });
  it('strips list bullets/numbers', () => {
    expect(normalizeRequirements('- one\n2. two\n* three')).toEqual(['one', 'two', 'three']);
  });
  it('extracts statement from objects', () => {
    expect(normalizeRequirements([{ statement: 'x' }, { text: 'y' }])).toEqual(['x', 'y']);
  });
  it('returns [] for null/undefined (no crash)', () => {
    expect(normalizeRequirements(null)).toEqual([]);
    expect(normalizeRequirements(undefined)).toEqual([]);
  });
  it('handles a number without throwing', () => {
    expect(normalizeRequirements(42)).toEqual(['42']);
  });
});

describe('toEarsProperty grammar normalization', () => {
  it('does NOT prepend "THE SYSTEM SHALL" to a statement that already has a subject + modal', () => {
    // The exact mangled case from the trial run.
    const r = toEarsProperty(
      'Language and memetic structures should model language family clustering, institutional stability as attractor states, and belief system mutation rates based on historical analogs',
      4
    );
    expect(r.statement).not.toMatch(/THE SYSTEM SHALL/);
    expect(r.statement.startsWith('Language and memetic structures should model')).toBe(true);
    expect(r.statement.endsWith('.')).toBe(true);
  });

  it('preserves an existing "must" statement verbatim', () => {
    const r = toEarsProperty('The simulator must implement Mendelian inheritance', 0);
    expect(r.statement).toBe('The simulator must implement Mendelian inheritance.');
  });

  it('preserves a "shall" statement verbatim', () => {
    const r = toEarsProperty('Output data shall include trait distribution statistics', 0);
    expect(r.statement).toBe('Output data shall include trait distribution statistics.');
  });

  it('does not double-prepend a subject statement without a modal', () => {
    const r = toEarsProperty('Output data includes technology adoption curves', 0);
    expect(r.statement).toBe('Output data includes technology adoption curves.');
    expect(r.statement).not.toMatch(/THE SYSTEM SHALL/);
  });

  it('wraps a bare imperative capability phrase', () => {
    const r = toEarsProperty('support OAuth login with Google', 0);
    expect(r.statement).toBe('THE SYSTEM SHALL support OAuth login with Google.');
  });

  it('does not produce a double period', () => {
    const r = toEarsProperty('persist user sessions securely.', 0);
    expect(r.statement.endsWith('..')).toBe(false);
    expect(r.statement.endsWith('.')).toBe(true);
  });

  it('classifies constraint / edge_case kinds', () => {
    expect(toEarsProperty('The system must never expose secrets', 0).kind).toBe('constraint');
    expect(toEarsProperty('handle empty input gracefully', 0).kind).toBe('edge_case');
  });
});
