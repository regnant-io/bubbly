import React from 'react';

/**
 * COLOUR FOR COMMAND OUTPUT, INSIDE THE CONVERSATION.
 *
 * A tool result is not prose. It is a log, and a log without colour is
 * genuinely harder to read than one with it: the eye finds a red line in a wall
 * of grey instantly and has to actually READ its way to the same line in a
 * monochrome block. Bubbly was rendering every byte of command output in one
 * dim grey, so
 *
 *     '.' is not recognized as an internal or external command,
 *     [process exited with code 1]
 *
 * looked exactly like a successful build.
 *
 * TWO SOURCES OF COLOUR, IN ORDER OF TRUST
 *
 * 1. ANSI. If the program said what colour it wanted, use it. Most modern
 *    tooling (npm, vite, cargo, pytest, tsc) emits SGR codes, and until now
 *    they were shown as literal escape sequences or stripped entirely.
 * 2. Heuristics, for the output that carries no ANSI — which is most of it,
 *    because a process whose stdout is a pipe usually turns colour off. Errors,
 *    warnings, exit lines, URLs and file:line references are recognised by
 *    shape.
 *
 * THE RULE THAT KEEPS THIS FROM BECOMING A CHRISTMAS TREE: colour only where it
 * carries information. Everything unremarkable stays exactly as dim as it was.
 * A log where nine lines in ten are coloured is no more readable than one where
 * none of them are.
 */

/** SGR colour index → a theme token. Bright variants map to the same hue. */
const ANSI_FG: Record<number, string> = {
  30: 'text-text-dim', 31: 'text-red-agent', 32: 'text-green-agent', 33: 'text-amber-agent',
  34: 'text-blue-agent', 35: 'text-violet-agent', 36: 'text-cyan-agent', 37: 'text-text-muted',
  90: 'text-text-dim', 91: 'text-red-agent', 92: 'text-green-agent', 93: 'text-amber-agent',
  94: 'text-blue-agent', 95: 'text-violet-agent', 96: 'text-cyan-agent', 97: 'text-text',
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const ANSI_ANY = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

export function hasAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001b\[[0-9;]*m/.test(text);
}

/** Remove every escape sequence, including cursor moves and OSC titles. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(ANSI_ANY, '');
}

interface Span { text: string; className: string }

/** Split one ANSI-bearing line into styled spans. */
function ansiSpans(line: string): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  let cls = '';
  let bold = false;
  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(line)) !== null) {
    if (m.index > cursor) out.push({ text: line.slice(cursor, m.index), className: `${cls} ${bold ? 'font-semibold' : ''}`.trim() });
    for (const raw of (m[1] || '0').split(';')) {
      const code = Number(raw || 0);
      if (code === 0) { cls = ''; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) cls = '';
      else if (ANSI_FG[code]) cls = ANSI_FG[code];
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < line.length) out.push({ text: line.slice(cursor), className: `${cls} ${bold ? 'font-semibold' : ''}`.trim() });
  return out.map((s) => ({ ...s, text: s.text.replace(ANSI_ANY, '') }));
}

/**
 * What KIND of line is this, when it carries no colour of its own?
 *
 * Deliberately conservative and anchored: matching "error" anywhere in a line
 * paints half a webpack build red. These patterns look at how a line STARTS, or
 * at forms that only ever mean one thing.
 */
export type LineTone = 'error' | 'warn' | 'success' | 'info' | 'muted' | 'plain';

const ERROR_RE = /^\s*(?:error\b|err!|fatal\b|failed\b|failure\b|exception\b|panic:|traceback\b|✗|✘|\bE\/)|is not recognized as an internal or external command|command not found|no such file or directory|permission denied|cannot find module|module not found|EADDRINUSE|ENOENT|\[process exited with code [1-9]/i;
const WARN_RE = /^\s*(?:warn(?:ing)?\b|npm warn\b|deprecat|⚠)/i;
const SUCCESS_RE = /^\s*(?:✓|✔|√|ok\b|done\b|success\b|built in\b|compiled successfully|passed\b|\[process exited with code 0\])/i;
const INFO_RE = /^\s*(?:❯|\$|>|#)\s|^\s*(?:info\b|note:|\[.*?\]\s*$)/i;
const MUTED_RE = /^\s*(?:at\s+\S+\s*\(|\.\.\.|…)/;

export function toneOf(line: string): LineTone {
  if (!line.trim()) return 'plain';
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  if (SUCCESS_RE.test(line)) return 'success';
  if (MUTED_RE.test(line)) return 'muted';
  if (INFO_RE.test(line)) return 'info';
  return 'plain';
}

const TONE_CLASS: Record<LineTone, string> = {
  error: 'text-red-agent',
  warn: 'text-amber-agent',
  success: 'text-green-agent',
  info: 'text-cyan-agent/90',
  muted: 'text-text-dim/60',
  plain: '',
};

/** Inline forms worth pulling out of an otherwise plain line. */
const URL_RE = /(https?:\/\/[^\s'"<>)\]]+)/g;

function withLinks(text: string, key: string): React.ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((part, i) =>
    URL_RE.test(part) && i % 2 === 1
      ? <a key={`${key}-u${i}`} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-agent underline decoration-dotted underline-offset-2">{part}</a>
      : <React.Fragment key={`${key}-t${i}`}>{part}</React.Fragment>,
  );
}

export interface ColorizedLogProps {
  text: string;
  /** Hard cap, so a runaway log cannot lock the tab. */
  maxChars?: number;
  className?: string;
}

/**
 * Render command output with the smallest amount of colour that makes it
 * readable. Falls back to plain text for anything it does not recognise, which
 * is most lines and is the point.
 */
export function ColorizedLog({ text, maxChars = 20_000, className = '' }: ColorizedLogProps) {
  const body = React.useMemo(() => {
    const clipped = text.length > maxChars
      ? `${text.slice(0, maxChars)}\n… ${(text.length - maxChars).toLocaleString()} more characters not shown`
      : text;
    return clipped.split('\n');
  }, [text, maxChars]);

  const ansi = React.useMemo(() => hasAnsi(text), [text]);

  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {body.map((line, i) => {
        if (ansi) {
          const spans = ansiSpans(line);
          // A line the program did not colour still gets the heuristic pass —
          // npm colours its own banners and leaves the error text plain.
          const fallback = spans.every((s) => !s.className) ? TONE_CLASS[toneOf(stripAnsi(line))] : '';
          return (
            <div key={i} className={fallback}>
              {spans.length === 0 ? '​' : spans.map((s, j) => (
                <span key={j} className={s.className}>{withLinks(s.text, `${i}-${j}`)}</span>
              ))}
            </div>
          );
        }
        const tone = toneOf(line);
        return (
          <div key={i} className={TONE_CLASS[tone]}>
            {line ? withLinks(line, String(i)) : '​'}
          </div>
        );
      })}
    </div>
  );
}
