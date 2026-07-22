import type { ChatMessage, FileDiff } from '../types';

/**
 * Backend message format from the database
 */
interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: string; // JSON string of tool calls
  createdAt: string;
}

/**
 * Backend approval format from the database
 */
interface UIApproval {
  id: string;
  tool: string;
  args: string; // JSON string
  preview?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

/**
 * Content block from Claude API format
 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11);
}

/**
 * Reconstruct ChatMessage objects from backend data
 * This converts the database format into the frontend ChatMessage format
 * and properly handles tool calls, tool results, and approvals
 */
export function reconstructMessages(
  messages: UIMessage[],
  approvals: UIApproval[]
): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  const approvalMap = new Map<string, UIApproval>();
  approvals.forEach((approval) => approvalMap.set(approval.id, approval));

  // Remember tool names by call id so reconstructed tool_result rows can show
  // the correct tool (the stored tool_result block doesn't include the name).
  const toolNameByCallId = new Map<string, string>();

  const pushBlocks = (blocks: ContentBlock[], role: 'user' | 'assistant', timestamp: number) => {
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text && block.text.trim()) {
          chatMessages.push({ id: nanoid(), type: 'assistant', content: block.text, streaming: false, timestamp });
        }
      } else if (block.type === 'thinking') {
        if (block.thinking && block.thinking.trim()) {
          chatMessages.push({ id: nanoid(), type: 'thinking', content: block.thinking, streaming: false, timestamp });
        }
      } else if (block.type === 'tool_use') {
        toolNameByCallId.set(block.id, block.name);
        const approval = approvalMap.get(block.id);
        if (approval) {
          chatMessages.push({
            id: nanoid(),
            type: 'approval',
            approvalId: approval.id,
            tool: approval.tool,
            args: safeParse(approval.args, {}),
            preview: approval.preview,
            status: approval.status,
            timestamp: new Date(approval.createdAt).getTime(),
          });
        } else {
          chatMessages.push({ id: nanoid(), type: 'tool_call', tool: block.name, args: block.input, callId: block.id, timestamp });
        }
      } else if (block.type === 'tool_result') {
        let diff: FileDiff[] | undefined;
        const parsed = safeParse<{ diff?: FileDiff[] }>(block.content, {} as any);
        if (parsed && Array.isArray(parsed.diff)) diff = parsed.diff;
        chatMessages.push({
          id: nanoid(),
          type: 'tool_result',
          tool: toolNameByCallId.get(block.tool_use_id) ?? '',
          result: block.content,
          callId: block.tool_use_id,
          diff,
          timestamp,
        });
      }
    }
  };

  messages.forEach((msg) => {
    const timestamp = new Date(msg.createdAt).getTime();

    // Structured content (text + tool_use / tool_result) lives in toolCalls for
    // BOTH roles: assistant turns carry tool_use, the synthetic user turns that
    // follow carry tool_result. Parse it for either role.
    if (msg.toolCalls) {
      const blocks = safeParse<ContentBlock[]>(msg.toolCalls, []);
      if (Array.isArray(blocks) && blocks.length > 0) {
        pushBlocks(blocks, msg.role, timestamp);
        return;
      }
    }

    // Plain text message.
    if (msg.role === 'user') {
      if (msg.content && msg.content.trim()) {
        chatMessages.push({ id: msg.id, type: 'user', content: msg.content, timestamp });
      }
      // A user row with neither text nor blocks is a stale tool-result holder —
      // skip it so we don't render empty bubbles (the "empty/zigzag" bug).
    } else if (msg.role === 'assistant') {
      if (msg.content && msg.content.trim()) {
        chatMessages.push({ id: msg.id, type: 'assistant', content: msg.content, streaming: false, timestamp });
      }
    }
  });

  return chatMessages;
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Load thread data from the backend and reconstruct messages
 */
export async function loadThread(threadId: string): Promise<{
  messages: ChatMessage[];
  plan?: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>;
  sessionChanges?: FileDiff[];
  error?: string;
}> {
  try {
    const response = await fetch(`/api/sessions/${threadId}/messages`);
    
    if (!response.ok) {
      throw new Error(`Failed to load thread: ${response.statusText}`);
    }
    
    const data = await response.json() as {
      messages: UIMessage[];
      approvals: UIApproval[];
      plan?: Array<{ title: string; status: 'todo' | 'in_progress' | 'done' }>;
      sessionChanges?: Array<{ path: string; type: 'created' | 'modified' | 'deleted'; additions: number; deletions: number; diff?: string }>;
    };
    
    const messages = reconstructMessages(data.messages, data.approvals);

    // Map persisted session changes into FileDiff shape for the Changes panel,
    // including the stored unified-diff patch so it renders fully on reload.
    const sessionChanges: FileDiff[] = (data.sessionChanges ?? []).map((c) => ({
      path: c.path,
      type: c.type,
      diff: c.diff ?? '',
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
    }));
    
    return { messages, plan: data.plan ?? [], sessionChanges };
  } catch (err) {
    console.error('Failed to load thread:', err);
    return {
      messages: [],
      error: err instanceof Error ? err.message : 'Failed to load thread',
    };
  }
}
