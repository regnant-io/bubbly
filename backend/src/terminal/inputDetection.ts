/**
 * Interactive-input detection for terminal / process output.
 *
 * Many commands stop and wait for the user to type something — a yes/no
 * confirmation (`Overwrite? (y/N)`), a password (`Password:`), a scaffolder
 * question (`? Project name:`), or a "press any key" pause. When the agent runs
 * such a command non-interactively it appears to "hang": the process is alive
 * but blocked on stdin that will never arrive.
 *
 * This module inspects the TRAILING output of a stream and decides whether the
 * program is most likely waiting for input. It is a heuristic — designed to err
 * toward NOT crying wolf (false negatives are cheaper than false positives that
 * would auto-answer prompts the user actually wanted to see). It is a pure
 * function so it is trivially testable and can be wired into both the PTY
 * terminal manager and the background-process manager.
 */

export type InputPromptKind =
  | 'confirm' // yes/no style
  | 'password' // secret entry
  | 'question' // free-text prompt (scaffolders, REPL-ish)
  | 'pause' // "press any key / enter to continue"
  | 'selection'; // pick-from-list menus

export interface InputPromptDetection {
  /** Whether the stream appears to be waiting for user input. */
  waiting: boolean;
  kind: InputPromptKind;
  /** The trailing prompt text that triggered detection (trimmed, bounded). */
  prompt: string;
  /** A suggested safe default reply, when one is obvious (e.g. "y"). */
  suggestedReply?: string;
}

// Strip ANSI escapes / carriage returns so matching works on the visible text.
function clean(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '');
}

/** Return the last non-empty line of the text (after cleaning), bounded length. */
function lastMeaningfulLine(text: string): string {
  const lines = clean(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t.slice(0, 200);
  }
  return '';
}

// Yes/no confirmations. Capture the default if the prompt encodes one ([Y/n]).
const CONFIRM_PATTERNS: RegExp[] = [
  /\((?:y\/n|yes\/no|y\/n\/a)\)\s*[:?]?\s*$/i,
  /\[(?:y\/n|yes\/no)\]\s*[:?]?\s*$/i,
  /\[y\/n\]/i,
  /\b(?:ok to proceed\??|are you sure\??|do you want to continue\??|continue\??|proceed\??|overwrite\??)\s*(?:\([^)]*\)|\[[^\]]*\])?\s*[:?]?\s*$/i,
];

const PASSWORD_PATTERNS: RegExp[] = [
  /\bpass(?:word|phrase)\b[^:]*:\s*$/i,
  /\benter\s+(?:the\s+)?pass(?:word|phrase)\b[^:]*:?\s*$/i,
  /'s password:\s*$/i,
  /\b(?:pin|otp|verification code)\b[^:]*:\s*$/i,
];

const PAUSE_PATTERNS: RegExp[] = [
  /press\s+(?:any\s+key|enter|return)\s+to\s+(?:continue|proceed|exit)/i,
  /press\s+\[?enter\]?\s+to\s+continue/i,
  /-{2,}\s*more\s*-{2,}/i, // pager
];

const SELECTION_PATTERNS: RegExp[] = [
  /use arrow keys/i,
  /\(use arrow keys\)/i,
  /❯\s+/, // inquirer pointer
  /›\s+/,
  /select (?:an? )?(?:option|item|choice)/i,
];

// Free-text scaffolder/REPL questions: a line that begins with the common
// prompt glyphs (?, ✔, »), or ends with a question mark / colon while clearly
// expecting an answer (e.g. "Project name:", "package name: (myapp)").
const QUESTION_LEADERS = /^(?:[?✔✓✗»>])\s+\S/;
const QUESTION_TRAILERS = /(?:\?|:)\s*(?:\([^)]*\))?\s*$/;

/**
 * Log chatter that ENDS IN A COLON but is not a question.
 *
 * This guard exists because of a specific, expensive failure: `npm install` on
 * an existing project prints deprecation warnings shaped exactly like a prompt —
 *
 *     npm warn deprecated inflight@1.0.6: This module is not supported…
 *
 * and the output is read in arbitrary stream chunks, so a chunk boundary landing
 * right after that colon leaves a buffer whose last line is `npm warn deprecated
 * inflight@1.0.6:` with no trailing newline. That is indistinguishable, to the
 * trailer rule above, from `Project name:`. The caller then concluded the
 * install was blocked on an unanswerable question and killed the process tree —
 * mid-`reify`, leaving a half-written node_modules. New projects have no
 * deprecated dependencies and so never tripped it, which is exactly why this
 * only ever failed on projects that already existed.
 *
 * Matched against the last line only, before the free-text question rule (the
 * confirm/password/pause/selection rules are specific enough not to need it).
 */
