import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { ChatMessage } from '../../types';
import { BubblyMark } from '../Shared/BubblyMark';
import { ToolIndicator, TOOL_ERROR_RE } from '../Shared/ToolIndicator';
import { ToolStepGroup, type ToolStepSummary } from '../Shared/ToolStepGroup';
import { ApprovalCard } from '../Shared/ApprovalCard';
import { ApprovalPreparingCard } from '../Shared/ApprovalPreparingCard';
import { TerminalOutput } from '../Shared/TerminalOutput';
import { MarkdownContent } from '../Shared/MarkdownContent';
import { ThinkingBubble } from '../Shared/ThinkingBubble';
import { AgentPresence } from '../Shared/AgentPresence';
import { DelegationCard } from '../Shared/DelegationCard';
import { ParallelAgentsPanel } from '../Shared/ParallelAgentsPanel';
import { Sparkles, AlertCircle, Info, Search, X, ChevronUp, ChevronDown } from '../Shared/icons';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { useTabVisibility } from '../../hooks/useTabVisibility';
import { PromptRevertButton } from './PromptRevertButton';
import { PlanAnchor } from './PlanAnchor';
import { ArtifactCard } from '../Artifacts/ArtifactCard';
import { useAppContextMenu } from '../Shared/ContextMenu';
import { useStore } from '../../store';
import { ConversationNavigator } from './ConversationNavigator';

