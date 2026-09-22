import React from 'react';
import { Check, X } from './icons';
import { ToolGlyph } from './ToolIndicator';

interface ApprovalCardProps {
  approvalId: string;
  tool: string;
  args: Record<string, unknown>;
  preview?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

/** The question, phrased as one: what exactly is about to happen. */
function question(tool: string, args: Record<string, unknown>): { ask: string; done: string; target: string; code: boolean } {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (tool) {
    case 'run_command':
    case 'run_background':
      return { ask: 'Run this command?', done: 'Ran', target: String(args.command ?? ''), code: true };
    case 'write_file': return { ask: 'Create this file?', done: 'Created', target: path, code: true };
    case 'edit_file': return { ask: 'Edit this file?', done: 'Edited', target: path, code: true };
    case 'append_file': return { ask: 'Append to this file?', done: 'Appended to', target: path, code: true };
    case 'delete_file': return { ask: 'Delete this file?', done: 'Deleted', target: path, code: true };
    case 'git_add_and_commit':
    case 'git_commit':
      return { ask: 'Commit these changes?', done: 'Committed', target: String(args.message ?? ''), code: false };
    default:
      return { ask: `Allow ${tool.replace(/_/g, ' ')}?`, done: tool.replace(/_/g, ' '), target: path, code: !!path };
  }
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const KEY = (k: string) => (IS_MAC ? `⌥${k}` : `Alt ${k}`);

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

  const q = question(tool, args);

  if (!isPending) {
    // Answered: a quiet one-line record, not a card still asking for attention.
    const label = status === 'approved' ? 'Allowed' : status === 'expired' ? 'Expired — nobody answered in time' : 'Denied';
    return (
      <div className={`ask-record is-${status}`}>
        {status === 'approved' ? <Check size={13} /> : <X size={13} />}
        <span className="ask-record-label">{label}</span>
        {q.target && <span className="ask-record-target">{q.target}</span>}
      </div>
    );
  }

  return (
    <div ref={cardRef} data-approval-pending="true" className="ask-card motion-pop" role="group" aria-label={q.ask}>
      <div className="ask-head">
        <span className="ask-glyph" aria-hidden="true"><ToolGlyph tool={tool} args={args} size={14} /></span>
        <span className="ask-title">{q.ask}</span>
        <span className="ask-wait"><i aria-hidden="true" />The agent is waiting</span>
      </div>
      {q.target && (
        q.code ? <pre className="ask-target">{q.target}</pre> : <p className="ask-target ask-target--text">{q.target}</p>
      )}
      {preview && <pre className="ask-preview">{preview}</pre>}
      <div className="ask-actions">
        <button onClick={() => onApprove(approvalId)} title={`Allow (${KEY('A')})`} className="ask-allow">
          Allow <kbd>{KEY('A')}</kbd>
        </button>
        <button onClick={() => onReject(approvalId)} title={`Deny (${KEY('D')})`} className="ask-deny">
          Deny <kbd>{KEY('D')}</kbd>
        </button>
      </div>
    </div>
  );
}
