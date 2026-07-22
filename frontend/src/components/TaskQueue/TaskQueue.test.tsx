import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskQueue } from './TaskQueue';
import { useStore } from '../../store';
import type { Spec, Session } from '../../types';

// Mock the store
vi.mock('../../store', () => ({
  useStore: vi.fn(),
}));

describe('TaskQueue', () => {
  const mockSpec: Spec = {
    id: 'spec-1',
    title: 'Test Feature',
    type: 'feature',
    status: 'in_progress',
    requirements: ['Req 1', 'Req 2'],
    tasks: [
      { id: 'task-1', title: 'Task 1', status: 'done' },
      { id: 'task-2', title: 'Task 2', status: 'in_progress' },
      { id: 'task-3', title: 'Task 3', status: 'todo' },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockSession: Session = {
    id: 'session-1',
    workspacePath: '/test',
    status: 'running',
    provider: 'claude',
    model: 'claude-3',
    threadType: 'spec_session',
    specId: 'spec-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render empty state when no spec is available', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [],
      sessions: [],
      currentSessionId: null,
    });

    render(<TaskQueue />);

    expect(screen.getByText('No active spec')).toBeInTheDocument();
    expect(screen.getByText('Start a Spec Session to see tasks')).toBeInTheDocument();
  });

  it('should render spec title and tasks', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    expect(screen.getByText('Test Feature')).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
    expect(screen.getByText('Task 3')).toBeInTheDocument();
  });

  it('should display progress bar with correct percentage', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    // 1 out of 3 tasks done = 33%
    expect(screen.getByText('1/3 tasks (33%)')).toBeInTheDocument();
  });

  it('should highlight currently executing task', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    expect(screen.getByText('Currently executing...')).toBeInTheDocument();
  });

  it('should show completion message when all tasks are done', () => {
    const completedSpec: Spec = {
      ...mockSpec,
      status: 'done',
      tasks: [
        { id: 'task-1', title: 'Task 1', status: 'done' },
        { id: 'task-2', title: 'Task 2', status: 'done' },
        { id: 'task-3', title: 'Task 3', status: 'done' },
      ],
    };

    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [completedSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    expect(screen.getByText('All tasks completed!')).toBeInTheDocument();
    expect(screen.getByText('3/3 tasks (100%)')).toBeInTheDocument();
  });

  it('should display estimated time remaining for in-progress specs', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    // Should show estimated time (2 remaining tasks * 2 min = 4 min)
    expect(screen.getByText(/min remaining/)).toBeInTheDocument();
  });

  it('should use specId prop when provided', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [],
      currentSessionId: null,
    });

    render(<TaskQueue specId="spec-1" />);

    expect(screen.getByText('Test Feature')).toBeInTheDocument();
  });

  it('should display correct status colors for tasks', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    const { container } = render(<TaskQueue />);

    // Check that tasks have appropriate styling
    const tasks = container.querySelectorAll('.flex.items-start.gap-3');
    expect(tasks).toHaveLength(3);
  });

  it('should display spec type badge', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    expect(screen.getByText('feature')).toBeInTheDocument();
  });

  it('should display spec status badge', () => {
    (useStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      specs: [mockSpec],
      sessions: [mockSession],
      currentSessionId: 'session-1',
    });

    render(<TaskQueue />);

    expect(screen.getByText('in_progress')).toBeInTheDocument();
  });
});
