/**
 * The CLI's connection to Bubbly.
 *
 * WHY THE CLI IS A CLIENT AND NOT A SECOND AGENT
 *
 * The tempting shortcut is to give the CLI its own agent loop — import the
 * orchestrator, run it in-process, print the result. It would work on the first
 * day and then diverge forever: two implementations of approvals, two of
 * context compaction, two of what `/fix` means, and every fix applied to one of
 * them.
 *
 * So the CLI speaks exactly the protocol the desktop app speaks, over the same
 * WebSocket, to the same backend. Everything the agent can do it can do,
 * automatically, including features added after this file was written. A thread
 * started in the terminal can be reopened in the app and vice versa, because
 * they are the same thread.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface ClientOptions {
  /** Base HTTP URL of the backend, e.g. http://localhost:3001 */
  baseUrl: string;
  /** Give up connecting after this long. */
  connectTimeoutMs?: number;
}

export interface ChatOptions {
  message: string;
  workspacePath: string;
  sessionId?: string;
  threadType?: string;
  workflow?: { command: string; args: Record<string, string>; openFiles?: string[] };
  source?: unknown;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * A live connection that re-establishes itself.
 *
 * Reconnection matters more here than in the browser: a CLI session is often
 * left open across a laptop sleep, and a dead socket that never recovers means
 * the next message silently does nothing.
 */
export class BubblyClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private reconnectAttempt = 0;
  private closedByUs = false;
  private queue: string[] = [];

  constructor(private readonly options: ClientOptions) {
    super();
    this.wsUrl = `${options.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, '');
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(
          `Could not reach the Bubbly backend at ${this.options.baseUrl} within ` +
          `${(this.options.connectTimeoutMs ?? 10_000) / 1000}s. Start it with \`bubbly serve\`, or pass --url.`,
        ));
      }, this.options.connectTimeoutMs ?? 10_000);

      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        clearTimeout(timeout);
        this.reconnectAttempt = 0;
        for (const queued of this.queue.splice(0)) ws.send(queued);
        this.emit('connected');
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(data.toString()) as ServerEvent;
        } catch {
          return; // a malformed frame is not worth crashing a session over
        }
        this.emit('event', event);
        this.emit(event.type, event);
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        // Only the FIRST failure is fatal — after that we are reconnecting, and
        // surfacing every transient error would fill the terminal with noise.
        if (this.reconnectAttempt === 0 && !this.connected) reject(err);
        else this.emit('warning', err.message);
      });

      ws.on('close', () => {
        this.ws = null;
        if (this.closedByUs) return;
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > 20) {
      this.emit('disconnected', 'Gave up reconnecting to the backend.');
      return;
    }
    this.emit('reconnecting', this.reconnectAttempt);
    setTimeout(() => {
      this.connect().catch(() => { /* the close handler schedules the next try */ });
    }, delay);
  }

  private send(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    if (this.connected) this.ws!.send(json);
    else this.queue.push(json);
  }

  chat(options: ChatOptions): void {
    this.send({
      type: 'chat',
      message: options.message,
      workspacePath: options.workspacePath,
      sessionId: options.sessionId,
      threadType: options.threadType,
      workflow: options.workflow,
      source: options.source,
    });
  }

  approve(approvalId: string): void { this.send({ type: 'approve', approvalId }); }
  reject(approvalId: string): void { this.send({ type: 'reject', approvalId }); }
  answer(questionId: string, answer: string): void { this.send({ type: 'answer', questionId, answer }); }
  stop(sessionId: string): void { this.send({ type: 'stop', sessionId }); }
  focus(sessionId: string | null): void { this.send({ type: 'focus_session', sessionId }); }

  /**
   * Say something while the agent is still working.
   *
   * Not a `chat`: the server refuses a second concurrent run on a thread, and
   * rightly so. This parks the text and the running loop reads it at its next
   * step boundary — which is what you want anyway, since a mid-run correction
   * is only useful if it arrives somewhere the agent can act on it.
   */
  queueMessage(sessionId: string, message: string): void {
    this.send({ type: 'queue_message', sessionId, message });
  }

  /** Settle one wait immediately, without stopping the turn around it. */
  skipWatch(watcherId: string): void { this.send({ type: 'skip_watch', watcherId }); }

  /**
   * Shut the connection down for good.
   *
   * `terminate()` rather than `close()`, and the listeners come off first.
   *
   * A graceful close starts a handshake that completes on a later tick — and
   * the CLI's very next act is to exit. On Windows that raced libuv's teardown
   * and printed an assertion failure ("!(handle->flags & UV_HANDLE_CLOSING)")
   * after every single session: harmless, alarming, and impossible for a user
   * to interpret as anything other than a crash. There is nothing to negotiate
   * on the way out of a local WebSocket, so we do not negotiate.
   */
  close(): void {
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    this.removeAllListeners();
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch { /* already gone */ }
  }

  /** A typed GET against the REST API, for settings, sessions and connections. */
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${path}`);
    return (await res.json()) as T;
  }

  /** A typed PUT, for settings. */
  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** A typed DELETE. */
  async del<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

/** Is a backend answering on this URL? */
export async function isBackendUp(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
