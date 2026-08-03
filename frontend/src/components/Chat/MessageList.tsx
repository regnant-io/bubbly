import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { ChatMessage } from '../../types';
import { ToolIndicator } from '../Shared/ToolIndicator';
import { ToolStepGroup, type ToolStepSummary } from '../Shared/ToolStepGroup';
import { ApprovalCard } from '../Shared/ApprovalCard';
import { ApprovalPreparingCard } from '../Shared/ApprovalPreparingCard';
import { TerminalOutput } from '../Shared/TerminalOutput';
import { MarkdownContent } from '../Shared/MarkdownContent';
import { ThinkingBubble } from '../Shared/ThinkingBubble';
import { TwoBubbleLoader } from '../Shared/TwoBubbleLoader';
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

interface MessageListProps {
  messages: ChatMessage[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

const UserMessage = React.memo(function UserMessage({ id, content, checkpointId }: { id: string; content: string; checkpointId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { bind } = useAppContextMenu();
  // "Long" prompts get a read-more so they don't dominate the transcript.
  const LIMIT = 320;
  const isLong = content.length > LIMIT;
  const shown = isLong && !expanded ? content.slice(0, LIMIT).trimEnd() + '…' : content;

  return (
    <div
      className="mb-5 mt-1 animate-fade-in group/usermsg"
      {...bind([
        { label: 'Copy prompt', onSelect: () => navigator.clipboard?.writeText(content) },
        { label: isLong && !expanded ? 'Expand' : 'Collapse', onSelect: () => setExpanded((e) => !e), disabled: !isLong },
      ])}
    >
      <p className="text-lg font-semibold text-text leading-relaxed whitespace-pre-wrap underline decoration-accent/50 decoration-1 underline-offset-[6px]">
        {shown}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs font-medium text-accent-bright hover:underline"
        >
          {expanded ? 'Read less' : 'Read more'}
        </button>
      )}
      {checkpointId && (
        <div className="opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity">
          <PromptRevertButton messageId={id} checkpointId={checkpointId} content={content} />
        </div>
      )}
    </div>
  );
});

const AssistantMessage = React.memo(function AssistantMessage({ content, streaming, grouped }: { content: string; streaming?: boolean; grouped?: boolean }) {
  const { bind } = useAppContextMenu();
  return (
    <div
      className={`${grouped ? 'mb-2' : 'mb-4'} animate-fade-in`}
      {...bind([{ label: 'Copy message', onSelect: () => navigator.clipboard?.writeText(content), disabled: !content }])}
    >
      <div className={`text-sm text-text leading-relaxed ${streaming ? 'typing-cursor' : ''}`}>
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

function StatusMessage({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 py-1 mb-2 animate-fade-in">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-xs text-text-dim">{content}</span>
    </div>
  );
}

function ErrorMessage({ content, recoverable, suggestions }: { 
  content: string; 
  recoverable?: boolean;
  suggestions?: string[];
}) {
  const [expanded, setExpanded] = React.useState(false);
  
  return (
    <div className="flex items-start gap-2 mb-4 animate-fade-in">
      <AlertCircle size={14} className="text-red-agent mt-0.5 shrink-0" />
      <div className="bg-error-bg border border-red-agent/30 rounded-xl px-3 py-2 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-red-agent flex-1">{content}</p>
          {suggestions && suggestions.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-red-agent/70 hover:text-red-agent transition-colors shrink-0"
              title={expanded ? 'Hide suggestions' : 'Show suggestions'}
            >
              {expanded ? '▼' : '▶'} Help
            </button>
          )}
        </div>
        
        {expanded && suggestions && suggestions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-red-agent/20">
            <p className="text-xs text-red-agent/80 font-medium mb-1">
              {recoverable ? 'Try these steps:' : 'Possible solutions:'}
            </p>
            <ul className="text-xs text-red-agent/70 space-y-1 list-disc list-inside">
              {suggestions.map((suggestion, idx) => (
                <li key={idx}>{suggestion}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
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
    ? 'Continued in a fresh thread (smaller model context)'
    : 'Continued in a fresh thread (context limit reached)';
  return (
    <div className="flex items-start gap-2 my-4 animate-fade-in">
      <Info size={14} className="text-accent-bright mt-0.5 shrink-0" />
      <div className="flex-1 bg-accent/8 border border-accent/25 rounded-xl px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-text font-medium">{headline}</p>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-accent-bright hover:underline shrink-0"
          >
            {expanded ? 'Hide handoff' : 'Show handoff'}
          </button>
        </div>
        <p className="text-xs text-text-dim mt-0.5">
          Work continues automatically with a summary so nothing is lost.
        </p>
        {expanded && (
          <div className="mt-2 pt-2 border-t border-accent/20 text-xs text-text-muted max-h-72 overflow-y-auto">
            <MarkdownContent content={summary} />
          </div>
        )}
      </div>
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
        repeatCount={editCounts.get(msg.callId)}
        shortcutIndex={shortcutMap.get(msg.id)}
        progress={msg.progress}
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
      isError: /^(error|tool (execution )?failed|cannot|could not)|failed verification/i.test(result.trim()),
      additions: resultMsg?.diff?.reduce((n, d) => n + (d.additions || 0), 0) ?? 0,
      deletions: resultMsg?.diff?.reduce((n, d) => n + (d.deletions || 0), 0) ?? 0,
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

  // Consolidate runs of consecutive edits to the SAME file into one block, so
  // many sequential edit_file/append_file calls don't spam the transcript. We
  // keep the first call (annotated with the total count) and skip the rest +
  // their results. Any non-edit interaction breaks the run. The full diffs
  // still live in the Changes panel.
  const { skipIds, editCounts } = useMemo(() => {
    const skip = new Set<string>();
    const counts = new Map<string, number>();
    let leadCallId: string | null = null;
    let leadPath: string | null = null;
    const mergedCallIds = new Set<string>();
    const isEdit = (m: ChatMessage) => m.type === 'tool_call' && (m.tool === 'edit_file' || m.tool === 'append_file');
    for (const m of visibleMessages) {
      if (m.type === 'tool_call' && isEdit(m)) {
        const p = String((m.args as any)?.path ?? '');
        if (p && p === leadPath && leadCallId) {
          skip.add(m.id);
          mergedCallIds.add(m.callId);
          counts.set(leadCallId, (counts.get(leadCallId) ?? 1) + 1);
        } else {
          leadPath = p; leadCallId = m.callId;
        }
      } else if (m.type === 'tool_result') {
        if (mergedCallIds.has(m.callId)) skip.add(m.id); // hide merged results
        // a result for the lead edit doesn't break the run
      } else if (m.type !== 'status') {
        leadCallId = null; leadPath = null; // any other interaction ends the run
      }
    }
    return { skipIds: skip, editCounts: counts };
  }, [visibleMessages]);

  /**
   * Runs of consecutive tool calls, so a burst of steps renders as ONE
   * collapsible block instead of N loose lines (see ToolStepGroup).
   *
   * A run is broken by anything that isn't a tool call, its result, or a
   * transient status line — prose, an approval, an error, a delegation. Those
   * are the moments the agent genuinely changes what it's doing, and they are
   * exactly where a reader expects one block to end and the next to begin.
   *
   * Single calls are deliberately NOT grouped: wrapping one line in a header
   * that says "1 step" adds chrome and removes nothing.
   */
  const { groupLead, groupedIds } = useMemo(() => {
    const lead = new Map<string, string[]>();
    const grouped = new Set<string>();
    let currentLead: string | null = null;
    for (const m of visibleMessages) {
      if (skipIds.has(m.id)) continue;
      if (m.type === 'tool_call') {
        if (currentLead === null) { currentLead = m.id; lead.set(m.id, [m.id]); }
        else { lead.get(currentLead)!.push(m.id); grouped.add(m.id); }
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
    return { groupLead: lead, groupedIds: grouped };
  }, [visibleMessages, skipIds]);

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

      <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto w-full max-w-3xl">
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
            // No "is this the newest block" check any more: groups are collapsed
            // by default whether or not they are still running, so their state
            // no longer depends on what comes after them in the transcript.
            return (
              <ToolStepGroup key={msg.id} steps={steps} durationMs={groupDuration}>
                {memberMsgs.map(renderToolCall)}
              </ToolStepGroup>
            );
          }

          case 'tool_result':
            // Already handled inside tool_call bubble, skip rendering separately
            return null;

          case 'terminal':
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

          case 'status':
            return <StatusMessage key={msg.id} content={msg.content} />;

          case 'error':
            return <ErrorMessage key={msg.id} content={msg.content} recoverable={msg.recoverable} suggestions={msg.suggestions} />;

          case 'context_migrated':
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

      {/* Two-bubble "typing" indicator — fills the beat between the user's
          message and the agent's first token (thinking or text). Once any
          response content exists for this turn, the last visible message is
          no longer 'user' and this disappears on its own. */}
      {(() => {
        // "The model is working" indicator. It must cover the QUIET stretches
        // where the model is generating but nothing is streaming yet — most
        // importantly the gap after an assistant's prose while it generates a
        // tool call. With Ollama that gap is the whole "frozen minute" of a big
        // file write: Ollama can't stream tool-call arguments, so the file
        // arrives complete at the end, and without this the chat would sit dead.
        // Hidden when something IS live (tokens streaming, or a tool executing
        // with its own spinner) so we never double up.
        if (!isRunning || visibleMessages.length === 0) return null;
        const last = visibleMessages[visibleMessages.length - 1];
        const isStreaming = (last.type === 'assistant' || last.type === 'thinking')
          && (last as { streaming?: boolean }).streaming;
        const isExecutingTool = last.type === 'tool_call' && !toolResultMap.has(last.callId);
        if (isStreaming || isExecutingTool) return null;
        return <TwoBubbleLoader />;
      })()}
      </div>
      </div>

      {/* Scroll-to-bottom button — appears whenever the view isn't pinned to
          the bottom (e.g. you scrolled up to read during generation). */}
      {!isAtBottom && (
        <button
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 border border-border-bright shadow-lg text-xs text-text-muted hover:text-text hover:border-accent/50 transition-all animate-fade-in"
          title="Scroll to latest"
        >
          <ChevronDown size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
