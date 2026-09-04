import chalk from 'chalk';

/**
 * Markdown, rendered for a terminal.
 *
 * WHY THIS IS HAND-WRITTEN
 *
 * The obvious move is `marked` + `marked-terminal`. Both are ESM-only as of
 * their current majors, and this CLI is CommonJS and declares Node 18 — so
 * pulling them in trades a rendering problem for a "cannot use import statement
 * outside a module" crash on the exact machines least able to debug it. The
 * subset of markdown a coding agent actually emits is small and completely
 * stable, so rendering it directly costs about a hundred lines and no
 * dependency risk at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No reflow. Re-wrapping paragraphs to the terminal width fights the terminal's
 * own wrapping, breaks when the window is resized after the fact, and destroys
 * copy-paste of anything that mattered. The terminal wraps; this only styles.
 *
 * No colour when the output is not a TTY. chalk handles that itself, so piping
 * a run into a file gives clean plain text rather than escape soup.
 */

const BULLET = '•';

/** Inline spans: code, bold, italic, links, strikethrough. Order matters. */
function inline(text: string): string {
  return text
    // `code` first: everything inside it must survive verbatim.
    .replace(/`([^`\n]+)`/g, (_m, code) => chalk.cyan(code))
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, (_m, t) => chalk.bold.italic(t))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => chalk.bold(t))
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_m, t) => chalk.italic(t))
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_m, t) => chalk.italic(t))
    .replace(/~~([^~\n]+)~~/g, (_m, t) => chalk.strikethrough(t))
    // [label](url) — the label is what a reader wants; the URL follows dimmed
    // so it stays copyable, which is the entire reason it is there.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) => `${chalk.underline(label)} ${chalk.dim(`(${url})`)}`)
    // A bare URL is a link too, and terminals make those clickable themselves.
    .replace(/(^|\s)(https?:\/\/[^\s)]+)/g, (_m, pre, url) => `${pre}${chalk.blue.underline(url)}`);
}

/** A fenced code block, indented and tinted so it reads as a separate thing. */
function codeBlock(lines: string[], language: string): string {
  const head = language ? chalk.dim(`  ┌─ ${language}`) : chalk.dim('  ┌─');
  const body = lines.map((l) => `  ${chalk.dim('│')} ${chalk.cyan(l)}`).join('\n');
  return `${head}\n${body}\n${chalk.dim('  └─')}`;
}

/**
 * Render a markdown string for the terminal.
 *
 * Written as a single pass over the lines rather than a parse tree: the input
 * is a chat message, not a document, and a line-oriented renderer is far easier
 * to reason about when the input is half-finished — which, during streaming, it
 * always is.
 */
export function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];

  let inFence = false;
  let fenceLanguage = '';
  let fenceLines: string[] = [];
  /** Nesting depth for ordered-list numbering, keyed by indent. */
  const counters = new Map<number, number>();

  for (const raw of lines) {
    // --- fenced code -----------------------------------------------------
    const fence = /^\s*```(.*)$/.exec(raw);
    if (fence) {
      if (inFence) {
        out.push(codeBlock(fenceLines, fenceLanguage));
        inFence = false;
        fenceLines = [];
        fenceLanguage = '';
      } else {
        inFence = true;
        fenceLanguage = fence[1].trim();
      }
      continue;
    }
    if (inFence) { fenceLines.push(raw); continue; }

    // --- horizontal rule ---------------------------------------------------
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(raw)) {
      const w = Math.min((process.stdout.columns ?? 80) - 4, 60);
      out.push(chalk.dim('  ' + '─'.repeat(Math.max(w, 8))));
      continue;
    }

    // --- headings ---------------------------------------------------------
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const text = inline(heading[2].trim());
      out.push('');
      if (level === 1) out.push(chalk.bold.underline(text));
      else if (level === 2) out.push(chalk.bold(text));
      else out.push(chalk.bold.dim(text));
      counters.clear();
      continue;
    }

    // --- blockquote -------------------------------------------------------
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(`${chalk.dim('  ▏')} ${chalk.dim(inline(quote[1]))}`);
      continue;
    }

    // --- task / bullet / ordered lists -------------------------------------
    const task = /^(\s*)[-*+]\s+\[([ xX~!])\]\s+(.*)$/.exec(raw);
    if (task) {
      const indent = ' '.repeat(task[1].length + 2);
      const state = task[2].toLowerCase();
      const mark =
        state === 'x' ? chalk.green('✓')
        : state === '~' ? chalk.cyan('▸')
        : state === '!' ? chalk.yellow('!')
        : chalk.dim('○');
      const body = state === 'x' ? chalk.dim(inline(task[3])) : inline(task[3]);
      out.push(`${indent}${mark} ${body}`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = ' '.repeat(bullet[1].length + 2);
      out.push(`${indent}${chalk.dim(BULLET)} ${inline(bullet[2])}`);
      continue;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    if (ordered) {
      const depth = ordered[1].length;
      const n = counters.get(depth) ?? Number(ordered[2]) - 1;
      counters.set(depth, n + 1);
      const indent = ' '.repeat(depth + 2);
      out.push(`${indent}${chalk.dim(`${n + 1}.`)} ${inline(ordered[3])}`);
      continue;
    }

    // A blank line resets ordered-list numbering — two separate lists that both
    // start at 1 should both start at 1.
    if (!raw.trim()) { counters.clear(); out.push(''); continue; }

    // --- table rows -------------------------------------------------------
    // Just enough to keep a table legible: the separator row is dropped and the
    // pipes are dimmed. Real column alignment would need a second pass over the
    // whole block, which is not worth it for the tables an agent emits.
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
      out.push(`  ${raw.trim().split('|').map((cell, i, arr) =>
        i === 0 || i === arr.length - 1 ? '' : inline(cell.trim()),
      ).filter(Boolean).join(chalk.dim(' │ '))}`);
      continue;
    }

    out.push(inline(raw));
  }

  // An unterminated fence is the normal state mid-stream, not an error.
  if (inFence && fenceLines.length > 0) out.push(codeBlock(fenceLines, fenceLanguage));

  return out.join('\n');
}