interface MessageListProps {
  messages: ChatMessage[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

/**
 * The user's own message.
 *
 * Rendered as a BUBBLE rather than as underlined prose. The underline was
 * doing two jobs badly: it marked "this is the question" while also looking
 * like a link, and on a long prompt it turned into a striped wall that fought
 * the answer below it for attention. A bubble says "someone said this" without
 * any of that — it is the one convention every reader already knows.
 *
 * Long prompts collapse to a readable height with a real read-more, because a
 * pasted stack trace should not push the reply off the screen.
 */
const UserMessage = React.memo(function UserMessage({ id, content, checkpointId }: { id: string; content: string; checkpointId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { bind } = useAppContextMenu();

  // Long by LINES as well as by characters: forty short lines of a config file
  // is just as dominating as one long paragraph, and only one of those two was
  // being caught before.
  const lines = content.split('\n');
  const isLong = content.length > 420 || lines.length > 8;
  const shown = isLong && !expanded
    ? lines.slice(0, 8).join('\n').slice(0, 420).trimEnd()
    : content;
  // Only reserve room under the bubble when something is actually going there.
  const hasFooter = isLong || !!checkpointId;

  return (
    <div
      className="mb-4 mt-2 flex justify-end group/usermsg"
      {...bind([
        { label: 'Copy prompt', onSelect: () => navigator.clipboard?.writeText(content) },
        { label: expanded ? 'Collapse' : 'Expand', onSelect: () => setExpanded((e) => !e), disabled: !isLong },
      ])}
    >
      <div className={`relative max-w-[85%] min-w-0 ${hasFooter ? 'pb-5' : ''}`}>
        <div
          className="user-message rounded-2xl rounded-br-md bg-accent/12 border border-accent/25 px-3.5 py-2.5
                     text-[13.5px] leading-relaxed text-text whitespace-pre-wrap break-words
                     shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        >
          {shown}
          {isLong && !expanded && <span className="text-text-dim">…</span>}
        </div>

        <div className="absolute right-0 bottom-0 flex items-center justify-end gap-2 whitespace-nowrap">
          {isLong && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-[11px] font-medium text-accent-bright hover:underline"
            >
              {expanded ? 'Show less' : `Show all ${lines.length > 8 ? `${lines.length} lines` : 'of it'}`}
            </button>
          )}
          {checkpointId && (
            <div className="opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity">
              <PromptRevertButton messageId={id} checkpointId={checkpointId} content={content} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

const AssistantMessage = React.memo(function AssistantMessage({ content, streaming, grouped }: { content: string; streaming?: boolean; grouped?: boolean }) {
  const { bind } = useAppContextMenu();
  return (
    <div
      className={`assistant-message ${grouped ? 'mb-1' : 'mb-2'} motion-rise`}
      {...bind([{ label: 'Copy message', onSelect: () => navigator.clipboard?.writeText(content), disabled: !content }])}
    >
      <div className={`text-text ${streaming ? 'typing-cursor' : ''}`}>
        {content ? (
          // Skip syntax highlighting while streaming — it's re-run on every
          // token otherwise, the dominant streaming cost. Highlight once done.
          <MarkdownContent content={content} highlight={!streaming} />
        ) : (
          streaming ? '' : '​'
        )}
      </div>
    </div>
  );
});

/**
 * Bubbly's own answer to a client command, in the transcript.
 *
 * Marked as the APP speaking rather than the model, because it is: `/status`
 * did not ask an LLM anything. Getting that attribution right matters more than
 * it looks — a transcript where the app's words and the model's words are
 * indistinguishable is a transcript you cannot audit.
 */
const NoticeMessage = React.memo(function NoticeMessage({ title, content }: { title: string; content: string }) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className="note-card motion-rise">
      <button onClick={() => setCollapsed((c) => !c)} className="note-head" aria-expanded={!collapsed}>
        <span className="note-source">Bubbly</span>
        <span className="note-title">{title}</span>
        <ChevronDown size={13} className={`note-caret ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      {!collapsed && (
        <div className="note-body">
          <MarkdownContent content={content} />
        </div>
      )}
    </div>
  );
});

/** Transient progress text. One honest line, no bouncing dots. */
function StatusMessage({ content }: { content: string }) {
  return (
    <div className="status-line motion-appear">
      <span className="status-dot motion-breathe" aria-hidden="true" />
      <span>{content}</span>
    </div>
  );
}

function ErrorMessage({ content, recoverable, suggestions }: {
  content: string;
  recoverable?: boolean;
  suggestions?: string[];
}) {
  const [expanded, setExpanded] = React.useState(false);
  const hasHelp = !!suggestions && suggestions.length > 0;
  return (
    <div className="error-card motion-rise" role="alert">
      <div className="error-head">
        <AlertCircle size={14} className="shrink-0" />
        <p>{content}</p>
        {hasHelp && (
          <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? 'Hide help' : 'What can I do?'}
          </button>
        )}
      </div>
      {expanded && hasHelp && (
        <ul className="error-help">
          {suggestions!.map((suggestion, idx) => <li key={idx}>{suggestion}</li>)}
          {recoverable && <li className="error-help-note">Nothing was lost; you can send again.</li>}
        </ul>
      )}
    </div>
  );
}

// Track which tool calls have results
function buildToolCallMap(messages: ChatMessage[]): Map<string, string> {
  const resultMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === 'tool_result') {
      resultMap.set(msg.callId, msg.result);
    }
  }
  return resultMap;
}

function ContextMigratedMessage({ reason, summary }: { reason: 'context_limit' | 'model_downgrade'; summary: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const headline = reason === 'model_downgrade'
    ? 'Continued in a fresh thread: the new model has a smaller context'
    : 'Continued in a fresh thread: the context limit was reached';
  return (
    <div className="handoff motion-rise">
      <div className="handoff-rule" aria-hidden="true" />
      <div className="handoff-head">
        <Info size={13} />
        <span>{headline}</span>
        <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? 'Hide handoff' : 'Show handoff'}
        </button>
      </div>
      {expanded && (
        <div className="handoff-body"><MarkdownContent content={summary} /></div>
      )}
    </div>
  );
}

export function MessageList({ messages, onApprove, onReject }: MessageListProps) {
  const { scrollRef, scrollToBottom, isAtBottom } = useScrollRestoration('chat-messages', true);
  const isTabVisible = useTabVisibility();
  const isRunning = useStore((s) => s.isRunning);

  // --- In-chat search (IDE-style Ctrl/Cmd+F) ---
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Find message ids whose textual content matches the query.
  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((m) => {
        const text =
          'content' in m && typeof (m as any).content === 'string' ? (m as any).content :
          m.type === 'tool_result' ? m.result :
          m.type === 'tool_call' ? `${m.tool} ${JSON.stringify(m.args)}` : '';
        return text.toLowerCase().includes(q);
      })
      .map((m) => m.id);
  }, [query, messages]);

  // Toggle search with Ctrl/Cmd+F; close with Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // Keep activeMatch in range and scroll the active match into view.
  useEffect(() => {
    if (matchIds.length === 0) { setActiveMatch(0); return; }
    const idx = Math.min(activeMatch, matchIds.length - 1);
    const el = document.getElementById(`msg-${matchIds[idx]}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatch, matchIds]);

  const gotoMatch = (dir: 1 | -1) => {
    if (matchIds.length === 0) return;
    setActiveMatch((cur) => (cur + dir + matchIds.length) % matchIds.length);
  };

  const activeMatchId = matchIds[Math.min(activeMatch, Math.max(0, matchIds.length - 1))];

  // Plans render as a one-line anchor at the point in the transcript where they
  // appeared (the full plan lives in the Plans panel). Indexed by the message
  // they were anchored to so they can be emitted right after it. Plans with no
  // anchor — restored from a reload, say — are shown at the top.
  const plans = useStore((s) => s.plans);
  const anchoredPlans = useMemo(() => {
    const byMessage = new Map<string, typeof plans>();
    const orphans: typeof plans = [];
    for (const p of plans) {
      if (!p.anchorMessageId) { orphans.push(p); continue; }
      const list = byMessage.get(p.anchorMessageId);
      if (list) list.push(p); else byMessage.set(p.anchorMessageId, [p]);
    }
    return { byMessage, orphans };
  }, [plans]);

  /** One tool call's line. Shared by the standalone and grouped render paths. */
  const renderToolCall = (msg: Extract<ChatMessage, { type: 'tool_call' }>) => {
    const resultMsg = resultByCallId.get(msg.callId);
    return (
      <ToolIndicator
        key={msg.id}
        tool={msg.tool}
        status={resultMsg ? 'complete' : 'executing'}
        duration={resultMsg ? resultMsg.timestamp - msg.timestamp : undefined}
        args={msg.args}
        result={resultMsg?.result}
        diff={resultMsg?.diff}
        shortcutIndex={shortcutMap.get(msg.id)}
        progress={msg.progress}
        live={terminalByCall.get(msg.callId)}
      />
    );
  };

  /** The header data a ToolStepGroup needs for one of its member calls. */
  const stepSummary = (msg: Extract<ChatMessage, { type: 'tool_call' }>): ToolStepSummary => {
    const resultMsg = resultByCallId.get(msg.callId);
    const result = resultMsg?.result ?? '';
    return {
      tool: msg.tool,
      args: msg.args,
      done: !!resultMsg,
      isError: TOOL_ERROR_RE.test(result.trim()),
      additions: resultMsg?.diff?.reduce((n, d) => n + (d.additions || 0), 0) ?? 0,
      deletions: resultMsg?.diff?.reduce((n, d) => n + (d.deletions || 0), 0) ?? 0,
      // What the agent said it was doing at the moment it made this call. The
      // group lays the burst out under these rather than as one flat list.
      phase: msg.phase,
      node: renderToolCall(msg),
    };
  };

  // Auto-scroll to the newest content — coalesced to ONE scroll per animation
  // frame. scrollToBottom() reads scrollHeight (a forced synchronous reflow);
  // doing that on every streamed token, against an ever-growing un-virtualized
  // DOM, is a major cause of streaming lag that worsens over a long session.
  // Batching via rAF caps it to the frame rate and runs it after React commits.
  const scrollRafRef = useRef<number>();
  useEffect(() => {
    if (!isTabVisible) return;
    if (scrollRafRef.current != null) return; // a scroll is already scheduled
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = undefined;
      scrollToBottom();
    });
  }, [messages, scrollToBottom, isTabVisible]);
  useEffect(() => () => { if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current); }, []);

  // Filter consecutive status messages — only show last one. Memoized on
  // `messages` so unrelated store updates (task progress, preview frames, the
  // runtime timer, …) don't re-scan the whole transcript.
  const visibleMessages = useMemo(() => messages.filter((msg, i) => {
    if (msg.type === 'status') {
      // Only show last status or if next isn't status
      const next = messages[i + 1];
      return !next || next.type !== 'status';
    }
    return true;
  }), [messages]);

  const toolResultMap = useMemo(() => buildToolCallMap(messages), [messages]);

  const lastIsLive = useMemo(() => {
    const last = visibleMessages[visibleMessages.length - 1];
    return !!last && (last.type === 'assistant' || last.type === 'thinking') && !!last.streaming;
  }, [visibleMessages]);

  /** Result message per tool call id — one pass instead of a find() per render. */
  const resultByCallId = useMemo(() => {
    const m = new Map<string, Extract<ChatMessage, { type: 'tool_result' }>>();
    for (const msg of messages) if (msg.type === 'tool_result') m.set(msg.callId, msg);
    return m;
  }, [messages]);

  const messageById = useMemo(() => {
    const m = new Map<string, ChatMessage>();
    for (const msg of messages) m.set(msg.id, msg);
    return m;
  }, [messages]);

  /**
   * NOTHING THAT CHANGED A FILE IS EVER HIDDEN.
   *
   * There used to be a rule here that collapsed consecutive edits to the SAME
   * file into one line and dropped the rest — including their RESULTS, which is
   * where the diffs live. So an agent that edited one file four times in a row
   * showed one "Edited x.ts" and three invisible changes: the +/- counts were
   * wrong, the diff tags never appeared, and the only place the work existed was
   * the Changes panel. A transcript that hides edits is not a transcript.
   *
   * What SHOULD be folded away is housekeeping — the informational status lines
   * the agent emits about its own bookkeeping (context compaction, connection
   * notes). Those carry no decision and no change, and they are what actually
   * makes a burst hard to read.
   */
  const HOUSEKEEPING = /^(?:context compacted|connected \d+ mcp|resolved context|warning: cannot verify|response was long)/i;

  const { skipIds, foldedStatusIds } = useMemo(() => {
    const skip = new Set<string>();
    const folded = new Set<string>();
    for (const m of visibleMessages) {
      // set_phase is control metadata. Its value is stamped onto subsequent
      // steps; rendering it as another step made the phase UI describe itself
      // and inflated every burst count.
      if (m.type === 'tool_call' && m.tool === 'set_phase') {
        skip.add(m.id);
        continue;
      }
      if (m.type === 'status' && HOUSEKEEPING.test(m.content.trim())) {
        skip.add(m.id);
        folded.add(m.id);
      }
    }
    return { skipIds: skip, foldedStatusIds: folded };
  }, [visibleMessages]);

  /**
   * Runs of consecutive tool calls, so a burst of steps renders as ONE
   * collapsible block instead of N loose lines (see ToolStepGroup).
   *
   * A run is broken by anything that isn't a tool call, its result, a
   * transient status line, or a context_migrated message — prose, an approval, 
   * an error, a delegation. Those are the moments the agent genuinely changes 
   * what it's doing, and they are exactly where a reader expects one block to 
   * end and the next to begin.
   *
   * Single calls are deliberately NOT grouped: wrapping one line in a header
   * that says "1 step" adds chrome and removes nothing.
   */
  /**
   * A COMMAND IS ONE STEP, NOT TWO.
   *
   * A running command streams its output as a separate `terminal` message, and
   * that used to render as a second, heavier card right under the step that
   * started it — the same command, twice, one of them in a red frame. The
   * stream belongs INSIDE its step: it is what the step is doing. Each terminal
   * is paired with the most recent command call that has not got one yet
   * (matching the command text where it can), and is then drawn only there.
   */
  const terminalByCall = useMemo(() => {
    const byCall = new Map<string, Extract<ChatMessage, { type: 'terminal' }>>();
    const open: Array<Extract<ChatMessage, { type: 'tool_call' }>> = [];
    for (const m of visibleMessages) {
      if (m.type === 'tool_call' && (m.tool === 'run_command' || m.tool === 'run_background')) {
        open.push(m);
      } else if (m.type === 'terminal') {
        const cmd = m.command.trim();
        let idx = -1;
        for (let k = open.length - 1; k >= 0; k--) {
          const c = String(open[k].args?.command ?? '').trim();
          if (c && (c === cmd || cmd.includes(c) || c.includes(cmd))) { idx = k; break; }
        }
        if (idx === -1 && open.length > 0) idx = open.length - 1;
        if (idx !== -1) {
          byCall.set(open[idx].callId, m);
          open.splice(idx, 1);
        }
      }
    }
    return byCall;
  }, [visibleMessages]);
  const pairedTerminals = useMemo(
    () => new Set([...terminalByCall.values()].map((t) => t.id)),
    [terminalByCall],
  );

  const { groupLead, groupedIds, contextMigratedInGroup, trailingLead } = useMemo(() => {
    const lead = new Map<string, string[]>();
    const grouped = new Set<string>();
    const contextMigrated = new Map<string, string>(); // msg.id -> lead id
    let currentLead: string | null = null;
    for (const m of visibleMessages) {
      if (skipIds.has(m.id)) continue;
      if (m.type === 'tool_call') {
        if (currentLead === null) { currentLead = m.id; lead.set(m.id, [m.id]); }
        else { lead.get(currentLead)!.push(m.id); grouped.add(m.id); }
      } else if (m.type === 'context_migrated') {
        // Keep context_migrated within the current group if one exists
        if (currentLead !== null) {
          contextMigrated.set(m.id, currentLead);
        }
        // Don't break the group
      } else if (m.type === 'terminal' && pairedTerminals.has(m.id)) {
        // Drawn inside its command's step — see terminalByCall.
      } else if (m.type !== 'tool_result' && m.type !== 'status') {
        currentLead = null;
      }
    }
    // EVERY run gets a group, including a run of one.
    //
    // Dropping single-call runs seemed tidier and was actually the bug behind
    // "it leaks tool calls then hides them": the first call of a burst rendered
    // bare, and the instant a second arrived the run became a group and both
    // jumped inside a bordered container — which then collapsed. A step you had
    // been reading moved and vanished. Keeping the container from the very
    // first call means a step is only ever added below the previous one.
    // ToolStepGroup renders a run of one with no header, so nothing is gained
    // by special-casing it here and the stability is worth everything.
    // `currentLead` survives to here only if nothing but steps followed it:
    // that is the burst a running agent is working in.
    return { groupLead: lead, groupedIds: grouped, contextMigratedInGroup: contextMigrated, trailingLead: currentLead };
  }, [visibleMessages, skipIds, pairedTerminals]);

  // Number shortcuts: map the LAST 9 tool calls to 1..9 (most recent = 1) so the
  // user can press a digit to expand/collapse a recent tool call.
  const shortcutMap = useMemo(() => {
    const calls = visibleMessages.filter((m) => m.type === 'tool_call' && !skipIds.has(m.id));
    const recent = calls.slice(-9);
    const map = new Map<string, number>();
    recent.forEach((m, i) => map.set(m.id, recent.length - i)); // most recent → 1
    return map;
  }, [visibleMessages, skipIds]);

  // Press 1..9 (when not typing) to toggle the corresponding recent tool call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const el = scrollRef.current?.querySelector(`[data-tc-index="${e.key}"]`) as HTMLElement | null;
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrollRef]);

  // Scroll to specific message (for navigator)
  const scrollToMessage = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="relative flex-1 min-h-0">
      {/* Floating IDE-style search bar */}
      {searchOpen && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-surface-2 border border-border-bright rounded-xl shadow-lg px-2 py-1.5">
          <Search size={13} className="text-text-dim shrink-0" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveMatch(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
            }}
            placeholder="Search chat…"
            className="bg-transparent outline-none text-sm text-text placeholder:text-text-dim w-44"
          />
          <span className="text-[11px] text-text-dim tabular-nums min-w-[3rem] text-center">
            {matchIds.length > 0 ? `${Math.min(activeMatch + 1, matchIds.length)}/${matchIds.length}` : '0/0'}
          </span>
          <button onClick={() => gotoMatch(-1)} disabled={matchIds.length === 0} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text disabled:opacity-30" title="Previous (Shift+Enter)">
            <ChevronUp size={14} />
          </button>
          <button onClick={() => gotoMatch(1)} disabled={matchIds.length === 0} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text disabled:opacity-30" title="Next (Enter)">
            <ChevronDown size={14} />
          </button>
          <button onClick={() => { setSearchOpen(false); setQuery(''); }} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text" title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Prompt dots, OUTSIDE the scroller so they stay put while you scroll —
          inside it they scrolled away with the first screen of the transcript. */}
      {messages.length > 0 && (
        <ConversationNavigator messages={messages} scrollToMessage={scrollToMessage} />
      )}
      <div ref={scrollRef} className="chat-transcript h-full overflow-y-auto px-4 py-4 relative">
      
