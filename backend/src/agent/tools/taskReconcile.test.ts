import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeTool } from './index';
import { createSpec, addTaskToSpec, readSpec } from './specs';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}));

describe('task status reconciliation (no FALSE completion)', () => {
  let ws: string;
  let specId: string;
  let taskA: string;
  let taskB: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-recon-'));
    const spec = createSpec(ws, { title: 'T', type: 'feature', requirements: ['r1'] });
    specId = spec.id;
    let s = addTaskToSpec(ws, specId, 'Task A')!;
    s = addTaskToSpec(ws, specId, 'Task B')!;
    taskA = s.tasks[0].id;
    taskB = s.tasks[1].id;
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('reverts a previous in_progress task to todo when a new one starts (never falsely done)', async () => {
    // Mark A in_progress.
    await executeTool('update_task_status', { spec_id: specId, task_id: taskA, status: 'in_progress' }, ws);
    let spec = readSpec(ws, specId)!;
    expect(spec.tasks.find((t) => t.id === taskA)!.status).toBe('in_progress');

    // Model moves on to B WITHOUT marking A done — A must NOT be falsely
    // completed. It should be reverted to 'todo' (clearly unfinished) so it is
    // picked up again, and B becomes the single in_progress task.
    await executeTool('update_task_status', { spec_id: specId, task_id: taskB, status: 'in_progress' }, ws);
    spec = readSpec(ws, specId)!;
    expect(spec.tasks.find((t) => t.id === taskA)!.status).toBe('todo');
    expect(spec.tasks.find((t) => t.id === taskB)!.status).toBe('in_progress');

    // Only ONE task is ever in_progress at a time.
    expect(spec.tasks.filter((t) => t.status === 'in_progress')).toHaveLength(1);
  });

  it('get_next_task returns the lingering in_progress task instead of completing it', async () => {
    await executeTool('update_task_status', { spec_id: specId, task_id: taskA, status: 'in_progress' }, ws);
    const res = await executeTool('get_next_task', { spec_id: specId }, ws);
    const spec = readSpec(ws, specId)!;
    // The in_progress task is NOT auto-completed...
    expect(spec.tasks.find((t) => t.id === taskA)!.status).toBe('in_progress');
    // ...and get_next_task points the agent back at it to finish + verify.
    expect(res.result).toContain('in progress');
  });
});
