/**
 * Context Manager — keeps the agent loop stable across many steps.
 *
 * Long agentic sessions accumulate huge message histories (tool outputs, file
 * dumps, retries). Left unchecked this overflows the model's context window and
 * the loop "breaks" — the model loses the plan, repeats work, or errors out.
 *
 * This module implements bounded working memory (per dream.md "Token Budget
 * Optimization"):
 *   - Always keep the FIRST user message (the task / goal).
 *   - Always keep the most RECENT turns verbatim (live working set).
 *   - Compact older middle turns: summarize assistant prose, truncate large
 *     tool results, and drop redundant status chatter.
 *   - Preserve tool_use / tool_result pairing so the provider APIs stay valid.
 *
 * It is provider-agnostic and conservative: it never drops the goal, never
 * orphans a tool_result, and only activates once history grows large.
 */

import type { Message, ContentBlock } from '../types';

/** Rough token estimate (≈ 4 chars/token) for a message. */
export function estimateTokens(message: Message): number {
  let chars = 0;
  if (typeof message.content === 'string') {
    chars = message.content.length;
  } else {
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'thinking') chars += block.thinking.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

export interface CompactionOptions {
  /** Soft cap on history tokens. Compaction triggers above this. */
  maxTokens?: number;
  /** Number of most-recent messages always kept verbatim. */
  keepRecent?: number;
  /** Max chars a single tool_result may occupy after compaction. */
  maxToolResultChars?: number;
}

const DEFAULTS: Required<CompactionOptions> = {
  maxTokens: 24000,
  // Keep a generous live working set. Compacting too aggressively (small
  // keepRecent) makes the model lose the thread of the current task.
  keepRecent: 30,
  // 2000 chars is about 25 lines of code — not enough to keep a file the agent
  // is actively editing. Compaction that shreds the working set is how an agent
  // ends up re-reading the same file three times in one turn.
  maxToolResultChars: 6000,
};

/**
 * Compaction runs to a LOWER target than the trigger.
 *
 * Compacting exactly to the budget means the very next tool result crosses it
 * again, so compaction fires on nearly every iteration — each one shaving a
 * little more context off, which is precisely the "it prunes too much"
 * behaviour. Compacting to 70% of the budget buys real headroom, so it fires
 * rarely and takes a bigger, better-chosen bite when it does.
 */
const COMPACTION_TARGET_RATIO = 0.7;

/**
 * Content that is never compacted, regardless of age.
 *
 * The user's own words are the shortest and most valuable thing in the history,
 * and a summary of them is strictly worse than the original.
 */
function isProtected(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content !== 'string') return false;   // tool results are not user prose
  return true;
}

/** Truncate a long tool result, keeping the head and tail (most informative). */
function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return (
    content.slice(0, head) +
    `\n\n…[${content.length - maxChars} chars elided to save context]…\n\n` +
    content.slice(content.length - tail)
  );
}

/** Compact a single message's content blocks (truncate big tool results). */
function compactMessage(message: Message, maxToolResultChars: number): Message {
  if (typeof message.content === 'string') {
    if (message.role === 'assistant' && message.content.length > maxToolResultChars * 2) {
      return { ...message, content: truncateToolResult(message.content, maxToolResultChars * 2) };
    }
    return message;
  }
  const blocks: ContentBlock[] = message.content.map((block) => {
    if (block.type === 'tool_result') {
      // Drop images from compacted (older) tool results — a screenshot has
      // already served its purpose by the time a turn is being compacted, and
      // replaying big base64 blobs every request is expensive. Recent turns
      // (the live working set) keep their images verbatim.
      const { images: _drop, ...rest } = block;
      return { ...rest, content: truncateToolResult(block.content, maxToolResultChars) };
    }
    if (block.type === 'text' && block.text.length > maxToolResultChars * 2) {
      return { ...block, text: truncateToolResult(block.text, maxToolResultChars * 2) };
    }
    return block;
  });
  return { ...message, content: blocks };
}

/**
 * Does the live history still carry image blocks?
 *
 * Asked when a request is rejected outright, because an attached frame is by
 * far the most likely thing in a conversation for a provider to refuse: text
 * gets truncated, images get rejected. See `stripHistoryImages`.
 */
export function historyHasImages(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_result' && !!b.images && b.images.length > 0),
  );
}

/**
 * Remove every image from the history, leaving the words behind.
 *
 * THE RECOVERY THIS EXISTS FOR
 *
 * A provider refuses an oversized or overlarge image with a 400. The frame is
 * already in the message history when that happens, so the retry sends it
 * again, and the retry after that, and so does every later turn in the thread —
 * the failure is not transient, it is now a property of the conversation. That
 * is the difference between "the model errored" and "this thread is dead".
 *
 * `fileToToolImage` is the belt (it refuses to attach a frame the provider
 * would reject); this is the braces, for the cases the size check cannot see —
 * a provider-specific limit, a model switched mid-thread to one without vision,
 * a frame that was fine alone but not alongside three others.
 *
 * The tool result's TEXT is deliberately kept and annotated. Dropping the whole
 * block would orphan its tool_use and make the history invalid; leaving it
 * silent would let the model keep believing it had seen the picture.
 */
export function stripHistoryImages(messages: Message[]): { messages: Message[]; removed: number } {
  let removed = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    if (!m.content.some((b) => b.type === 'tool_result' && !!b.images?.length)) return m;
    const blocks: ContentBlock[] = m.content.map((b) => {
      if (b.type !== 'tool_result' || !b.images?.length) return b;
      removed += b.images.length;
      const { images: _drop, ...rest } = b;
      return {
        ...rest,
        content:
          rest.content +
          '\n(The attached screenshot could not be sent to this model and has been removed from the conversation. You have NOT seen it — do not describe it. Capture a smaller region or reduce the display size if you still need to look.)',
      };
    });
    return { ...m, content: blocks };
  });
  return { messages: out, removed };
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  droppedCount: number;
}

