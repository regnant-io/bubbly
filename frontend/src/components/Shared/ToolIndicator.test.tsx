import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolIndicator } from './ToolIndicator';

describe('ToolIndicator', () => {
  it('renders with executing status', () => {
    render(<ToolIndicator tool="read_file" status="executing" />);
    expect(screen.getByText('Reading...')).toBeInTheDocument();
  });

  it('renders with complete status and duration', () => {
    render(<ToolIndicator tool="write_file" status="complete" duration={1234} />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('renders with preparing status', () => {
    render(<ToolIndicator tool="run_command" status="preparing" />);
    expect(screen.getByText('Preparing...')).toBeInTheDocument();
  });

  it('formats duration correctly for milliseconds', () => {
    render(<ToolIndicator tool="delete_file" status="complete" duration={456} />);
    expect(screen.getByText('456ms')).toBeInTheDocument();
  });

  it('formats duration correctly for seconds', () => {
    render(<ToolIndicator tool="git_commit" status="complete" duration={2500} />);
    expect(screen.getByText('2.5s')).toBeInTheDocument();
  });

  it('shows correct label for file read operations', () => {
    render(<ToolIndicator tool="read_file" status="executing" />);
    expect(screen.getByText('Reading...')).toBeInTheDocument();
  });

  it('shows correct label for file write operations', () => {
    render(<ToolIndicator tool="write_file" status="executing" />);
    expect(screen.getByText('Writing...')).toBeInTheDocument();
  });

  it('shows correct label for shell operations', () => {
    render(<ToolIndicator tool="run_command" status="executing" />);
    expect(screen.getByText('Executing...')).toBeInTheDocument();
  });

  it('shows correct label for git operations', () => {
    render(<ToolIndicator tool="git_status" status="executing" />);
    expect(screen.getByText('Git operation...')).toBeInTheDocument();
  });

  it('shows correct label for git commit', () => {
    render(<ToolIndicator tool="git_commit" status="executing" />);
    expect(screen.getByText('Committing...')).toBeInTheDocument();
  });

  it('shows correct label for search operations', () => {
    render(<ToolIndicator tool="search_files" status="executing" />);
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('shows correct label for context gathering', () => {
    render(<ToolIndicator tool="gather_context" status="executing" />);
    expect(screen.getByText('Gathering context...')).toBeInTheDocument();
  });

  it('shows correct label for spec operations', () => {
    render(<ToolIndicator tool="create_spec" status="executing" />);
    expect(screen.getByText('Creating spec...')).toBeInTheDocument();
  });

  it('shows default label for unknown tools', () => {
    render(<ToolIndicator tool="unknown_tool" status="executing" />);
    expect(screen.getByText('Working...')).toBeInTheDocument();
  });

  it('does not show duration when status is not complete', () => {
    render(<ToolIndicator tool="read_file" status="executing" duration={1000} />);
    expect(screen.queryByText('1.0s')).not.toBeInTheDocument();
  });

  it('does not show duration when duration is undefined', () => {
    render(<ToolIndicator tool="read_file" status="complete" />);
    expect(screen.queryByText(/ms|s/)).not.toBeInTheDocument();
  });
});
