import { renderTasksMarkdown, parseTasksMarkdown, parseRequirementsMarkdown } from './specs';
import type { Spec, SpecTask } from '../../types';

function makeSpec(tasks: SpecTask[]): Spec {
  return {
    id: 'demo-spec',
    title: 'Demo Spec',
    type: 'feature',
    status: 'in_progress',
    requirements: [],
    tasks,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('tasks.md as the source of truth', () => {
  const tasks: SpecTask[] = [
    {
      id: 'T1',
      title: 'Add the parser',
      status: 'done',
      targetFiles: ['src/a.ts', 'src/b.ts'],
      acceptance: 'round-trips cleanly',
    },
    {
      id: 'T2',
      title: 'Wire it into readSpec',
      status: 'in_progress',
      dependsOn: ['T1'],
      satisfiesProperties: ['P1', 'P2'],
    },
    {
      id: 'T3',
      title: 'Render it in the UI',
      status: 'todo',
      subTasks: [
        { id: 'T3.1', title: 'Checklist view', status: 'done', acceptance: 'shows progress' },
        { id: 'T3.2', title: 'Markdown view', status: 'todo' },
      ],
    },
  ];

  it('round-trips render -> parse without losing anything', () => {
    const md = renderTasksMarkdown(makeSpec(tasks));
    const parsed = parseTasksMarkdown(md);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      id: 'T1',
      title: 'Add the parser',
      status: 'done',
      targetFiles: ['src/a.ts', 'src/b.ts'],
      acceptance: 'round-trips cleanly',
    });
    expect(parsed[1]).toMatchObject({
      id: 'T2',
      title: 'Wire it into readSpec',
      status: 'in_progress',
      dependsOn: ['T1'],
      satisfiesProperties: ['P1', 'P2'],
    });
    expect(parsed[2].subTasks).toHaveLength(2);
    expect(parsed[2].subTasks![0]).toMatchObject({ title: 'Checklist view', status: 'done', acceptance: 'shows progress' });
    expect(parsed[2].subTasks![1]).toMatchObject({ title: 'Markdown view', status: 'todo' });
  });

  it('is stable across a second round-trip', () => {
    const once = renderTasksMarkdown(makeSpec(tasks));
    const twice = renderTasksMarkdown(makeSpec(parseTasksMarkdown(once)));
    expect(twice).toBe(once);
  });

  it('picks up a status change made by editing the marker', () => {
    const md = renderTasksMarkdown(makeSpec(tasks));
    // Exactly what the agent does: flip one character.
    const edited = md.replace('- [~] **T2**', '- [x] **T2**');
    const parsed = parseTasksMarkdown(edited);
    expect(parsed.find((t) => t.id === 'T2')!.status).toBe('done');
  });

  it('does not parse the legend in the header as tasks', () => {
    const md = renderTasksMarkdown(makeSpec([]));
    expect(parseTasksMarkdown(md)).toHaveLength(0);
  });

  it('tolerates hand-written markdown without ids or metadata', () => {
    const parsed = parseTasksMarkdown(
      ['# Tasks', '', '- [ ] first thing', '- [x] second thing', '- [-] third thing'].join('\n')
    );
    expect(parsed).toHaveLength(3);
    expect(parsed.map((t) => t.status)).toEqual(['todo', 'done', 'in_progress']);
    // Ids are synthesized so dependsOn references still have something to point at.
    expect(parsed.map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
    expect(parsed[0].title).toBe('first thing');
  });

  it('still understands the older "(status)" suffix format', () => {
    const parsed = parseTasksMarkdown('- [x] **T1** Old style task (done)');
    expect(parsed[0]).toMatchObject({ id: 'T1', title: 'Old style task', status: 'done' });
  });
});

/**
 * In the design-first flow there was no tool that could persist requirements —
 * create_spec was the only writer and had already run — so specs authored
 * design-first always ended up with an empty requirements list. Reading
 * requirements.md back is what fixes that.
 */
describe('requirements.md parsing', () => {
  it('reads EARS-style properties, keeping ids and stripping kind prefixes', () => {
    const md = [
      '# Performance Profiling',
      '',
      '**Type:** feature  ·  **Status:** draft',
      '',
      '## Acceptance Properties (EARS)',
      '',
      '- **P1** (functional): When scrolling, the frame rate shall stay at 60fps.',
      '  - _Acceptance:_ measured in Chrome performance panel',
      '- **P2** (non-functional): The app shall have zero Long Tasks over 50ms.',
    ].join('\n');

    // The id is KEPT: design.md and tasks.md refer back to it ("Requirements:
    // P1"), so dropping it would sever the traceability the spec format runs on.
    expect(parseRequirementsMarkdown(md)).toEqual([
      'P1: When scrolling, the frame rate shall stay at 60fps.',
      'P2: The app shall have zero Long Tasks over 50ms.',
    ]);
  });

  it('reads a plain numbered list', () => {
    const md = ['# Requirements', '', '1. Frame rate stability', '2. Main thread responsiveness'].join('\n');
    expect(parseRequirementsMarkdown(md)).toEqual(['Frame rate stability', 'Main thread responsiveness']);
  });

  it('ignores headers, metadata and blockquotes', () => {
    const md = ['# Title', '> a note', '', '**Type:** feature', '', '- Real requirement'].join('\n');
    expect(parseRequirementsMarkdown(md)).toEqual(['Real requirement']);
  });

  it('returns nothing for an unauthored document', () => {
    expect(parseRequirementsMarkdown('# Requirements\n\n_Not authored yet._\n')).toEqual([]);
  });
});
