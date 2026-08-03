/**
 * Tool calls that arrive as TEXT instead of as tool calls.
 *
 * The happy path is that a model returns tool calls in the structured channel
 * its API provides. Plenty of local models don't — under load, with an
 * unfamiliar tool schema, or with a chat template that doesn't quite match how
 * they were trained, they fall back to writing the call into the answer:
 *
 *     <tool_call>{"name": "write_file", "arguments": {"path": "a.ts", …}}</tool_call>
 *
 * Two things then go wrong at once, and the second is the serious one. The
 * obvious failure is cosmetic: the JSON renders as the assistant's reply, and
 * for a write_file that means the entire file body is dumped into the chat. The
 * real failure is that NOTHING RUNS — the model believes it called the tool,
 * the backend saw only prose, and the turn ends with the model waiting for a
 * result that will never come. From the user's side the agent simply stopped
 * mid-task for no visible reason.
 *
 * Stripping the markers (which is all the sigil filter did) fixes neither: it
 * removes the tags and streams the payload anyway.
 *
 * So this doesn't hide the leak, it RECOVERS it. Text between tool-call markers
 * is withheld from the answer stream and parsed back into a real tool call, so
 * the turn continues exactly as if the model had used the structured channel.
 * Unparseable content is emitted as ordinary text rather than silently eaten —
 * losing the model's output would be a worse failure than showing something
 * ugly.
 */

export interface LeakedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Marker pairs we recognise, as literal strings.
 *
 * Literals rather than patterns because the filter works on a STREAM: it has to
 * answer "could this trailing fragment be the beginning of a marker?" on every
 * chunk, and a prefix test against a known string is exact where a regex is
 * guesswork. Getting that wrong in either direction is bad — hold back too
 * little and half a marker is printed as prose, hold back too much and ordinary
 * text stops streaming.
 */
const MARKERS: Array<{ open: string; close: string[] }> = [
  // Qwen / Hermes / most llama.cpp templates.
  { open: '<tool_call>', close: ['</tool_call>'] },
  { open: '<|tool_call|>', close: ['<|/tool_call|>', '<|tool_call_end|>'] },
  { open: '<function_call>', close: ['</function_call>'] },
  // DeepSeek uses a U+2581 lower-one-eighth-block, not an underscore.
  { open: '<tool▁call>', close: ['</tool▁call>'] },
];

const OPEN_MARKERS = MARKERS.map((m) => m.open.toLowerCase());
const ALL_CLOSE_MARKERS = MARKERS.flatMap((m) => m.close).map((s) => s.toLowerCase());

/** Keys that make an object a tool call rather than incidental JSON. */
function asToolCall(value: unknown): LeakedToolCall | null {
  // Some templates wrap a single call in an array. One call in a one-element
  // array is unambiguous, so honour it; anything longer is not a shape we can
  // safely collapse into a single call.
  if (Array.isArray(value)) {
    return value.length === 1 ? asToolCall(value[0]) : null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  // Different templates name these differently; accept the common spellings.
  const name = o.name ?? o.tool ?? o.tool_name ?? o.function;
  if (typeof name !== 'string' || !name.trim()) return null;
  const rawArgs = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
  let args: unknown = rawArgs;
  // Some models double-encode the arguments as a JSON string.
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs); } catch { return null; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name: name.trim(), args: args as Record<string, unknown> };
}

/** Parse a tool call out of a marker's body, tolerating surrounding noise. */
export function parseLeakedToolCall(body: string): LeakedToolCall | null {
  const text = body.trim();
  if (!text) return null;
  try {
    const direct = asToolCall(JSON.parse(text));
    if (direct) return direct;
  } catch { /* fall through to the substring attempt */ }
  // A template may wrap the JSON in stray prose or a code fence. Take the
  // outermost braces and try again.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return asToolCall(JSON.parse(text.slice(start, end + 1))); } catch { /* not JSON */ }
  }
  return null;
}

/**
 * Would this text, on its own, be a tool call the model meant to make?
 *
 * Used for the untagged case, where the model emits bare JSON with no markers
 * at all. Deliberately narrow: it only matches when the very first non-
 * whitespace characters open an object whose first key is one a tool call would
 * have. Prose never looks like that, and a JSON answer is almost always inside
 * a fence — so this does not blank legitimate output.
 */