      <div className="mx-auto w-full max-w-2xl">
      {/* No empty state here: an empty transcript never reaches this component —
          ChatPanel shows the welcome screen instead. */}
      {visibleMessages.map((msg, vi) => {
        const prev = visibleMessages[vi - 1];
        if (skipIds.has(msg.id)) return null;
        const isActiveMatch = !!query.trim() && msg.id === activeMatchId;
        const node = (() => {
        switch (msg.type) {
          case 'user':
            return <UserMessage key={msg.id} id={msg.id} content={msg.content} checkpointId={msg.checkpointId} />;

          case 'assistant':
            return (
              <AssistantMessage
                key={msg.id}
                content={msg.content}
                streaming={msg.streaming}
                grouped={prev?.type === 'assistant'}
              />
            );

          case 'thinking':
            return (
              <ThinkingBubble
                key={msg.id}
                content={msg.content}
                streaming={msg.streaming}
              />
            );

          case 'tool_call': {
            // A member of a run renders inside its group's block, not here.
            if (groupedIds.has(msg.id)) return null;

            const members = groupLead.get(msg.id);
            if (!members) return renderToolCall(msg);

            const memberMsgs = members
              .map((id) => messageById.get(id))
              .filter((m): m is Extract<ChatMessage, { type: 'tool_call' }> => m?.type === 'tool_call');
            const steps = memberMsgs.map(stepSummary);
            // Wall time for the burst: first call started → last result landed.
            const lastResult = resultByCallId.get(memberMsgs[memberMsgs.length - 1]?.callId ?? '');
            const groupDuration = lastResult && steps.every((s) => s.done)
              ? lastResult.timestamp - msg.timestamp
              : undefined;
            
            // Collect context_migrated messages that belong to this group
            const contextMigratedMsgs = visibleMessages
              .filter((m): m is Extract<ChatMessage, { type: 'context_migrated' }> => 
                m.type === 'context_migrated' && contextMigratedInGroup.get(m.id) === msg.id
              );
            
            return (
              <ToolStepGroup
                key={msg.id}
                steps={steps}
                durationMs={groupDuration}
                live={isRunning && msg.id === trailingLead}
                trailing={contextMigratedMsgs.map((ctxMsg) => (
                  <ContextMigratedMessage
                    key={ctxMsg.id}
                    reason={ctxMsg.reason}
                    summary={ctxMsg.summary}
                  />
                ))}
              />
            );
          }

          case 'tool_result':
            // Already handled inside tool_call bubble, skip rendering separately
            return null;

          case 'terminal':
            if (pairedTerminals.has(msg.id)) return null;
            return (
              <TerminalOutput
                key={msg.id}
                terminalId={msg.terminalId}
                command={msg.command}
                output={msg.output}
                exitCode={msg.exitCode}
                startTime={msg.startTime}
                duration={msg.duration}
                expanded={msg.expanded}
              />
            );

          case 'approval_preparing':
            return (
              <ApprovalPreparingCard
                key={msg.id}
                tool={msg.tool}
                args={msg.args}
              />
            );

          case 'approval':
            return (
              <ApprovalCard
                key={msg.id}
                approvalId={msg.approvalId}
                tool={msg.tool}
                args={msg.args}
                preview={msg.preview}
                status={msg.status}
                onApprove={onApprove}
                onReject={onReject}
              />
            );

          case 'notice':
            return <NoticeMessage key={msg.id} title={msg.title} content={msg.content} />;

          case 'status':
            return <StatusMessage key={msg.id} content={msg.content} />;

          case 'error':
            return <ErrorMessage key={msg.id} content={msg.content} recoverable={msg.recoverable} suggestions={msg.suggestions} />;

          case 'context_migrated':
            // If this context_migrated is part of a group, skip independent rendering
            if (contextMigratedInGroup.has(msg.id)) return null;
            return <ContextMigratedMessage key={msg.id} reason={msg.reason} summary={msg.summary} />;

          case 'delegation':
            return (
              <DelegationCard
                key={msg.id}
                instruction={msg.instruction}
                targetFiles={msg.targetFiles}
                acceptance={msg.acceptance}
                phase={msg.phase}
                detail={msg.detail}
                report={msg.report}
                filesTouched={msg.filesTouched}
                validationOk={msg.validationOk}
              />
            );

          case 'parallel_group':
            return <ParallelAgentsPanel key={msg.id} lanes={msg.lanes} />;

          case 'artifact':
            return <ArtifactCard key={msg.id} artifactId={msg.artifactId} />;

          default:
            return null;
        }
        })();
        const plansHere = anchoredPlans.byMessage.get(msg.id);
        if (node === null && !plansHere) return null;
        return (
          <div
            key={msg.id}
            id={`msg-${msg.id}`}
            className={isActiveMatch ? 'rounded-lg ring-2 ring-accent/60 ring-offset-2 ring-offset-surface-0 transition-all' : ''}
          >
            {node}
            {plansHere?.map((p) => <PlanAnchor key={p.id} plan={p} />)}
          </div>
        );
      })}

      {/*
        The gap between "the turn started" and "something came back".

        Inline at the END of the transcript rather than floating over it, so it
        occupies the exact place the next message will occupy — the answer then
        replaces it in position instead of appearing somewhere else while a
        detached pill fades out. It also means the auto-scroll that keeps the
        transcript pinned to the bottom keeps THIS in view for free.
      */}
      {/* Only when nothing above is already saying so: a live trail names its
          step, streaming prose has its cursor, reasoning has its own row. Two
          liveness indicators for one run read as two things happening. */}
      {isRunning && !trailingLead && !lastIsLive && <AgentPresence />}
      </div>
      </div>

      {/* Scroll-to-bottom button — appears whenever the view isn't pinned to
          the bottom (e.g. you scrolled up to read during generation). */}
      {!isAtBottom && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[3] flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 border border-border-bright shadow-lg text-xs text-text-muted hover:text-text hover:border-accent/50 transition-all animate-fade-in"
          title="Scroll to latest"
        >
          <ChevronDown size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
