import React from 'react';
import { ApprovalPreparingCard } from './ApprovalPreparingCard';

/**
 * Example usage of ApprovalPreparingCard component
 * 
 * This component displays a loading state before an approval block appears.
 * It shows a bubble loader with tool-specific icon and "Preparing action..." text.
 */

// Example 1: File write operation preparing
export function Example1_FileWrite() {
  return (
    <div className="p-4 bg-surface-1">
      <ApprovalPreparingCard
        tool="write_file"
        args={{ path: 'src/components/Button.tsx', content: 'export const Button = ...' }}
      />
    </div>
  );
}

// Example 2: Shell command preparing
export function Example2_ShellCommand() {
  return (
    <div className="p-4 bg-surface-1">
      <ApprovalPreparingCard
        tool="run_command"
        args={{ command: 'npm install react' }}
      />
    </div>
  );
}

// Example 3: Git commit preparing
export function Example3_GitCommit() {
  return (
    <div className="p-4 bg-surface-1">
      <ApprovalPreparingCard
        tool="git_add_and_commit"
        args={{ message: 'feat: add new feature' }}
      />
    </div>
  );
}

// Example 4: File delete operation preparing
export function Example4_FileDelete() {
  return (
    <div className="p-4 bg-surface-1">
      <ApprovalPreparingCard
        tool="delete_file"
        args={{ path: 'old-file.txt' }}
      />
    </div>
  );
}

// Example 5: Multiple preparing cards in sequence
export function Example5_MultipleCards() {
  return (
    <div className="p-4 bg-surface-1 space-y-4">
      <ApprovalPreparingCard
        tool="write_file"
        args={{ path: 'src/index.ts' }}
      />
      <ApprovalPreparingCard
        tool="run_command"
        args={{ command: 'npm test' }}
      />
      <ApprovalPreparingCard
        tool="git_add_and_commit"
        args={{ message: 'Update files' }}
      />
    </div>
  );
}

// Example 6: Demonstrating the "Still working..." message
// (In real usage, this appears after 10 seconds)
export function Example6_StillWorking() {
  return (
    <div className="p-4 bg-surface-1">
      <div className="mb-4 text-text-muted text-sm">
        Note: The "Still working..." message appears after 10 seconds in actual usage
      </div>
      <ApprovalPreparingCard
        tool="write_file"
        args={{ path: 'large-file.json' }}
      />
    </div>
  );
}
