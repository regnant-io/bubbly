import { planParallelBatch, MAX_PARALLEL_AGENTS } from './parallelAgents';

describe('planParallelBatch', () => {
  it('accepts disjoint assignments with target files', () => {
    const plan = planParallelBatch([
      { instruction: 'Build header', targetFiles: ['src/Header.tsx'] },
      { instruction: 'Build footer', targetFiles: ['src/Footer.tsx'] },
    ]);
    expect(plan.ok).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(planParallelBatch([]).ok).toBe(false);
  });

  it('rejects more than the max parallel count', () => {
    const many = Array.from({ length: MAX_PARALLEL_AGENTS + 1 }, (_, i) => ({
      instruction: `task ${i}`,
      targetFiles: [`src/file${i}.ts`],
    }));
    const plan = planParallelBatch(many);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/Too many/);
  });

  it('rejects assignments without target files', () => {
    const plan = planParallelBatch([
      { instruction: 'do a thing' },
      { instruction: 'do another', targetFiles: ['src/b.ts'] },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/target_files/);
  });

  it('rejects an empty instruction', () => {
    const plan = planParallelBatch([
      { instruction: '   ', targetFiles: ['src/a.ts'] },
    ]);
    expect(plan.ok).toBe(false);
  });

  it('detects overlapping files between assignments', () => {
    const plan = planParallelBatch([
      { instruction: 'edit shared', targetFiles: ['src/shared.ts', 'src/a.ts'] },
      { instruction: 'also edit shared', targetFiles: ['src/shared.ts', 'src/b.ts'] },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.conflicts).toContain('src/shared.ts');
  });

  it('normalizes path separators and (on Windows) case when detecting conflicts', () => {
    const plan = planParallelBatch([
      { instruction: 'a', targetFiles: ['src/Comp.ts'] },
      { instruction: 'b', targetFiles: ['./src\\Comp.ts'] },
    ]);
    // On Windows these collide (case-insensitive + slash-normalized); on posix
    // the backslash variant is a different literal path, so it won't collide.
    if (process.platform === 'win32') {
      expect(plan.ok).toBe(false);
    } else {
      expect(plan.ok).toBe(true);
    }
  });
});