/**
 * Is this text worth running through the renderer at all?
 *
 * A one-line answer with no markup renders identically either way, and skipping
 * the pass keeps plain prose byte-for-byte what the model wrote.
 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```)|\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/.test(text);
}

/**
 * The same renderer, driven a chunk at a time.
 *
 * THE PROBLEM WITH RENDERING A STREAM
 *
 * A terminal is append-only. Once a line has scrolled past it cannot be
 * restyled, so you cannot print raw text as it arrives and "apply markdown at
 * the end" — the choice has to be made before each line is committed. Waiting
 * for the whole message instead makes the CLI feel dead for the ten seconds a
 * long answer takes, which is the thing streaming exists to prevent.
 *
 * The resolution is that markdown is almost entirely LINE-ORIENTED. A heading,
 * a bullet, a quote and a table row are decided by the line they are on; only
 * fenced code needs memory, and only of one bit. So this holds a partial line,
 * emits each one styled the moment its newline arrives, and carries the fence
 * state across. What the reader sees is a live stream that happens to already
 * be formatted.
 */
export class MarkdownLineStream {
  private pending = '';
  private inFence = false;
  private fenceLanguage = '';

  /** Feed a chunk; returns the text to print (possibly empty). */
  push(chunk: string): string {
    this.pending += chunk;
    const nl = this.pending.lastIndexOf('\n');
    if (nl === -1) return '';
    const complete = this.pending.slice(0, nl);
    this.pending = this.pending.slice(nl + 1);
    return complete.split('\n').map((l) => `${this.line(l)}\n`).join('');
  }

  /** Emit whatever is left, at the end of a message. */
  flush(): string {
    if (!this.pending) return '';
    const rest = this.line(this.pending);
    this.pending = '';
    return rest;
  }

  /** True when nothing is buffered — used to decide whether a newline is due. */
  get empty(): boolean { return this.pending.length === 0; }

  private line(raw: string): string {
    const fence = /^\s*```(.*)$/.exec(raw);
    if (fence) {
      if (this.inFence) {
        this.inFence = false;
        this.fenceLanguage = '';
        return chalk.dim('  └─');
      }
      this.inFence = true;
      this.fenceLanguage = fence[1].trim();
      return this.fenceLanguage ? chalk.dim(`  ┌─ ${this.fenceLanguage}`) : chalk.dim('  ┌─');
    }
    if (this.inFence) return `  ${chalk.dim('│')} ${chalk.cyan(raw)}`;
    // Everything else is a single line through the block renderer, which
    // handles headings, lists, quotes, rules and inline spans identically to
    // the non-streaming path — the two cannot drift because it IS the same code.
    return renderMarkdown(raw);
  }
}
