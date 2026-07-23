import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../store';
import { publishTerminalData, renameTerminalBuffer } from '../utils/terminalBus';
import { fetchFileContent } from './useApi';
import { runPreviewControl } from '../utils/previewController';
import { registerPreviewReadySender } from '../utils/previewHostBus';
import type { WSServerEvent, ChatMessage } from '../types';

/**
 * When the agent changes files, refresh any of those files that the user has
 * open in an editor tab — so the editor always reflects edits in realtime
 * instead of showing a stale buffer.
 */
function refreshChangedTabs(files: Array<{ path: string }> | undefined): void {
  if (!files || files.length === 0) return;
  const store = useStore.getState();
  const ws = store.workspacePath;
  if (!ws) return;
  const openPaths = new Set(store.editorTabs.map((t) => t.path));
  for (const f of files) {
    if (openPaths.has(f.path)) {
      fetchFileContent(ws, f.path)
        .then((d) => useStore.getState().updateTabContent(f.path, d.content))
        .catch(() => { /* file may be deleted mid-edit */ });
    }
  }
}

// Derive the WebSocket URL from the current origin so Bubbly works on any
// port and host: the browser (served by the backend on :3001), the Vite dev
// proxy (:3000 → /ws), and the Electron desktop shell (dynamic port).
function resolveWsUrl(): string {
  // In dev, Vite serves on :3000 and proxies /ws to the backend. In prod and
  // in the desktop app the backend serves the UI on the same origin.
  const isViteDev = window.location.port === '3000';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = isViteDev
    ? `${window.location.hostname}:3001`
    : window.location.host;
  return `${proto}//${host}/ws`;
}

const WS_URL = resolveWsUrl();

let wsInstance: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 16000;

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11);
}

