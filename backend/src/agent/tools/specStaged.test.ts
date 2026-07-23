import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeTool } from './index';
import {
  createSpec,
  readSpec,
  setSpecDesign,
  approveSpecPhase,
  addTaskToSpec,
  addSubTasks,
  getSpecsDir,
} from './specs';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}));

describe('staged three-document spec workflow', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-staged-'));
    // Specs now live OUTSIDE the project; keep that external store inside the
    // temp workspace so the test is self-contained and asserts the real path.
    process.env.BUBBLY_PROJECTS_ROOT = path.join(ws, '__store');
  });
  afterEach(() => {
    delete process.env.BUBBLY_PROJECTS_ROOT;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('starts a staged spec in the requirements phase and writes all three docs', () => {
    const spec = createSpec(ws, { title: 'Auth', type: 'feature', requirements: ['support login'], staged: true });
    expect(spec.phase).toBe('requirements');
    const dir = path.join(getSpecsDir(ws), spec.id);
    expect(fs.existsSync(path.join(dir, 'requirements.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'design.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tasks.md'))).toBe(true);
  });

  it('refuses to author design before requirements are approved', () => {
    const spec = createSpec(ws, { title: 'Auth', type: 'feature', requirements: ['login'], staged: true });
    const r = setSpecDesign(ws, spec.id, '# Design\nstuff');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not been approved/i);
  });

  it('advances requirements → design → tasks → ready through approvals', () => {
    const spec = createSpec(ws, { title: 'Auth', type: 'feature', requirements: ['login'], staged: true });

    // Approve requirements → design phase.
    let r = approveSpecPhase(ws, spec.id, 'requirements');
    expect(r.ok).toBe(true);
    expect(r.nextPhase).toBe('design');

    // Now design is allowed.
    const d = setSpecDesign(ws, spec.id, '# Design\nA real design.');
    expect(d.ok).toBe(true);
    expect(readSpec(ws, spec.id)!.design).toContain('real design');

    // Approve design → tasks phase.
    r = approveSpecPhase(ws, spec.id, 'design');
    expect(r.ok).toBe(true);
    expect(r.nextPhase).toBe('tasks');

    // Can't approve tasks with none present.
    r = approveSpecPhase(ws, spec.id, 'tasks');
    expect(r.ok).toBe(false);

    // Add a task, then approve tasks → ready.
    addTaskToSpec(ws, spec.id, 'Implement login');
    r = approveSpecPhase(ws, spec.id, 'tasks');
    expect(r.ok).toBe(true);
    expect(r.nextPhase).toBe('ready');
    const final = readSpec(ws, spec.id)!;
    expect(final.phase).toBe('ready');
    expect(final.status).toBe('in_progress');
    expect(final.approvals).toEqual({ requirements: true, design: true, tasks: true });
  });

  it('supports nested sub-tasks and renders them to tasks.md', () => {
    const spec = createSpec(ws, { title: 'Auth', type: 'feature', requirements: ['login'] });
    const withTask = addTaskToSpec(ws, spec.id, 'Build API')!;
    const taskId = withTask.tasks[0].id;
    const updated = addSubTasks(ws, spec.id, taskId, [
      { title: 'Define routes', acceptance: 'routes exist' },
      { title: 'Wire handlers' },
    ]);
    expect(updated!.tasks[0].subTasks).toHaveLength(2);
    const tasksMd = fs.readFileSync(path.join(getSpecsDir(ws), spec.id, 'tasks.md'), 'utf8');
    expect(tasksMd).toContain('Define routes');
    expect(tasksMd).toContain('Wire handlers');
  });

  it('non-staged specs are immediately ready (backward compatible)', () => {
    const spec = createSpec(ws, { title: 'Quick', type: 'bugfix', requirements: ['fix it'] });
    expect(spec.phase).toBe('ready');
  });

  it('reports a redundant approval instead of advancing again', () => {
    const spec = createSpec(ws, { title: 'Auth', type: 'feature', requirements: ['login'], staged: true });
    // Approve requirements once → design.
    const first = approveSpecPhase(ws, spec.id, 'requirements');
    expect(first.nextPhase).toBe('design');
    // Approving requirements AGAIN must NOT advance to tasks — it's redundant.
    const second = approveSpecPhase(ws, spec.id, 'requirements');
    expect(second.ok).toBe(true);
    expect(second.alreadyAdvanced).toBe(true);
    expect(readSpec(ws, spec.id)!.phase).toBe('design'); // unchanged
    expect(second.error).toMatch(/already approved/i);
    // And it points at the real pending action (write the design as prose).
    expect(second.error).toMatch(/write the .*design/i);
  });

  it('exposes staged workflow through the tool layer', async () => {
    const res = await executeTool('create_spec', {
      title: 'Feature X', type: 'feature', requirements: ['do X'], staged: true,
    }, ws);
    expect(res.spec?.phase).toBe('requirements');
    expect(res.result).toMatch(/staged/i);
  });
});
