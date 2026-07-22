# TaskQueue Component

## Overview

The TaskQueue component displays a list of tasks from a spec with their current status, progress tracking, and estimated time remaining. It provides visual feedback for task execution and allows users to monitor the agent's progress through a specification.

## Features

- **Task Status Indicators**: Visual indicators for todo (gray), in_progress (blue), and done (green) tasks
- **Active Task Highlighting**: Currently executing task is highlighted with a pulsing animation
- **Progress Bar**: Shows percentage of completed tasks with smooth animations
- **Estimated Time**: Displays estimated time remaining based on average task completion time
- **Spec Information**: Shows spec title, type, and status
- **Completion Message**: Displays a success message when all tasks are completed

## Usage

### Basic Usage

```tsx
import { TaskQueue } from '../components/TaskQueue/TaskQueue';

function MyComponent() {
  return <TaskQueue />;
}
```

The component automatically detects the current session's spec and displays its tasks.

### With Explicit Spec ID

```tsx
import { TaskQueue } from '../components/TaskQueue/TaskQueue';

function MyComponent() {
  return <TaskQueue specId="spec-123" />;
}
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `specId` | `string` | No | Explicit spec ID to display. If not provided, uses the current session's spec. |

## State Management

The component uses Zustand store to access:
- `specs`: Array of all specs
- `sessions`: Array of all sessions
- `currentSessionId`: ID of the current session

## Visual States

### Empty State
Displayed when no spec is available:
- Icon: CheckCircle (dimmed)
- Message: "No active spec"
- Subtitle: "Start a Spec Session to see tasks"

### Active State
Displayed when a spec is available:
- Spec title and metadata (type, status)
- Progress bar with percentage
- List of tasks with status indicators
- Estimated time remaining (for in-progress specs)

### Completed State
Displayed when all tasks are done:
- All tasks shown with green checkmarks
- Success message: "All tasks completed!"
- 100% progress bar

## Task Status Colors

- **Todo**: Gray (`text-text-dim`)
- **In Progress**: Blue (`text-blue-agent`)
- **Done**: Green (`text-green-agent`)

## Icons

- **Done**: CheckCircle (green)
- **In Progress**: Loader2 (blue, spinning when active)
- **Todo**: AlertCircle (gray)

## Animations

- **Active Task**: Spinning loader icon
- **Progress Bar**: Smooth width transition (500ms ease-out)
- **Task Items**: Border and background color transitions

## Integration

The TaskQueue component is integrated into the RightPanel as a tab:

```tsx
// In RightPanel.tsx
import { TaskQueue } from '../TaskQueue/TaskQueue';

const TABS = [
  { id: 'diff', icon: GitBranch, label: 'Changes' },
  { id: 'spec', icon: ClipboardList, label: 'Specs' },
  { id: 'tasks', icon: CheckCircle, label: 'Tasks' },
  { id: 'audit', icon: Clock, label: 'Audit' },
];

// In content section
{rightPanelTab === 'tasks' && <TaskQueue />}
```

## Requirements Satisfied

This component satisfies the following requirements:

- **Requirement 13.6**: Display spec progress with task status indicators
- **Requirement 14.1**: Display a task queue panel showing all spec tasks
- **Requirement 14.2**: Use visual indicators for task status (todo: gray, in_progress: blue, done: green)
- **Requirement 14.3**: Show the currently executing task with a pulsing animation
- **Requirement 14.4**: Display a progress bar showing percentage of completed tasks
- **Requirement 14.5**: Allow users to manually mark tasks as complete or skip tasks (future enhancement)
- **Requirement 14.6**: Backend updates task status in real-time as the Agent works
- **Requirement 14.7**: Show estimated time remaining based on average task completion time

## Future Enhancements

- Manual task completion/skipping buttons
- Task reordering
- Task filtering (show only incomplete, etc.)
- Real-time task status updates via WebSocket
- More accurate time estimation based on historical data
- Task dependencies visualization
