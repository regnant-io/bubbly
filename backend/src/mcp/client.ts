/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Speaks JSON-RPC 2.0 over a stdio child process — the most common MCP
 * transport (npx/uvx servers). We implement just enough of the protocol to:
 *   - initialize the session
 *   - list the server's tools
 *   - call a tool and read its result
 *
 * This avoids a heavy SDK dependency while giving the agent real MCP tools.
 * Remote (SSE/HTTP) servers are handled separately in manager.ts.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../utils/logger';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Common surface implemented by every transport so the manager is agnostic. */
export interface McpClient {
  connect(timeoutMs?: number): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  readonly isConnected: boolean;
  close(): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';

export class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = '';
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
  ) {}

  /** Spawn the server process and perform the MCP initialize handshake. */
  async connect(timeoutMs = 15000): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, npx/uvx are .cmd shims that require a shell to resolve.
      shell: process.platform === 'win32',
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      logger.debug('MCP server stderr', { command: this.command, data: chunk.toString('utf8').slice(0, 500) });
    });
    this.proc.on('exit', (code) => {
      logger.info('MCP server exited', { command: this.command, code });
      this.failAll(new Error(`MCP server exited (code ${code})`));
      this.proc = null;
      this.initialized = false;
    });
    this.proc.on('error', (err) => {
      logger.warn('MCP server process error', { command: this.command, error: err.message });
      this.failAll(err);
    });

    // Handshake.
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'bubbly', version: '1.0.0' },
    }, timeoutMs);
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDef[] };
    return result?.tools ?? [];
  }

  /** Call a tool; returns the textual content of the result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args }, 120000)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .trim();
    if (result?.isError) return `Error: ${text || 'tool reported an error'}`;
    return text || '(no output)';
  }

  get isConnected(): boolean {
    return !!this.proc && this.initialized;
  }

  close(): void {
    this.failAll(new Error('client closed'));
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.initialized = false;
  }

  // --- internals ---

  private onData(text: string): void {
    this.buffer += text;
    // Messages are newline-delimited JSON (LSP-style framing is also valid but
    // npx/uvx servers use newline-delimited JSON in practice).
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.onMessage(msg);
      } catch {
        // Partial/non-JSON line — ignore (some servers print banners).
      }
    }
  }

  private onMessage(msg: any): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
      else p.resolve(msg.result);
    }
    // Server-initiated requests/notifications are ignored (we don't expose
    // sampling/roots). This keeps the client read-only and safe.
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('MCP client not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch { /* ignore */ }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}


/**
 * Remote MCP client over the Streamable HTTP transport (the current standard
 * for hosted MCP servers). It POSTs JSON-RPC requests to a single endpoint and
 * accepts either a plain JSON response or an SSE (`text/event-stream`) body,
 * extracting the JSON-RPC message that matches the request id. A session id
 * returned via the `Mcp-Session-Id` header on initialize is echoed back on
 * every subsequent request. Optional static headers carry auth (e.g. Bearer).
 *
 * This is deliberately request/response oriented (no long-lived server push) —
 * enough for tool discovery and tool calls, which is all the agent needs.
 */
export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async connect(timeoutMs = 20000): Promise<void> {
    if (this.initialized) return;
    if (!/^https?:\/\//i.test(this.url)) {
      throw new Error(`Invalid MCP server URL: ${this.url}`);
    }
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'bubbly', version: '1.0.0' },
    }, timeoutMs);
    // Best-effort "initialized" notification (servers may 202/ignore it).
    try { await this.notify('notifications/initialized', {}); } catch { /* ignore */ }
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDef[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args }, 120000)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .trim();
    if (result?.isError) return `Error: ${text || 'tool reported an error'}`;
    return text || '(no output)';
  }

  get isConnected(): boolean {
    return this.initialized && !this.closed;
  }

  close(): void {
    this.closed = true;
    this.initialized = false;
  }

  // --- internals ---

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Accept both response styles; servers pick one.
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => undefined);
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<unknown> {
    if (this.closed) throw new Error('MCP client closed');
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.baseHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      // Capture a session id handed back on initialize.
      const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      const raw = await res.text();
      const msg = ctype.includes('text/event-stream')
        ? extractJsonRpcFromSse(raw, id)
        : safeJson(raw);
      if (!msg) throw new Error(`MCP "${method}": no JSON-RPC response found`);
      if ((msg as any).error) throw new Error((msg as any).error.message ?? 'MCP error');
      return (msg as any).result;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`MCP request "${method}" timed out`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Parse an SSE body and return the JSON-RPC message whose id matches `id`
 * (or the last data payload if no id match is found). Exported for testing.
 */
export function extractJsonRpcFromSse(body: string, id?: number): unknown {
  const payloads: unknown[] = [];
  // SSE events are separated by blank lines; data can span multiple `data:` lines.
  for (const block of body.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const parsed = safeJson(dataLines.join('\n'));
    if (parsed) payloads.push(parsed);
  }
  if (payloads.length === 0) return null;
  if (id != null) {
    const match = payloads.find((p) => (p as any)?.id === id);
    if (match) return match;
  }
  return payloads[payloads.length - 1];
}
