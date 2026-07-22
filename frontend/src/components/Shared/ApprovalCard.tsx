import React from 'react';
import { Check, X, AlertCircle, Terminal, FileCode, GitCommit } from './icons';

interface ApprovalCardProps {
  approvalId: string;
  tool: string;
  args: Record<string, unknown>;
  preview?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
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
  if (tool === 'run_command') return <Terminal size={16} className="text-amber-agent" />;
  if (tool === 'git_add_and_commit') return <GitCommit size={16} className="text-green-agent" />;
  return <FileCode size={16} className="text-blue-agent" />;
}

export function ApprovalCard({ approvalId, tool, args, preview, status, onApprove, onReject }: ApprovalCardProps) {
  const isPending = status === 'pending';

  return (
    <div
      className={`rounded-xl border p-4 my-2 approval-block-enter ${
        isPending
          ? 'border-accent/40 bg-accent/5'
          : status === 'approved'
          ? 'border-green-agent/30 bg-success-bg opacity-70'
          : status === 'expired'
          ? 'border-border bg-surface-2 opacity-60'
          : 'border-red-agent/30 bg-error-bg opacity-70'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {isPending ? (
            <AlertCircle size={16} className="text-accent-bright" />
          ) : status === 'approved' ? (
            <Check size={16} className="text-green-agent" />
          ) : (
            <X size={16} className="text-red-agent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ToolIcon tool={tool} />
            <span className="text-sm font-medium text-text">
              {isPending ? 'Approval Required' : status === 'approved' ? 'Approved' : status === 'expired' ? 'Expired — declined after 5 minutes' : 'Rejected'}
            </span>
          </div>
          <p className="text-sm text-text-muted mb-2">{toolDescription(tool, args)}</p>

          {preview && (
            <pre className="text-xs font-mono bg-surface-1 border border-border rounded-lg p-3 text-text-muted max-h-32 overflow-y-auto whitespace-pre-wrap mb-3">
              {preview}
            </pre>
          )}

          {isPending && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onApprove(approvalId)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-success-bg hover:bg-success text-green-agent hover:text-text-bright text-sm font-medium border border-green-agent/50 transition-colors"
              >
                <Check size={14} />
                Allow
              </button>
              <button
                onClick={() => onReject(approvalId)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error-bg hover:bg-error text-red-agent hover:text-text-bright text-sm font-medium border border-red-agent/40 transition-colors"
              >
                <X size={14} />
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
