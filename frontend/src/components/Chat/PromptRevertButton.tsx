import React, { useState } from 'react';
import { useStore } from '../../store';
import { revertPromptCheckpoint, fetchFileTree, fetchFileContent } from '../../hooks/useApi';
import { RotateCcw, Loader2, AlertCircle } from '../Shared/icons';

/**
 * Per-prompt revert control shown next to a user message. Rolls the workspace
 * back to the snapshot taken BEFORE this prompt, then clears this message and
 * everything after it from the transcript — so the UI matches the reverted
 * state. This is the "undo from this prompt onward" affordance.
 *
 * The prompt itself is handed back to the composer rather than thrown away: the
 * point of an undo is almost always to reword and resend, so the app returns to
 * the exact moment before you hit Enter.
 */
export function PromptRevertButton({
  messageId,
  checkpointId,
  content,
}: {
  messageId: string;
  checkpointId: string;
  /** The reverted prompt's text, restored into the input. */
  content?: string;
}) {
  const { workspacePath } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doRevert = async () => {
    if (!workspacePath) return;
    setReverting(true);
    setError(null);
    try {
      const result = await revertPromptCheckpoint(workspacePath, checkpointId);
      if (!result.ok) {
        setError(result.error ?? 'Revert failed');
        return;
      }
      const store = useStore.getState();
      // Drop this prompt and everything after it from the transcript.
      store.truncateMessagesFrom(messageId);
      // Put the prompt back in the composer, exactly as it was about to be sent,
      // so the user can edit and resend instead of retyping it.
      if (content) store.setChatDraft(content);
      // If nothing meaningful remains (we reverted the first/only prompt), reset
      // the whole session so the user lands on the real WELCOME screen — not an
      // empty in-conversation state. isNewSession is only true when there's no
      // currentSessionId, so we must clear it (and the session-scoped state).
      const remaining = useStore.getState().messages.filter((m) => m.type !== 'status');
      if (remaining.length === 0) {
        // Reverting the first/only prompt returns to a truly fresh session, so
        // wipe all thread state through the one canonical path (plus the
        // checkpoint list, which is thread-scoped but lives outside it).
        store.resetThreadState();
        store.setPromptCheckpoints([]);
        store.setCurrentSessionId(null);
        try { window.location.hash = '/chat'; } catch { /* ignore */ }
      }
      // Refresh the file tree and any open file so the editor reflects the rollback.
      try { await fetchFileTree(workspacePath); } catch { /* ignore */ }
      if (store.openFile) {
        try {
          const data = await fetchFileContent(workspacePath, store.openFile);
          store.setOpenFile(store.openFile, data.content);
        } catch { store.setOpenFile(null, null); }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setReverting(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-amber-agent/40 bg-warning-bg px-2.5 py-1.5 text-xs animate-fade-in">
        <AlertCircle size={13} className="text-amber-agent shrink-0" />
        <span className="text-text-muted">Undo this prompt and everything after it?</span>
        <button
          onClick={doRevert}
          disabled={reverting}
          className="inline-flex items-center gap-1 rounded-md bg-amber-agent/20 px-2 py-0.5 font-medium text-amber-agent hover:bg-amber-agent/30 transition-colors"
        >
          {reverting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          Revert
        </button>
        <button onClick={() => setConfirming(false)} disabled={reverting} className="text-text-dim hover:text-text">Cancel</button>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <button
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1 text-xs text-text-dim hover:text-amber-agent transition-colors"
        title="Revert the workspace to before this prompt"
      >
        <RotateCcw size={12} />
        Revert to before this
      </button>
      {error && <span className="ml-2 text-xs text-red-agent">{error}</span>}
    </div>
  );
}