const TOOL_NOISE_PATTERNS: RegExp[] = [
  // Package managers announcing something, in any of their prefix styles.
  /^(?:npm|pnpm|yarn|bun|npx)\s+(?:warn|notice|error|err!?|info|verb|http|sill|timing)\b/i,
  /^npm\s+ERR!/,
  // A deprecation/advisory line: "<name>@<version>: <text>" is a report, not a question.
  /\bdeprecated\s+\S+@\S+\s*:/i,
  // Generic log-level prefixes used by webpack, vite, pip, cargo, gradle…
  /^(?:warning|error|note|info|debug|trace|hint|deprecated)\b\s*[:!]?/i,
  // Leading timestamps / bracketed log tags.
  /^\[[^\]]{1,40}\]/,
  /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/i,
  // npm/yarn summary lines.
  /^\s*(?:added|removed|changed|audited|found|up to date)\b/i,
  // Progress narration — a colon here introduces a value, never a question.
  /^(?:progress|resolving|fetching|downloading|extracting|linking|building|compiling|installing|packages|dependencies|reify|idealTree)\b/i,
  // Stack traces and file:line references.
  /^\s*at\s+\S+\s*\(/,
  /^\s*(?:[A-Za-z]:)?[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json):\d+/,
];

function isToolNoise(line: string): boolean {
  return TOOL_NOISE_PATTERNS.some((p) => p.test(line));
}

function endsWithoutNewline(text: string): boolean {
  const cleaned = clean(text);
  return cleaned.length > 0 && !/\n\s*$/.test(cleaned);
}

function extractDefault(line: string): string | undefined {
  // [Y/n] / (Y/n) → default yes; [y/N] / (y/N) → default no. The uppercase
  // letter marks the default.
  const m = line.match(/[[(]\s*(y)\s*\/\s*(n)\s*[\])]/i);
  if (m) {
    if (m[1] === 'Y') return 'y';
    if (m[2] === 'N') return 'n';
    return undefined; // both lowercase: no explicit default
  }
  // (default) form e.g. "package name: (my-app)" — but not a yes/no token.
  const d = line.match(/\(([^)]{1,40})\)\s*$/);
  if (d) {
    const v = d[1].trim();
    if (/^[yn]$/i.test(v)) return undefined; // "(y)" is not a default value
    if (/^[yn]\/[yn]$/i.test(v) || /yes\/no/i.test(v)) return undefined;
    return v;
  }
  return undefined;
}

/**
 * Inspect trailing output and decide whether input is awaited.
 * Pass the recent tail of the stream (a few KB is plenty).
 */
export function detectInputPrompt(recentOutput: string): InputPromptDetection | null {
  if (!recentOutput) return null;
  const tail = recentOutput.slice(-4000);
  const line = lastMeaningfulLine(tail);
  if (!line) return null;

  // A prompt that is genuinely waiting almost never ends with a newline — the
  // cursor sits on the prompt line. We use this to cut false positives from
  // log lines that merely happen to contain a "?".
  const waitingCursor = endsWithoutNewline(tail);

  // Password — check first; highest sensitivity, lowest false-positive risk.
  if (PASSWORD_PATTERNS.some((p) => p.test(line))) {
    return { waiting: true, kind: 'password', prompt: line };
  }

  // Pause / "press any key" — before confirm, since "press enter to continue"
  // contains the word "continue" that the confirm matcher also looks for.
  if (PAUSE_PATTERNS.some((p) => p.test(line))) {
    return { waiting: true, kind: 'pause', prompt: line, suggestedReply: '\r' };
  }

  // Confirmations.
  if (CONFIRM_PATTERNS.some((p) => p.test(line))) {
    return {
      waiting: true,
      kind: 'confirm',
      prompt: line,
      suggestedReply: extractDefault(line),
    };
  }

  // Selection menus (arrow-key driven). Scoped to the RECENT tail rather than
  // the whole 4KB buffer: the pointer glyphs (❯ ›) are used decoratively by
  // plenty of tools, and one appearing thousands of characters ago says nothing
  // about whether the process is waiting right now.
  const recentLines = clean(tail).split('\n').slice(-10).join('\n');
  if (SELECTION_PATTERNS.some((p) => p.test(recentLines))) {
    return { waiting: true, kind: 'selection', prompt: line };
  }

  // Free-text questions: require the waiting cursor to avoid matching ordinary
  // log lines. Either a leader glyph, or a question/colon trailer.
  if (waitingCursor && (QUESTION_LEADERS.test(line) || QUESTION_TRAILERS.test(line))) {
    // Guard against obvious non-prompts: URLs, "Note:", timestamps, key: value
    // log lines that are short and lowercase-keyed are still likely prompts, so
    // we only exclude clear false positives.
    if (/^https?:\/\//i.test(line)) return null;
    // …and against tool chatter that merely ends in a colon. See TOOL_NOISE_PATTERNS:
    // this is what stopped `npm warn deprecated foo@1.0.0:` from being read as a
    // question and getting a healthy install killed.
    if (isToolNoise(line)) return null;
    return {
      waiting: true,
      kind: 'question',
      prompt: line,
      suggestedReply: extractDefault(line),
    };
  }

  return null;
}
