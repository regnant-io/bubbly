import React, { useState, useEffect } from 'react';
import { Terminal, FileCode, GitCommit } from './icons';
import { BubbleLoader } from './BubbleLoader';
import { SkeletonLoader } from './SkeletonLoader';

interface ApprovalPreparingCardProps {
  tool: string;
  args: Record<string, unknown>;
}

function toolDescription(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'write_file': return `Write to ${args.path}`;
    case 'edit_file': return `Edit ${args.path}`;
    case 'delete_file': return `Delete ${args.path}`;
    case 'run_command': return `Run: ${args.command}`;
    case 'git_add_and_commit': return `Commit: "${args.message}"`;
    default: return tool;
  }
}

function ToolIcon({ tool }: { tool: string }) {
  if (tool === 'run_command') return <Terminal size={20} className="text-amber-agent" />;
  if (tool === 'git_add_and_commit') return <GitCommit size={20} className="text-green-agent" />;
  return <FileCode size={20} className="text-blue-agent" />;
}

/**
 * ApprovalPreparingCard Component
 * 
 * Displays a loading state before an approval block appears.
 * Shows a bubble loader with tool-specific icon and "Preparing action..." text.
 * 
 * Requirements:
 * - 6.1: Display skeleton loader before approval blocks appear
 * - 6.2: Show bubble animation with "Preparing action..." text during approval preparation
 * - 6.3: Animate approval block sliding into view smoothly
 * - 6.5: Show tool-specific icons in the loading state
 * - 6.6: Transition from loading state to approval block within 300ms
 * - 6.7: Show "Still working..." message if preparation exceeds 10s
 */
export function ApprovalPreparingCard({ tool, args }: ApprovalPreparingCardProps) {
  const [showStillWorking, setShowStillWorking] = useState(false);

  useEffect(() => {
    // Show "Still working..." message after 10 seconds
    const timer = setTimeout(() => {
      setShowStillWorking(true);
    }, 10000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 my-2 animate-fade-in">
      {/* Skeleton structure matching approval block layout */}
      <div className="flex items-start gap-3 mb-3">
        <div className="mt-0.5">
          <ToolIcon tool={tool} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-text">
              Preparing action...
            </span>
          </div>
          <p className="text-sm text-text-muted">{toolDescription(tool, args)}</p>
        </div>
      </div>

      {/* Skeleton loader for approval content */}
      <div className="space-y-2 mb-3">
        <SkeletonLoader height={16} width="90%" />
        <SkeletonLoader height={16} width="75%" />
      </div>

      {/* Bubble loader with status */}
      <div className="flex flex-col items-center py-2">
        <BubbleLoader text="" size="small" />
        {showStillWorking && (
          <p className="text-xs text-text-dim mt-2 animate-fade-in">
            Still working...
          </p>
        )}
      </div>
    </div>
  );
}
