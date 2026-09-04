import React, { useState } from 'react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { WelcomeScreen } from './WelcomeScreen';
import { PanelDropdownMenu } from './PanelDropdownMenu';
import { useStore } from '../../store';
import { runClientCommand, type ClientCommandDef } from '../../utils/clientCommands';
import { useWebSocket } from '../../hooks/useWebSocket';
import { ConnectionStatus } from '../Shared/ConnectionStatus';
import { ErrorBoundary } from '../Shared/ErrorBoundary';

export function ChatPanel() {
  const {
    messages,
    isRunning,
    workspacePath,
    currentSessionId,
    agentPlan,
    workerPlan,
    pendingQuestion,
    currentThreadType,
  } = useStore();

  const { sendChat, sendWorkflow, sendApprove, sendReject, sendStop, sendAnswer, sendQueuedMessage, connectionStatus, reconnectDelay } = useWebSocket();
  const [answerText, setAnswerText] = useState('');
  const [planCollapsed, setPlanCollapsed] = useState(false);
  // The selected mode for a NEW session is the store's currentThreadType.
  const pendingThreadType = currentThreadType;

  const handleSend = (message: string, attachments?: import('./ChatInput').Attachment[]) => {
    if (!workspacePath) return;
    // Fold attachments into the message so the agent receives them. Text files
    // are inlined; images are noted (full vision support is provider-dependent).
    let composed = message;
    if (attachments && attachments.length > 0) {
      const parts = attachments.map((a) => {
        if (a.isImage) return `\n\n[Attached image: ${a.name} (${a.type})]`;
        return `\n\n--- Attached file: ${a.name} ---\n${a.content}\n--- end ${a.name} ---`;
      });
      composed = message + parts.join('');
    }
    // If this is a new session, include the thread type
    if (!currentSessionId) {
      sendChat(composed, workspacePath, null, pendingThreadType);
    } else {
      sendChat(composed, workspacePath, currentSessionId);
    }
  };

  /**
   * Run a workflow.
   *
   * The transcript shows the SHORT label ("/fix the login redirects") rather
   * than the several-hundred-word program the server expands it into. Showing
   * the expansion would bury the conversation under boilerplate the user did
   * not write and does not need to re-read.
   */
  const handleRunWorkflow = (command: string, args: Record<string, string>, label: string) => {
    if (!workspacePath) return;
    sendWorkflow(
      { command, args },
      label,
      workspacePath,
      currentSessionId,
      currentSessionId ? undefined : pendingThreadType,
    );
  };

  /**
   * The client commands this app can perform.
   *
   * Fetched rather than hard-coded so the picker, this dispatcher and the
   * terminal client all read from one list — see agent/clientCommands.ts.
   */
  const [commandCatalogue, setCommandCatalogue] = useState<ClientCommandDef[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/settings/commands?surface=desktop')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCommandCatalogue(d.commands ?? []); })
      .catch(() => { /* the picker degrades to workflows only */ });
    return () => { cancelled = true; };
  }, []);

  const handleRunCommand = async (command: string, arg: string) => {
    const store = useStore.getState();
    const handled = await runClientCommand(command, {
      arg,
      workspacePath: store.workspacePath,
      currentSessionId: store.currentSessionId,
      contextUsage: store.contextUsage,
      notice: (title, body) => store.addMessage({
        id: Math.random().toString(36).slice(2, 10),
        type: 'notice',
        title,
        content: body,
        timestamp: Date.now(),
      }),
      prompt: (text) => { if (store.workspacePath) handleSend(text); },
      openPanel: (id) => store.openRightContext(id),
      goToPanel: (panel) => store.setActivePanel(panel),
      openSettings: (category) => {
        store.setActivePanel('settings');
        if (category) { try { window.location.hash = `/settings/${category}`; } catch { /* cosmetic */ } }
      },
      newThread: () => { store.resetThreadState(); store.setCurrentSessionId(null); store.setActivePanel('chat'); },
      openThread: (id) => { try { window.location.hash = `/thread/${id}`; } catch { /* cosmetic */ } },
      switchWorkspace: (p) => store.switchWorkspace(p),
      stop: handleStop,
      attachClipboardImage: async () => {
        // navigator.clipboard.read is gated on permission and on a secure
        // context; failing quietly here and telling the user to use the
        // paperclip is better than an unexplained no-op.
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const type = item.types.find((t) => t.startsWith('image/'));
            if (!type) continue;
            const blob = await item.getType(type);
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            store.setPendingAttachment({ name: 'clipboard.png', type, size: blob.size, content: dataUrl, isImage: true });
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
    }, commandCatalogue);

    if (!handled) {
      store.addMessage({
        id: Math.random().toString(36).slice(2, 10),
        type: 'notice',
        title: 'Unknown command',
        content: `\`/${command}\` is not a command here. Type \`/\` to see the list, or \`/help\`.`,
        timestamp: Date.now(),
      });
    }
  };

  /** Say something to a turn that is already running — see ChatInput. */
  const handleQueue = (message: string): boolean => {
    if (!currentSessionId) return false;
    return sendQueuedMessage(currentSessionId, message);
  };

  const handleStop = () => {
    if (currentSessionId) {
      sendStop(currentSessionId);
    }
  };

  // An empty transcript IS the welcome state, whether or not a session id is
  // still hanging around. Keying this on `currentSessionId` used to leave a
  // reverted-to-empty thread showing a second, different empty state instead of
  // the real welcome screen.
  const isNewSession = messages.filter(m => m.type !== 'status').length === 0;

  /*
   * THERE IS ONE FILE PREVIEW, AND IT LIVES IN THE RIGHT-HAND STACK.
   *
   * There used to be two: this panel rendered a second, fixed-position overlay
   * driven by its own context — and nothing ever called the context's
   * openPreview, so it could not actually open. Clicking a file chip goes
   * through the store (openFilePreview → the 'file-preview' card in
   * RightPanel), which is the one with the diff tab, the fresh fetch and the
   * error handling. A dead second implementation of the exact feature someone
   * reports a bug in is worse than no second implementation: it is the first
   * place anyone looks, and it is not the code that runs.
   */
  return (
    <>
      <div className="flex flex-col h-full relative">
        {/* Connection Status Indicator */}
        <ConnectionStatus status={connectionStatus} reconnectDelay={reconnectDelay} />

        {/* 3-dot menu in top right corner for accessing panels */}
        <div className="absolute top-3 right-3 z-10">
          <PanelDropdownMenu />
        </div>

      {/* Welcome screen for new sessions (inline, not a modal). Mode selection
          (vibe/spec) now lives in the ChatInput toolbar below, not here. */}
      {isNewSession ? (
        <WelcomeScreen />
      ) : (
        /* Messages */
        <ErrorBoundary label="the conversation">
          <MessageList
            messages={messages}
            onApprove={sendApprove}
            onReject={sendReject}
          />
        </ErrorBoundary>
      )}

      {/* Plans no longer sit above the input. A pinned strip could only show the
          newest plan, so a worker publishing its own erased the lead's, and a
          long run left no record of how the work was scoped. Every plan now
          accumulates in the Plans panel (tagged MAIN/AGENT) with a one-line
          anchor in the transcript at the point it appeared. */}

      {/* Mid-work question from the agent (ask_user) — width matches the input column */}
      {pendingQuestion && (
        <div className="shrink-0 px-4 pt-2">
          <div className="mx-auto w-full max-w-3xl rounded-xl border border-amber-agent/40 bg-warning-bg px-4 py-3">
            <p className="text-sm text-text mb-2">{String(pendingQuestion.question)}</p>
            {pendingQuestion.options && pendingQuestion.options.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {pendingQuestion.options.map((opt, i) => {
                  // Defensive: never render a non-string (object) option — that
                  // throws "Objects are not valid as a React child" and crashes
                  // the whole app. Coerce to a label string.
                  const label = typeof opt === 'string' ? opt : String((opt as any)?.label ?? (opt as any)?.value ?? JSON.stringify(opt));
                  return (
                    <button
                      key={i}
                      onClick={() => sendAnswer(pendingQuestion.questionId, label)}
                      className="px-3 py-1.5 rounded-lg border border-border hover:border-accent hover:bg-accent/10 text-sm text-text transition-colors"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answerText.trim()) {
                    sendAnswer(pendingQuestion.questionId, answerText.trim());
                    setAnswerText('');
                  }
                }}
                placeholder="Type your answer…"
                className="input flex-1 text-sm"
                autoFocus
              />
              <button
                onClick={() => {
                  if (answerText.trim()) {
                    sendAnswer(pendingQuestion.questionId, answerText.trim());
                    setAnswerText('');
                  }
                }}
                className="btn-primary text-sm px-4"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        onQueue={handleQueue}
        onRunWorkflow={handleRunWorkflow}
        onRunCommand={handleRunCommand}
        onStop={handleStop}
        isRunning={isRunning}
        disabled={!workspacePath}
        placeholder={
          !workspacePath
            ? 'Set a workspace path in Settings…'
            : isRunning
            ? 'Agent is working — type to add an instruction, or ⏹ to stop'
            : isNewSession
            ? `Message Bubbly in ${pendingThreadType === 'vibe_coding' ? 'Vibe' : 'Spec'} mode…`
            : 'Message Bubbly…'
        }
      />
      </div>
    </>
  );
}