function calculateReconnectDelay(attempt: number): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(2, attempt),
    MAX_RECONNECT_DELAY
  );
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  // streamBufferRef holds the FULL text received so far this turn (the reveal
  // "target"); shownLenRef is how many characters are currently painted. The
  // reveal loop advances shownLen toward the target a little each frame, so the
  // answer flows out smoothly word-by-word even when the network delivers it in
  // big sentence-sized chunks.
  const streamBufferRef = useRef('');
  const shownLenRef = useRef(0);
  const thinkBufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const thinkRafRef = useRef<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('disconnected');
  const [reconnectDelay, setReconnectDelay] = useState<number>(0);

  // Use refs for store access to avoid re-creating callbacks
  const storeRef = useRef(useStore.getState());
  useEffect(() => {
    // Subscribe to store changes and keep ref current
    const unsub = useStore.subscribe((state) => {
      storeRef.current = state;
    });
    return unsub;
  }, []);

  // Smooth typewriter reveal. Rather than snapping the message to whatever text
  // has arrived (which makes the answer lurch sentence-by-sentence), we advance
  // the painted length toward the received length a fraction each frame. The
  // step is proportional to the backlog, so it catches up fast after a big chunk
  // then eases into a steady word-by-word flow — and never falls far behind.
  const revealStep = (remaining: number): number => {
    // Reveal ~22% of the outstanding text per frame, at least 2 chars, so long
    // backlogs drain quickly while a trickle still animates visibly.
    return Math.max(2, Math.ceil(remaining * 0.22));
  };

  const scheduleStreamFlush = useCallback(() => {
    if (rafRef.current != null) return;
    const tick = () => {
      rafRef.current = null;
      const target = streamBufferRef.current;
      if (shownLenRef.current < target.length) {
        const remaining = target.length - shownLenRef.current;
        shownLenRef.current = Math.min(target.length, shownLenRef.current + revealStep(remaining));
        storeRef.current.updateLastAssistantMessage(target.slice(0, shownLenRef.current), true);
        // Keep animating until the painted text has caught up to what arrived.
        rafRef.current = typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame(tick)
          : (setTimeout(tick, 16) as unknown as number);
      }
    };
    rafRef.current = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(tick)
      : (setTimeout(tick, 16) as unknown as number);
  }, []);

  // Finalize the current answer segment: cancel the reveal loop, paint the FULL
  // received text (no partial tail), mark it non-streaming, and reset for the
  // next segment. Used whenever the narration ends — a tool call, the final
  // message, or a stop.
  const flushStreamFinal = useCallback(() => {
    if (rafRef.current != null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamBufferRef.current) {
      storeRef.current.updateLastAssistantMessage(streamBufferRef.current, false);
    }
    streamBufferRef.current = '';
    shownLenRef.current = 0;
  }, []);

  // Coalesce reasoning/thinking tokens the same way as answer tokens, into a
  // separate live bubble so no reasoning token is ever lost.
  const scheduleThinkFlush = useCallback(() => {
    if (thinkRafRef.current != null) return;
    const flush = () => {
      thinkRafRef.current = null;
      if (thinkBufferRef.current) {
        storeRef.current.appendThinking(thinkBufferRef.current);
        thinkBufferRef.current = '';
      }
    };
    thinkRafRef.current = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 16) as unknown as number);
  }, []);

  // Flush any buffered reasoning immediately and mark the bubble finished.
  const finalizeThinking = useCallback(() => {
    if (thinkRafRef.current != null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(thinkRafRef.current);
      thinkRafRef.current = null;
    }
    if (thinkBufferRef.current) {
      storeRef.current.appendThinking(thinkBufferRef.current);
      thinkBufferRef.current = '';
    }
    storeRef.current.finalizeThinking();
  }, []);

  const handleEvent = useCallback((event: WSServerEvent) => {
    const store = storeRef.current;

    // --- Parallel agent lanes ---
    // Any event tagged with a `lane` belongs to a parallel worker. Route its
    // streaming/lifecycle output to that lane's pane and DO NOT let it touch the
    // main chat stream (otherwise multiple workers' tokens interleave/garble).
    const laned = event as WSServerEvent & { lane?: string };
    if (laned.lane) {
      switch (event.type) {
        case 'text_delta':
          store.updateParallelLane(laned.lane, { activity: event.content.slice(-160) });
          return;
        case 'thinking':
          return; // worker reasoning isn't shown per-lane
        case 'message':
          if (event.content) store.updateParallelLane(laned.lane, { activity: event.content.slice(-160) });
          return;
        case 'tool_call':
          store.updateParallelLane(laned.lane, { lastTool: event.tool, activity: `${event.tool}…` });
          return;
        case 'tool_result':
          if (event.diff && event.diff.length > 0) { store.addDiff(event.diff); refreshChangedTabs(event.diff); }
          return;
        case 'diff':
          if (event.files && event.files.length > 0) { store.addDiff(event.files); refreshChangedTabs(event.files); }
          return;
        case 'diagnostics': {
          const issues = (event as any).issues ?? (() => { try { return JSON.parse((event as any).content || '[]'); } catch { return []; } })();
          store.setLastValidation(Array.isArray(issues) ? issues : []);
          return;
        }
        case 'delegation_progress':
          store.updateParallelLane(laned.lane, { phase: event.phase, activity: event.detail });
          return;
        case 'delegation_completed':
          store.updateParallelLane(laned.lane, {
            phase: 'done',
            report: event.report,
            filesTouched: event.filesTouched,
            validationOk: event.validationOk,
          });
          return;
        case 'delegation_started':
          if (event.batch) {
            store.registerParallelLane(event.batch, {
              lane: laned.lane,
              laneIndex: event.laneIndex ?? 0,
              instruction: event.instruction,
              targetFiles: event.targetFiles,
              acceptance: event.acceptance,
              phase: 'working',
            });
          }
          return;
        default:
          return; // any other laned event is swallowed to protect the main stream
      }
    }

    switch (event.type) {
      case 'session_created':
        store.setCurrentSessionId(event.sessionId);
        // Deep-link the URL so a refresh reopens this exact thread.
        try { window.location.hash = `/thread/${event.sessionId}`; } catch { /* ignore */ }
        break;

      case 'status':
        store.addMessage({
          id: nanoid(),
          type: 'status',
          content: event.content,
          timestamp: Date.now(),
        });
        break;

      case 'ollama_retry':
        store.setOllamaRetryStatus({
          isRetrying: true,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.error,
        });
        break;

      case 'thinking':
        if (store.ollamaRetryStatus) {
          store.setOllamaRetryStatus(null);
        }
        // Accumulate reasoning into its own coalesced buffer/bubble.
        thinkBufferRef.current += event.content;
        scheduleThinkFlush();
        break;

      case 'text_delta':
        if (store.ollamaRetryStatus) {
          store.setOllamaRetryStatus(null);
        }
        // The answer has started — the reasoning phase for this turn is over.
        if (thinkBufferRef.current || thinkRafRef.current != null) {
          finalizeThinking();
        }
        // Grow the reveal target and make sure the typewriter loop is running.
        // The loop paints a few characters per frame toward this target, so the
        // answer streams out smoothly regardless of network chunk size.
        streamBufferRef.current += event.content;
        scheduleStreamFlush();
        break;

      case 'message':
        if (store.ollamaRetryStatus) {
          store.setOllamaRetryStatus(null);
        }
        finalizeThinking();
        if (streamBufferRef.current) {
          flushStreamFinal();
        } else if (event.content) {
          store.addMessage({
            id: nanoid(),
            type: 'assistant',
            content: event.content,
            streaming: false,
            timestamp: Date.now(),
          });
        }
        break;

      case 'tool_started':
        // The model has BEGUN a tool call but its arguments haven't finished
        // streaming yet. Show the indicator (spinner) immediately so a large
        // file write reads as "Creating file… (working)" instead of a frozen
        // UI. The later 'tool_call' event fills in the real args in place.
        finalizeThinking();
        flushStreamFinal();
        store.upsertToolCall(event.id, event.tool);
        break;

      case 'tool_progress':
        // Arguments still streaming — update the live line count / path in
        // place. No finalize calls here: this fires many times per call and
        // must stay cheap.
        store.updateToolProgress(event.id, { path: event.path, bytes: event.bytes, lines: event.lines });
        break;

      case 'context_usage':
        store.setContextUsage({
          usedTokens: event.usedTokens,
          usableTokens: event.usableTokens,
          windowTokens: event.windowTokens,
          model: event.model,
          source: event.source,
        });
        break;

      case 'tool_call':
        // A tool call marks the end of the current narration segment. Finalize
        // the streaming text into its own bubble so the natural flow reads as
        // "explanation → tool → explanation → tool", each in its own block,
        // instead of merging pre- and post-tool prose into one blob.
        finalizeThinking();
        flushStreamFinal();
        // Upsert: if a 'tool_started' already created this indicator, fill in
        // its args in place rather than adding a duplicate.
        store.upsertToolCall(event.id, event.tool, event.args);
        break;

      case 'tool_result':
        store.addMessage({
          id: nanoid(),
          type: 'tool_result',
          tool: event.tool,
          result: event.result,
          callId: event.id,
          diff: event.diff,
          timestamp: Date.now(),
        });
        if (event.diff && event.diff.length > 0) {
          store.addDiff(event.diff);
          refreshChangedTabs(event.diff);
        }
        break;

      case 'terminal_start':
        store.addMessage({
          id: nanoid(),
          type: 'terminal',
          terminalId: event.id,
          command: event.command,
          output: [],
          startTime: event.startTime,
          expanded: true,
          timestamp: Date.now(),
        });
        // Mirror into the Terminal panel so the command is visible there too —
        // WITHOUT force-opening the panel. The chat bubble is the primary view;
        // the panel tab is there if the user chooses to open the terminal.
        store.upsertAgentTerminal(event.id, {
          title: event.command.split(/\s+/)[0]?.slice(0, 18) || 'Agent',
          command: event.command,
          alive: true,
        });
        break;

      case 'terminal_output':
        store.appendTerminalOutput(event.id, event.stream, event.content);
        store.upsertAgentTerminal(event.id, { data: event.content });
        break;

      case 'terminal_end':
        store.finalizeTerminal(event.id, event.exitCode, event.duration);
        store.upsertAgentTerminal(event.id, {
          alive: false,
          exitCode: event.exitCode,
          data: `\n[exited with code ${event.exitCode}]\n`,
        });
        break;

      case 'approval_preparing':
        store.addMessage({
          id: nanoid(),
          type: 'approval_preparing',
          tool: event.tool,
          args: event.args,
          timestamp: Date.now(),
        });
        break;

      case 'approval_required':
        store.removeLastApprovalPreparing();
        store.addMessage({
          id: nanoid(),
          type: 'approval',
          approvalId: event.approvalId,
          tool: event.tool,
          args: event.args,
          preview: event.preview,
          status: 'pending',
          timestamp: Date.now(),
        });
        break;

      case 'approval_timeout':
        // The backend declined the action after 5 minutes without an answer —
        // reflect that so the card doesn't stay actionable forever.
        store.setApprovalStatus(event.approvalId, 'expired');
        break;

      case 'diff':
        store.addDiff(event.files);
        refreshChangedTabs(event.files);
        break;

      case 'diagnostics': {
        const issues = (event as any).issues ?? (() => { try { return JSON.parse((event as any).content || '[]'); } catch { return []; } })();
        store.setLastValidation(Array.isArray(issues) ? issues : []);
        break;
      }

      case 'browser_screenshot':
        // Stream the frame into the single docked Bubbly Preview panel rather
        // than spamming the chat with images. Every agent browser action lands
        // here, so the user watches each step live in one place.
        store.setPreviewFrame(event.content);
        break;

      case 'preview_url':
        // A dev server the agent started just printed its URL — load it into
        // the Bubbly Preview and reveal the panel automatically, so the user
        // never has to notice the URL in a log and open the preview by hand.
        store.setPreviewUrl(event.url);
        break;

      case 'preview_activate':
        // A browser tool is about to run — open the Preview panel (right stack)
        // so the user + webview are ready before the action executes.
        store.openRightContext('preview');
        break;

      case 'preview_control': {
        // The agent wants to drive the live Bubbly Preview webview. Run the
        // action against the webview and ship the result back so the agent's
        // navigation/clicks/typing happen in the browser the user is watching.
        // `reason` (when set) tells the backend this was a TRANSPORT failure so
        // it falls back to the headless browser instead of retrying here.
        const { id, action, params } = event;
        runPreviewControl(action, params).then((r) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'preview_result', id, ok: r.ok, result: r.result, image: r.image, url: r.url, reason: r.reason }));
          }
        });
        break;
      }

      case 'spec_created':
        store.upsertSpec(event.spec);
        // Link the spec to the current session so TaskQueue can find it
        if (store.currentSessionId) {
          store.setSessionSpecId(store.currentSessionId, event.spec.id);
        }
        // Open the Tasks panel so the user sees progress live
        store.openRightContext('tasks');
        break;

      case 'spec_updated':
        store.upsertSpec(event.spec);
        if (store.currentSessionId) {
          store.setSessionSpecId(store.currentSessionId, event.spec.id);
        }
        break;

      case 'error':
        store.addMessage({
          id: nanoid(),
          type: 'error',
          content: event.message,
          recoverable: event.recoverable,
          suggestions: event.suggestions,
          timestamp: Date.now(),
        });
        store.setIsRunning(false);
        store.stopRunTimer();
        store.setOllamaRetryStatus(null);
        store.reconcilePlanOnStop();
        finalizeThinking();
        flushStreamFinal();
        break;

      case 'done':
        store.setIsRunning(false);
        store.stopRunTimer();
        store.setOllamaRetryStatus(null);
        store.reconcilePlanOnStop();
        finalizeThinking();
        flushStreamFinal();
        break;

      // --- Multi-agent task progress (spec mode dispatch) ---
      case 'task_dispatched':
        store.setTaskProgress(event.taskId, {
          phase: 'dispatched',
          taskTitle: event.taskTitle,
          index: event.index,
          total: event.total,
        });
        store.addMessage({
          id: nanoid(),
          type: 'status',
          content: `Dispatched agent for task ${event.index + 1}/${event.total}: ${event.taskTitle}`,
          timestamp: Date.now(),
        });
        break;

      case 'task_progress':
        store.setTaskProgress(event.taskId, { phase: event.phase, detail: event.detail });
        break;

      case 'task_completed':
        store.setTaskProgress(event.taskId, {
          phase: event.verified ? 'done' : 'retry',
          detail: event.summary,
        });
        break;

      case 'context_compacted':
        // Silent housekeeping; surface lightly so the user knows memory stayed healthy.
        store.addMessage({
          id: nanoid(),
          type: 'status',
          content: `Context compacted (${event.tokensBefore.toLocaleString()} -> ${event.tokensAfter.toLocaleString()} tokens)`,
          timestamp: Date.now(),
        });
        break;

      case 'context_migrated':
        // The run moved to a fresh thread to stay under the model's context
        // limit. Switch the active session and surface a clear, friendly marker
        // with the handoff summary available on expand.
        finalizeThinking();
        flushStreamFinal();
        store.setCurrentSessionId(event.toSessionId);
        try { window.location.hash = `/thread/${event.toSessionId}`; } catch { /* ignore */ }
        store.addMessage({
          id: nanoid(),
          type: 'context_migrated',
          fromSessionId: event.fromSessionId,
          toSessionId: event.toSessionId,
          reason: event.reason,
          summary: event.summary,
          timestamp: Date.now(),
        });
        break;

      case 'plan_updated':
        // Route by owner: a worker's mini-plan goes to workerPlan so it never
        // overwrites the lead's (main) plan. Default to main when untagged.
        if (event.owner === 'worker') {
          store.setWorkerPlan(event.steps);
        } else {
          store.setAgentPlan(event.steps);
        }
        break;

      case 'prompt_checkpoint':
        store.addPromptCheckpoint({ id: event.id, prompt: event.prompt, createdAt: event.createdAt });
        // Link it to the user message it was taken before, so a revert button
        // can sit right next to that prompt in the transcript.
        store.attachCheckpointToLastUserMessage(event.id);
        break;

      case 'delegation_started':
        store.upsertDelegation({
          delegationId: event.delegationId,
          instruction: event.instruction,
          targetFiles: event.targetFiles,
          acceptance: event.acceptance,
          phase: 'dispatched',
        });
        break;

      case 'delegation_progress':
        store.upsertDelegation({
          delegationId: event.delegationId,
          phase: event.phase,
          detail: event.detail,
        });
        break;

      case 'delegation_completed':
        store.upsertDelegation({
          delegationId: event.delegationId,
          phase: 'done',
          report: event.report,
          filesTouched: event.filesTouched,
          validationOk: event.validationOk,
        });
        // The worker is finished — clear its mini-plan so the UI returns focus
        // to the lead's (main) plan.
        store.setWorkerPlan([]);
        break;

      case 'question_asked':
        store.setPendingQuestion({ questionId: event.questionId, question: event.question, options: event.options });
        break;

      // --- Interactive terminals ---
      case 'term_created':
        store.bindTerminal(event.clientRef ?? event.terminalId, event.terminalId, event.title, event.cwd);
        // Move any buffered output from the temporary clientRef to the real id
        // so the xterm instance backfills correctly after binding.
        if (event.clientRef && event.clientRef !== event.terminalId) {
          renameTerminalBuffer(event.clientRef, event.terminalId);
        }
        break;

      case 'term_data':
        // Feed xterm directly via the bus (raw stream, no React re-render).
        publishTerminalData(event.terminalId, event.data);
        break;

      case 'term_exit':
        store.markTerminalExited(event.terminalId);
        break;

      case 'term_input_required':
        store.setTerminalAwaitingInput(event.terminalId, {
          kind: event.kind,
          prompt: event.prompt,
          suggestedReply: event.suggestedReply,
        });
        break;

      case 'pong':
        break;
    }
  }, [scheduleStreamFlush, scheduleThinkFlush, finalizeThinking]);

  const connect = useCallback(() => {
    // If already connected, just update ref
    if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
      wsRef.current = wsInstance;
      setConnectionStatus('connected');
      return;
    }

    // If connecting, don't create another
    if (wsInstance && wsInstance.readyState === WebSocket.CONNECTING) {
      return;
    }

    // Check max attempts
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[WS] Max reconnection attempts reached');
      setConnectionStatus('disconnected');
      return;
    }

    // Clean up any existing broken connection
    if (wsInstance) {
      try { wsInstance.close(); } catch {}
      wsInstance = null;
    }

    const ws = new WebSocket(WS_URL);
    wsInstance = ws;
    wsRef.current = ws;

    ws.onopen = async () => {
      console.log('[WS] Connected');
      setConnectionStatus('connected');

      // Advertise this window's browser-driving capability, and re-advertise on
      // every capability change, so the backend always knows whether it can
      // route browser tools to this webview or must use the headless fallback.
      registerPreviewReadySender((cap) => {
        const live = wsRef.current;
        if (live && live.readyState === WebSocket.OPEN) {
          live.send(JSON.stringify({ type: 'preview_ready', ...cap }));
        }
      });

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // Restore session on reconnect
      if (reconnectAttempts > 0) {
        const sessionId = storeRef.current.currentSessionId;
        if (sessionId) {
          try {
            const response = await fetch(`/api/sessions/${sessionId}/messages`);
            if (response.ok) {
              const data = await response.json();
              if (data.messages && Array.isArray(data.messages)) {
                storeRef.current.loadMessages(data.messages);
              }
            }
          } catch (error) {
            console.error('[WS] Error restoring session:', error);
          }
        }
      }
      
      reconnectAttempts = 0;
      setReconnectDelay(0);
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WSServerEvent;
        handleEvent(event);
      } catch (err) {
        console.error('[WS] Parse error', err);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      wsInstance = null;
      
      const delay = calculateReconnectDelay(reconnectAttempts);
      setReconnectDelay(delay);
      setConnectionStatus('reconnecting');
      
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
      
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => connect(), delay);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error', err);
    };
  }, [handleEvent]); // Only depends on handleEvent which is stable

  // Connect once on mount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
    };
  }, []); // Empty deps - connect only once

  const sendMessage = useCallback(
    (data: object) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      } else {
        console.warn('[WS] Not connected, queueing...');
        setTimeout(() => sendMessage(data), 500);
      }
    },
    []
  );

  const sendChat = useCallback(
    (message: string, workspacePath: string, sessionId?: string | null, threadType?: string, specId?: string) => {
      const store = storeRef.current;
      store.setIsRunning(true);
      store.startRunTimer();
      // Remember the thread type so the badge persists across the session.
      if (threadType === 'vibe_coding' || threadType === 'spec_session') {
        store.setCurrentThreadType(threadType);
      }
      streamBufferRef.current = '';
      shownLenRef.current = 0;
      store.addMessage({
        id: nanoid(),
        type: 'user',
        content: message,
        timestamp: Date.now(),
      });
      sendMessage({
        type: 'chat',
        message,
        workspacePath,
        sessionId: sessionId ?? undefined,
        threadType,
        specId,
      });
    },
    [sendMessage]
  );

  const sendApprove = useCallback(
    (approvalId: string) => {
      storeRef.current.setApprovalStatus(approvalId, 'approved');
      sendMessage({ type: 'approve', approvalId });
    },
    [sendMessage]
  );

  const sendReject = useCallback(
    (approvalId: string) => {
      storeRef.current.setApprovalStatus(approvalId, 'rejected');
      sendMessage({ type: 'reject', approvalId });
    },
    [sendMessage]
  );

  const sendStop = useCallback(
    (sessionId: string) => {
      sendMessage({ type: 'stop', sessionId });
      storeRef.current.setIsRunning(false);
      storeRef.current.stopRunTimer();
    },
    [sendMessage]
  );

  // --- Interactive terminal senders ---
  const createTerminal = useCallback(
    (workspacePath: string, title?: string, cols?: number, rows?: number) => {
      const clientRef = nanoid();
      storeRef.current.addTerminal({
        id: clientRef, // temporary until backend assigns one
        clientRef,
        title: title ?? 'Terminal',
        cwd: workspacePath,
        buffer: '',
        alive: true,
        origin: 'user',
      });
      sendMessage({ type: 'term_create', workspacePath, title, clientRef, cols, rows });
      return clientRef;
    },
    [sendMessage]
  );

  const sendTerminalInput = useCallback(
    (terminalId: string, data: string) => {
      sendMessage({ type: 'term_input', terminalId, data });
      // Once the user types a line, the prompt is being answered — clear the
      // waiting badge so the UI doesn't stay stuck on "needs input".
      if (data.includes('\r') || data.includes('\n')) {
        storeRef.current.setTerminalAwaitingInput(terminalId, null);
      }
    },
    [sendMessage]
  );

  const sendTerminalResize = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      sendMessage({ type: 'term_resize', terminalId, cols, rows });
    },
    [sendMessage]
  );

  const killTerminal = useCallback(
    (terminalId: string) => {
      sendMessage({ type: 'term_kill', terminalId });
      storeRef.current.closeTerminal(terminalId);
    },
    [sendMessage]
  );

  // Answer a mid-work question from the agent (ask_user tool).
  const sendAnswer = useCallback(
    (questionId: string, answer: string) => {
      sendMessage({ type: 'answer', questionId, answer });
      storeRef.current.setPendingQuestion(null);
    },
    [sendMessage]
  );

  return {
    sendChat, sendApprove, sendReject, sendStop,
    createTerminal, sendTerminalInput, sendTerminalResize, killTerminal, sendAnswer,
    connectionStatus, reconnectDelay,
  };
}
