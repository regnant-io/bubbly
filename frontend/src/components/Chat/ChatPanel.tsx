import React, { useState } from 'react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { PlanStrip } from './PlanStrip';
import { WelcomeScreen } from './WelcomeScreen';
import { useStore } from '../../store';
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

  const { sendChat, sendApprove, sendReject, sendStop, sendAnswer, connectionStatus, reconnectDelay } = useWebSocket();
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

  return (
    <div className="flex flex-col h-full">
      {/* Connection Status Indicator */}
      <ConnectionStatus status={connectionStatus} reconnectDelay={reconnectDelay} />

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

      {/* Agent plan strips — main (lead) plan, plus a worker's mini-plan when
          one is active. Tagged so they're never confused. */}
      {((agentPlan?.length ?? 0) > 0 || (workerPlan?.length ?? 0) > 0) && (
        <div className="shrink-0 px-4 pt-2 space-y-2">
          {(agentPlan?.length ?? 0) > 0 && (
            <PlanStrip
              label="Plan"
              owner="main"
              steps={agentPlan}
              collapsed={planCollapsed}
              onToggle={() => setPlanCollapsed((c) => !c)}
            />
          )}
          {(workerPlan?.length ?? 0) > 0 && (
            <PlanStrip label="Worker plan" owner="worker" steps={workerPlan} />
          )}
        </div>
      )}

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
        onStop={handleStop}
        isRunning={isRunning}
        disabled={!workspacePath}
        placeholder={
          !workspacePath
            ? 'Set a workspace path in Settings…'
            : isRunning
            ? 'Agent is running… press ⏹ to stop'
            : isNewSession
            ? `Message Bubbly in ${pendingThreadType === 'vibe_coding' ? 'Vibe' : 'Spec'} mode…`
            : 'Message Bubbly…'
        }
      />
    </div>
  );
}