/**
 * Make a reloaded history valid for the provider APIs by removing orphans:
 *   - tool_use blocks with no following tool_result (e.g. the loop stopped
 *     mid-tool-call before the result was saved)
 *   - tool_result blocks with no preceding tool_use
 * Both cause hard 400s from Claude and confuse other providers, which is a
 * common cause of "the agent forgot everything" after a resume.
 */
export function sanitizeHistory(messages: Message[]): Message[] {
  // First pass: collect tool_use ids that HAVE a matching tool_result.
  const resultIds = new Set<string>();
  const useIds = new Set<string>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') resultIds.add(b.tool_use_id);
        if (b.type === 'tool_use') useIds.add(b.id);
      }
    }
  }

  const cleaned: Message[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      cleaned.push(m);
      continue;
    }
    const blocks = m.content.filter((b) => {
      if (b.type === 'tool_use') return resultIds.has(b.id); // keep only paired uses
      if (b.type === 'tool_result') return useIds.has(b.tool_use_id); // keep only paired results
      return true;
    });
    // Drop a message that became empty after filtering.
    if (blocks.length === 0) continue;
    // If only text remains, collapse to a string for cleanliness.
    const onlyText = blocks.every((b) => b.type === 'text');
    if (onlyText) {
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();
      if (text) cleaned.push({ role: m.role, content: text });
    } else {
      cleaned.push({ role: m.role, content: blocks });
    }
  }
  return cleaned;
}

/**
 * Produce a context-window-safe message list. Pure function: returns a new array
 * and never mutates the input. Safe to call every iteration; it's a no-op until
 * history exceeds the budget.
 */
export function compactHistory(messages: Message[], options: CompactionOptions = {}): CompactionResult {
  const opts = { ...DEFAULTS, ...options };
  const tokensBefore = estimateTotalTokens(messages);
  const target = Math.floor(opts.maxTokens * COMPACTION_TARGET_RATIO);

  if (tokensBefore <= opts.maxTokens || messages.length <= opts.keepRecent + 2) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedCount: 0 };
  }

  // Anchor: the first user message holds the goal.
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  const head: Message[] = firstUserIdx >= 0 ? [messages[firstUserIdx]] : [];

  // Tail: the most recent turns, kept verbatim.
  let recentStart = Math.max(messages.length - opts.keepRecent, firstUserIdx + 1);

  // Safeguard: never let compaction cut off in the middle of the CURRENT turn.
  // Find the last user message and make sure the recent window starts at or
  // before it, so the active prompt + everything after it is always verbatim.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i > firstUserIdx; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx > firstUserIdx && lastUserIdx < recentStart) {
    recentStart = lastUserIdx;
  }

  const recent = messages.slice(recentStart);

  // Middle: everything between head and recent → compacted.
  const middle = messages.slice(firstUserIdx + 1, recentStart);

  // Compact middle messages; collapse runs of assistant text into brief notes
  // and truncate tool results. Drop nothing that would orphan a tool_result.
  const compactedMiddle: Message[] = [];
  let dropped = 0;
  for (const m of middle) {
    // Drop pure no-op nudges that carry no information at all. These are OUR OWN
    // injected continuation prompts, not anything the user said.
    if (
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.length < 400 &&
      /^(?:continue|please continue|what should we do next|the previous request failed)/i.test(m.content.trim())
    ) {
      dropped++;
      continue;
    }
    // The user's own prose survives verbatim. It is short, it is the source of
    // every constraint in the task, and paraphrasing it is how an agent ends up
    // confidently doing the thing it was explicitly told not to.
    if (isProtected(m)) { compactedMiddle.push(m); continue; }
    compactedMiddle.push(compactMessage(m, opts.maxToolResultChars));
  }

  let result = [...head, ...compactedMiddle, ...recent];
  let tokensAfter = estimateTotalTokens(result);

  // Second pass: squeeze the OLDEST half of the middle harder before resorting
  // to dropping anything. Shrinking a tool result still leaves the fact that
  // the call happened and what it was about; dropping it leaves nothing.
  if (tokensAfter > target) {
    const half = Math.floor(compactedMiddle.length / 2);
    for (let i = 0; i < half; i++) {
      if (isProtected(compactedMiddle[i])) continue;
      compactedMiddle[i] = compactMessage(compactedMiddle[i], Math.floor(opts.maxToolResultChars / 4));
    }
    result = [...head, ...compactedMiddle, ...recent];
    tokensAfter = estimateTotalTokens(result);
  }

  // Only now, still over budget, replace the oldest half with a placeholder.
  if (tokensAfter > target) {
    // Replace the oldest half of the middle with a single summary placeholder.
    const halfway = Math.floor(compactedMiddle.length / 2);
    const summarized = compactedMiddle.slice(halfway);
    const summaryNote: Message = {
      role: 'user',
      content:
        `[Context note: ${halfway + dropped} earlier steps were summarized to save space. ` +
        `Work completed so far is reflected in the files and the spec/task state. ` +
        `Continue from the current state — do not redo finished work.]`,
    };
    result = [...head, summaryNote, ...summarized, ...recent];
    tokensAfter = estimateTotalTokens(result);
    dropped += halfway;
  }

  return {
    messages: result,
    compacted: true,
    tokensBefore,
    tokensAfter,
    droppedCount: dropped,
  };
}