export function looksLikeBareToolCall(text: string): boolean {
  return /^\s*\{\s*"(name|tool|tool_name|function|arguments|parameters)"\s*:/.test(text);
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of any string
 * in `candidates` — i.e. how much must be held back because the next chunk
 * might complete a marker.
 *
 * Returns 0 for the overwhelmingly common case of text that could not be the
 * start of anything, so streaming is unaffected.
 */
function partialMarkerTail(text: string, candidates: string[]): number {
  const lower = text.toLowerCase();
  const maxLen = Math.min(lower.length, Math.max(...candidates.map((c) => c.length)) - 1);
  for (let len = maxLen; len > 0; len--) {
    const suffix = lower.slice(lower.length - len);
    if (candidates.some((c) => c.length > len && c.startsWith(suffix))) return len;
  }
  return 0;
}

/** Earliest occurrence of any candidate marker, case-insensitively. */
function firstMarker(text: string, candidates: string[]): { index: number; length: number; which: number } | null {
  const lower = text.toLowerCase();
  let best: { index: number; length: number; which: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const idx = lower.indexOf(candidates[i]);
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { index: idx, length: candidates[i].length, which: i };
    }
  }
  return best;
}

type Phase = 'text' | 'inside';

/**
 * Streaming filter over a model's content channel.
 *
 * Feed it each chunk; it returns the text that is safe to show and collects any
 * tool calls it rescued. Because it must decide with only a prefix in hand, it
 * holds back a short tail whenever that tail could begin a marker, and releases
 * it as soon as the next chunk proves otherwise. `finish()` drains the rest.
 */
export class ToolCallLeakFilter {
  private phase: Phase = 'text';
  private pending = '';
  private body = '';
  private closeMarkers: string[] = [];
  private readonly calls: LeakedToolCall[] = [];
  private sawMarker = false;

  /** Tool calls recovered so far. */
  get recovered(): LeakedToolCall[] {
    return this.calls;
  }

  /** True once any marker has been seen — worth logging, since it means the
   *  model is not using its tool channel properly. */
  get sawLeak(): boolean {
    return this.sawMarker;
  }

  /** Feed a chunk of content; returns the portion safe to emit as answer text. */
  push(chunk: string): string {
    this.pending += chunk;
    let out = '';

    for (;;) {
      if (this.phase === 'text') {
        const hit = firstMarker(this.pending, OPEN_MARKERS);
        if (!hit) break;
        this.sawMarker = true;
        out += this.pending.slice(0, hit.index);
        this.pending = this.pending.slice(hit.index + hit.length);
        this.closeMarkers = MARKERS[hit.which].close.map((s) => s.toLowerCase());
        this.body = '';
        this.phase = 'inside';
        continue;
      }

      // Inside a call: everything is payload until a closing marker.
      const close = firstMarker(this.pending, this.closeMarkers);
      if (!close) break;
      this.body += this.pending.slice(0, close.index);
      this.pending = this.pending.slice(close.index + close.length);
      out += this.closeBody();
      this.phase = 'text';
      this.closeMarkers = [];
    }

    // Hold back only what could still become a marker. Critically this applies
    // in BOTH phases: while inside a call, a closing marker split across two
    // chunks would never be found if the first half had already been swept into
    // the body — which left the filter stuck inside the call for the rest of
    // the response, and dumped the whole payload as text at the end.
    const candidates = this.phase === 'text' ? OPEN_MARKERS : this.closeMarkers;
    const keep = partialMarkerTail(this.pending, candidates);
    const release = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    if (this.phase === 'text') out += release;
    else this.body += release;

    return out;
  }

  /** End of stream: release anything still held. */
  finish(): string {
    if (this.phase === 'inside') {
      // An unterminated marker. Try to parse what we have — a model that ran
      // out of tokens mid-call often still emitted complete JSON.
      this.body += this.pending;
      this.pending = '';
      const released = this.closeBody();
      this.phase = 'text';
      this.closeMarkers = [];
      return released;
    }
    const tail = this.pending;
    this.pending = '';
    return tail;
  }

  /** Convert the accumulated body into a call, or hand it back as text. */
  private closeBody(): string {
    const body = this.body;
    this.body = '';
    const call = parseLeakedToolCall(body);
    if (call) {
      this.calls.push(call);
      return '';
    }
    // Not parseable. Showing it is ugly; DISCARDING it could hide the only
    // thing the model said, so it goes back into the answer.
    return body;
  }
}
