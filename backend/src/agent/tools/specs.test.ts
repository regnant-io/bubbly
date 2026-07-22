import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createSpec,
  updateTaskStatus,
  getNextTask,
  areAllTasksComplete,
  lockSpecToSession,
  addTaskToSpec,
} from './specs';

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  },
}));

describe('Spec Task Management', () => {
  let testWorkspace: string;

  beforeEach(() => {
    // Create a temporary workspace
    testWorkspace = path.join(os.tmpdir(), `test-workspace-${Date.now()}`);
    fs.mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    // Clean up test workspace
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('updateTaskStatus', () => {
    it('should update task status from todo to in_progress', () => {
      // Create a spec with tasks
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1', 'Req 2'],
      });

      // Add tasks
      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      expect(updated).not.toBeNull();
      expect(updated!.tasks).toHaveLength(1);

      const taskId = updated!.tasks[0].id;

      // Update task status
      updated = updateTaskStatus(testWorkspace, spec.id, taskId, 'in_progress');
      expect(updated).not.toBeNull();
      expect(updated!.tasks[0].status).toBe('in_progress');
    });

    it('should update task status from in_progress to done', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      const taskId = updated!.tasks[0].id;

      // Mark as in_progress
      updated = updateTaskStatus(testWorkspace, spec.id, taskId, 'in_progress');
      expect(updated!.tasks[0].status).toBe('in_progress');

      // Mark as done
      updated = updateTaskStatus(testWorkspace, spec.id, taskId, 'done');
      expect(updated!.tasks[0].status).toBe('done');
    });

    it('should return null for non-existent spec', () => {
      const result = updateTaskStatus(testWorkspace, 'non-existent', 'task-1', 'done');
      expect(result).toBeNull();
    });

    it('should return null for non-existent task', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      const result = updateTaskStatus(testWorkspace, spec.id, 'non-existent-task', 'done');
      expect(result).toBeNull();
    });
  });

  describe('getNextTask', () => {
    it('should return first task with status todo', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      addTaskToSpec(testWorkspace, spec.id, 'Task 2');
      addTaskToSpec(testWorkspace, spec.id, 'Task 3');

      const nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask).not.toBeNull();
      expect(nextTask!.title).toBe('Task 1');
      expect(nextTask!.status).toBe('todo');
    });

    it('should skip tasks that are in_progress or done', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      addTaskToSpec(testWorkspace, spec.id, 'Task 2');
      addTaskToSpec(testWorkspace, spec.id, 'Task 3');

      const task1Id = updated!.tasks[0].id;

      // Mark task 1 as done
      updateTaskStatus(testWorkspace, spec.id, task1Id, 'done');

      // Next task should be Task 2
      const nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask).not.toBeNull();
      expect(nextTask!.title).toBe('Task 2');
    });

    it('should return null when all tasks are complete', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      const task1Id = updated!.tasks[0].id;

      // Mark task as done
      updateTaskStatus(testWorkspace, spec.id, task1Id, 'done');

      const nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask).toBeNull();
    });

    it('should return null for spec with no tasks', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      const nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask).toBeNull();
    });
  });

  describe('areAllTasksComplete', () => {
    it('should return false when tasks are not complete', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      addTaskToSpec(testWorkspace, spec.id, 'Task 2');

      expect(areAllTasksComplete(testWorkspace, spec.id)).toBe(false);
    });

    it('should return true when all tasks are done', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      let task1Id = updated!.tasks[0].id;

      updated = addTaskToSpec(testWorkspace, spec.id, 'Task 2');
      let task2Id = updated!.tasks[1].id;

      // Mark both tasks as done
      updateTaskStatus(testWorkspace, spec.id, task1Id, 'done');
      updateTaskStatus(testWorkspace, spec.id, task2Id, 'done');

      expect(areAllTasksComplete(testWorkspace, spec.id)).toBe(true);
    });

    it('should return false when some tasks are in_progress', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      let updated = addTaskToSpec(testWorkspace, spec.id, 'Task 1');
      let task1Id = updated!.tasks[0].id;

      addTaskToSpec(testWorkspace, spec.id, 'Task 2');

      // Mark first task as in_progress
      updateTaskStatus(testWorkspace, spec.id, task1Id, 'in_progress');

      expect(areAllTasksComplete(testWorkspace, spec.id)).toBe(false);
    });

    it('should return false for spec with no tasks', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      expect(areAllTasksComplete(testWorkspace, spec.id)).toBe(false);
    });
  });

  describe('lockSpecToSession', () => {
    it('should lock spec to session by storing session ID', () => {
      const spec = createSpec(testWorkspace, {
        title: 'Test Feature',
        type: 'feature',
        requirements: ['Req 1'],
      });

      const sessionId = 'session-12345';
      const locked = lockSpecToSession(testWorkspace, spec.id, sessionId);

      expect(locked).not.toBeNull();
      expect(locked!.projectId).toBe(sessionId);
    });

    it('should return null for non-existent spec', () => {
      const result = lockSpecToSession(testWorkspace, 'non-existent', 'session-123');
      expect(result).toBeNull();
    });
  });

  describe('Complete workflow', () => {
    it('should support complete task execution workflow', () => {
      // 1. Create spec
      const spec = createSpec(testWorkspace, {
        title: 'User Authentication',
        type: 'feature',
        requirements: ['Login', 'Logout', 'Password reset'],
      });

      // 2. Lock spec to session
      const sessionId = 'session-auth-123';
      lockSpecToSession(testWorkspace, spec.id, sessionId);

      // 3. Add tasks
      let updated = addTaskToSpec(testWorkspace, spec.id, 'Implement login endpoint');
      updated = addTaskToSpec(testWorkspace, spec.id, 'Implement logout endpoint');
      updated = addTaskToSpec(testWorkspace, spec.id, 'Implement password reset');

      expect(updated!.tasks).toHaveLength(3);

      // 4. Get first task
      let nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask!.title).toBe('Implement login endpoint');

      // 5. Mark first task as in_progress
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'in_progress');

      // 6. Complete first task
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'done');

      // 7. Get next task
      nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask!.title).toBe('Implement logout endpoint');

      // 8. Mark second task as in_progress and done
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'in_progress');
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'done');

      // 9. Get third task
      nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask!.title).toBe('Implement password reset');

      // 10. Complete third task
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'in_progress');
      updateTaskStatus(testWorkspace, spec.id, nextTask!.id, 'done');

      // 11. Verify all tasks complete
      expect(areAllTasksComplete(testWorkspace, spec.id)).toBe(true);

      // 12. No more tasks
      nextTask = getNextTask(testWorkspace, spec.id);
      expect(nextTask).toBeNull();
    });
  });
});
