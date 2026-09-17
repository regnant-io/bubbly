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

/**
 * Is a keystroke aimed at this card, or at something the user is typing into?
 *
 * The composer stays live during a run, so the approval shortcuts must never
 * fire while someone is mid-sentence in it.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * The one moment the agent is blocked on a human.
 *
 * Everything else in the transcript is a report of something that already
 * happened; this is a question, and until it is answered the run is stopped.
 * That earns it three things nothing else in the transcript gets:
 *
 *   A KEYBOARD ANSWER. Alt+A allows, Alt+D denies, and both are printed on the
 *   buttons. In Guarded mode a single task can raise a dozen of these, and
 *   reaching for the mouse each time is most of why people abandon the safe
 *   permission profile for the unsafe one. Alt is deliberate rather than a bare
 *   letter — an approval is a decision, and a decision should not be reachable
 *   by a stray keypress — and the binding is live only on the NEWEST pending
 *   card, so a scrollback full of old questions cannot be answered by accident.
 *
 *   A HEARTBEAT WHILE IT WAITS. The dot beside the heading breathes only while
 *   the answer is outstanding. A pending approval that has scrolled out of
 *   view is the single worst state this app can be in — the agent looks hung
 *   and it is actually waiting for you — so the card is built to catch the eye
 *   in peripheral vision, and to go completely still the moment it is answered.
 *
 *   AN HONEST SETTLED STATE. Answered cards drop their colour and their
 *   movement and become a quiet record. The transcript should not keep
 *   shouting about a decision you already made.
 */
export function ApprovalCard({ approvalId, tool, args, preview, status, onApprove, onReject }: ApprovalCardProps) {
  const isPending = status === 'pending';
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isPending) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'a' && key !== 'd') return;
      if (isTypingTarget(e.target)) return;

      // Only the last pending card responds. Several approvals can be on screen
      // at once (a queued burst, or scrollback), and a shortcut that answers an
      // arbitrary one of them is worse than no shortcut at all.
      const pending = document.querySelectorAll('[data-approval-pending="true"]');
      if (pending.length > 0 && pending[pending.length - 1] !== cardRef.current) return;

      e.preventDefault();
      if (key === 'a') onApprove(approvalId);
      else onReject(approvalId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPending, approvalId, onApprove, onReject]);

  return (
    <div
      ref={cardRef}
      data-approval-pending={isPending ? 'true' : undefined}
      className={`rounded-xl border p-4 my-2 motion-pop transition-[background-color,border-color,opacity,box-shadow] duration-200 ease-out ${
        isPending
          ? 'border-accent/40 bg-accent/5 shadow-[0_0_0_3px_rgb(var(--primary-rgb)/0.06)]'
          : status === 'approved'
          ? 'border-green-agent/30 bg-success-bg opacity-70'
          : status === 'expired'
          ? 'border-border bg-surface-2 opacity-60'
          : 'border-red-agent/30 bg-error-bg opacity-70'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 relative">
          {isPending ? (
            <>
              {/* The halo is the peripheral-vision signal. It runs only while
                  the question is open, so a settled transcript is still. */}
              <span className="motion-halo absolute inset-0 rounded-full bg-accent/30" aria-hidden="true" />
              <AlertCircle size={16} className="relative text-accent-bright" />
            </>
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
              {isPending ? 'Approval Required' : status === 'approved' ? 'Approved' : status === 'expired' ? 'Expired — nobody answered in time' : 'Rejected'}
            </span>
            {isPending && (
              <span className="text-[11px] text-text-dim">the run is waiting</span>
            )}
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
                title="Allow (Alt+A)"
                className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-success-bg hover:bg-success
                           text-green-agent hover:text-text-bright text-sm font-medium border border-green-agent/50
                           transition-[background-color,color,transform] duration-150 ease-out active:scale-95"
              >
                <Check size={14} />
                Allow
                <kbd className="ml-0.5 text-[10px] font-mono opacity-50 group-hover:opacity-80 transition-opacity">⌥A</kbd>
              </button>
              <button
                onClick={() => onReject(approvalId)}
                title="Deny (Alt+D)"
                className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error-bg hover:bg-error
                           text-red-agent hover:text-text-bright text-sm font-medium border border-red-agent/40
                           transition-[background-color,color] duration-150 ease-out"
              >
                <X size={14} />
                Deny
                <kbd className="ml-0.5 text-[10px] font-mono opacity-50 group-hover:opacity-80 transition-opacity">⌥D</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
