/**
 * Specs are three markdown files in the project. These tests pin down the two
 * things that must be true for that to work:
 *
 *   1. Everything the UI shows is DERIVED from the files — write a checkbox,
 *      read back the new status, with no tool and no stored state in between.
 *   2. The files live INSIDE the workspace, unlike every other piece of
 *      Bubbly's per-project state.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getSpecsDir, readSpec, listSpecs, nextTaskOf,
  parseTasksMarkdown, renderTasksMarkdown, isSafeSpecId, slugifyTitle,
} from './specs';
import { writeFile, readFile } from './filesystem';
import { specIdsInDiff } from '../orchestrator';

let workspace: string;
let projectsRoot: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-spec-ws-'));
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-spec-ext-'));
  process.env.BUBBLY_PROJECTS_ROOT = projectsRoot;
});
afterEach(() => {
  delete process.env.BUBBLY_PROJECTS_ROOT;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

function writeSpecFile(specId: string, name: string, content: string) {
  const dir = path.join(workspace, '.bubbly', 'specs', specId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

const TASKS_MD = `# Tasks: Offline Sync

> \`- [ ]\` not started · \`- [~]\` in progress · \`- [x]\` done.

- [x] **T1** Add the sync queue module
  - Files: src/sync/queue.ts
  - Done when: queued writes survive a reload
  - Verify with: npm test src/sync/queue.test.ts
- [~] **T2** Flush the queue when the connection returns
  - Depends on: T1
  - Requirements: R-2
- [ ] **T3** Show a pending-writes badge
  - Depends on: T2
`;

describe('specs live inside the project', () => {
  it('resolves to <workspace>/.bubbly/specs', () => {
    expect(getSpecsDir(workspace)).toBe(path.join(path.resolve(workspace), '.bubbly', 'specs'));
  });

  it('is reachable through the ordinary file tools at the same path the agent is told to use', async () => {
    await writeFile(workspace, '.bubbly/specs/offline-sync/requirements.md', '# Offline Sync\n\n- **R-1** queue writes\n');

    // Written where a human can find it — NOT redirected out to ~/.bubbly.
    const onDisk = path.join(workspace, '.bubbly', 'specs', 'offline-sync', 'requirements.md');
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(await readFile(workspace, '.bubbly/specs/offline-sync/requirements.md')).toContain('R-1');

    // …and the reader sees the same file.
    expect(readSpec(workspace, 'offline-sync')!.requirements).toEqual(['R-1: queue writes']);
  });

  it('still redirects NON-spec .bubbly state out of the project', async () => {
    await writeFile(workspace, '.bubbly/browser-meta.json', '{}');
    expect(fs.existsSync(path.join(workspace, '.bubbly', 'browser-meta.json'))).toBe(false);
  });
});

describe('readSpec derives everything from the markdown', () => {
  it('returns null for a directory with none of the three documents', () => {
    fs.mkdirSync(path.join(workspace, '.bubbly', 'specs', 'empty'), { recursive: true });
    expect(readSpec(workspace, 'empty')).toBeNull();
  });

  it('takes the title from the first heading', () => {
    writeSpecFile('offline-sync', 'requirements.md', '# Offline Sync\n\n- **R-1** queue writes\n');
    expect(readSpec(workspace, 'offline-sync')!.title).toBe('Offline Sync');
  });

  it('strips a "Tasks:" prefix rather than showing it as the title', () => {
    writeSpecFile('offline-sync', 'tasks.md', TASKS_MD);
    expect(readSpec(workspace, 'offline-sync')!.title).toBe('Offline Sync');
  });

  it('falls back to a prettified slug when no document has a heading', () => {
    writeSpecFile('fix-login-race', 'tasks.md', '- [ ] **T1** do the thing\n');
    expect(readSpec(workspace, 'fix-login-race')!.title).toBe('Fix Login Race');
  });

  it('derives phase from which documents exist', () => {
    writeSpecFile('s', 'requirements.md', '# S\n\n- **R-1** a thing\n');
    expect(readSpec(workspace, 's')!.phase).toBe('design');

    writeSpecFile('s', 'design.md', '# Design: S\n\nUse a queue.\n');
    expect(readSpec(workspace, 's')!.phase).toBe('tasks');

    writeSpecFile('s', 'tasks.md', '- [ ] **T1** build it\n');
    expect(readSpec(workspace, 's')!.phase).toBe('ready');
  });

  it('ignores the "not authored yet" design placeholder', () => {
    writeSpecFile('s', 'requirements.md', '# S\n\n- **R-1** a thing\n');
    writeSpecFile('s', 'design.md', '# Design: S\n\n_Design not authored yet. It will be written later._\n');
    expect(readSpec(workspace, 's')!.design).toBeUndefined();
    expect(readSpec(workspace, 's')!.phase).toBe('design');
  });

  it('derives status from the checkboxes', () => {
    writeSpecFile('s', 'tasks.md', '- [ ] **T1** a\n- [ ] **T2** b\n');
    expect(readSpec(workspace, 's')!.status).toBe('draft');

    writeSpecFile('s', 'tasks.md', '- [x] **T1** a\n- [ ] **T2** b\n');
    expect(readSpec(workspace, 's')!.status).toBe('in_progress');

    writeSpecFile('s', 'tasks.md', '- [x] **T1** a\n- [x] **T2** b\n');
    expect(readSpec(workspace, 's')!.status).toBe('done');
  });

  it('refuses a traversing spec id', () => {
    expect(isSafeSpecId('../../etc')).toBe(false);
    expect(readSpec(workspace, '../../etc')).toBeNull();
  });
});

describe('editing one checkbox is the whole state transition', () => {
  it('a marker change is visible to the reader with no tool in between', async () => {
    await writeFile(workspace, '.bubbly/specs/offline-sync/tasks.md', TASKS_MD);
    expect(readSpec(workspace, 'offline-sync')!.tasks.map((t) => t.status))
      .toEqual(['done', 'in_progress', 'todo']);

    // Exactly what the agent is told to do: change one character.
    const p = '.bubbly/specs/offline-sync/tasks.md';
    const before = await readFile(workspace, p);
    await writeFile(workspace, p, before.replace('- [~] **T2**', '- [x] **T2**'));

    const after = readSpec(workspace, 'offline-sync')!;
    expect(after.tasks.map((t) => t.status)).toEqual(['done', 'done', 'todo']);
    expect(after.status).toBe('in_progress');
  });

  it('carries a task\'s metadata through', () => {
    const [t1, t2] = parseTasksMarkdown(TASKS_MD);
    expect(t1.targetFiles).toEqual(['src/sync/queue.ts']);
    expect(t1.acceptance).toBe('queued writes survive a reload');
    expect(t1.verifyWith).toBe('npm test src/sync/queue.test.ts');
    expect(t2.dependsOn).toEqual(['T1']);
    expect(t2.satisfiesProperties).toEqual(['R-2']);
  });

  it('round-trips through the renderer, so the parser cannot drift from the documented format', () => {
    const tasks = parseTasksMarkdown(TASKS_MD);
    const reparsed = parseTasksMarkdown(renderTasksMarkdown({ title: 'Offline Sync', tasks }));
    expect(reparsed).toEqual(tasks);
  });
});

describe('nextTaskOf', () => {
  it('resumes an in-progress task before starting a new one', () => {
    writeSpecFile('s', 'tasks.md', TASKS_MD);
    expect(nextTaskOf(readSpec(workspace, 's')!)!.id).toBe('T2');
  });

  it('skips a task whose dependency is not done yet', () => {
    writeSpecFile('s', 'tasks.md', [
      '- [ ] **T1** foundation',
      '- [ ] **T2** needs the foundation',
      '  - Depends on: T1',
    ].join('\n'));
    expect(nextTaskOf(readSpec(workspace, 's')!)!.id).toBe('T1');
  });

  it('returns null when everything is done', () => {
    writeSpecFile('s', 'tasks.md', '- [x] **T1** a\n');
    expect(nextTaskOf(readSpec(workspace, 's')!)).toBeNull();
  });
});

describe('listSpecs', () => {
  it('lists spec folders and ignores stray files', () => {
    writeSpecFile('alpha', 'requirements.md', '# Alpha\n\n- **R-1** x\n');
    writeSpecFile('beta', 'tasks.md', '- [ ] **T1** y\n');
    fs.writeFileSync(path.join(workspace, '.bubbly', 'specs', '.DS_Store'), '');
    expect(listSpecs(workspace).map((s) => s.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('is empty rather than throwing when no specs directory exists', () => {
    expect(listSpecs(workspace)).toEqual([]);
  });
});

describe('specIdsInDiff — how a session learns which spec it is writing', () => {
  it('picks the spec name out of a written path', () => {
    expect(specIdsInDiff([{ path: '.bubbly/specs/offline-sync/requirements.md' }])).toEqual(['offline-sync']);
    expect(specIdsInDiff([{ path: '.bubbly\\specs\\offline-sync\\tasks.md' }])).toEqual(['offline-sync']);
  });

  it('deduplicates across several files of the same spec', () => {
    expect(specIdsInDiff([
      { path: '.bubbly/specs/s/requirements.md' },
      { path: '.bubbly/specs/s/design.md' },
    ])).toEqual(['s']);
  });

  it('ignores ordinary source files', () => {
    expect(specIdsInDiff([{ path: 'src/index.ts' }, { path: 'README.md' }])).toEqual([]);
  });
});

describe('slugifyTitle', () => {
  it('produces a readable directory name', () => {
    expect(slugifyTitle('Glassmorphic To-do List')).toBe('glassmorphic-to-do-list');
    expect(slugifyTitle('Fix: login race!!')).toBe('fix-login-race');
  });
  it('falls back when a title has nothing usable', () => {
    expect(slugifyTitle('!!!', 'feature')).toBe('feature');
  });
});
