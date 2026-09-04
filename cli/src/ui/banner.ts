import chalk from 'chalk';

/**
 * The thing you see when you type `bubbly`.
 *
 * A banner is not decoration — it is the first and cheapest place to answer
 * "am I in the right tool, pointed at the right project, talking to the right
 * model?". Every serious terminal client prints one for exactly that reason,
 * and the ones that get it wrong do so by printing a beautiful logo and none of
 * the facts.
 *
 * So: the mark, and then the four things a person actually needs before they
 * type anything — where the work happens, which backend, which model, and
 * whether it is going to ask before it does something.
 *
 * IT ADAPTS RATHER THAN WRAPPING. The block letters need 46 columns. Under
 * that, a wrapped ASCII logo is not a smaller logo, it is a mess — so a narrow
 * terminal (a split pane, a phone over SSH, a CI log) gets a single-line mark
 * instead. Colour is dropped automatically by chalk when the output is a pipe.
 */

const BLOCK = [
  '██████  ██    ██ ██████  ██████  ██      ██    ██',
  '██   ██ ██    ██ ██   ██ ██   ██ ██       ██  ██ ',
  '██████  ██    ██ ██████  ██████  ██        ████  ',
  '██   ██ ██    ██ ██   ██ ██   ██ ██         ██   ',
  '██████   ██████  ██████  ██████  ███████    ██   ',
];

/** The 2×2 bubble mark, in the same weight as the letters. */
const MARK = ['●●', '●●'];

export interface BannerFacts {
  version: string;
  workspace: string;
  backendUrl: string;
  /** provider/model, when the backend could tell us. */
  model?: string | null;
  /** 'ask' | 'auto' | 'deny' */
  approvals?: string;
  threadId?: string | null;
}

function width(): number {
  return process.stdout.columns ?? 80;
}

/**
 * A warm gradient across the logo's rows.
 *
 * Uses chalk's 256-colour path, which degrades to plain text on a terminal that
 * cannot do it — so this is never the reason output looks broken somewhere.
 */
const ROW_COLOURS = ['#ffb366', '#ffa04d', '#ff8c33', '#ff7a1f', '#e86a12'];

function paintRow(row: string, i: number): string {
  try {
    return chalk.hex(ROW_COLOURS[Math.min(i, ROW_COLOURS.length - 1)])(row);
  } catch {
    return chalk.yellow(row);
  }
}

function fact(label: string, value: string): string {
  return `  ${chalk.dim(label.padEnd(12))}${value}\n`;
}

/** Shorten a path from the LEFT: the end of a path is the informative half. */
function shortenPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(p.length - (max - 1))}`;
}

export function renderBanner(facts: BannerFacts): string {
  const cols = width();
  let out = '\n';

  if (cols >= 54) {
    for (let i = 0; i < BLOCK.length; i++) {
      const mark = i < MARK.length ? chalk.hex('#ffb366')(MARK[i]) : '  ';
      out += `  ${paintRow(BLOCK[i], i)}  ${mark}\n`;
    }
    out += `  ${chalk.dim(`the terminal client · v${facts.version}`)}\n\n`;
  } else {
    out += `  ${chalk.hex('#ff8c33')('●●')} ${chalk.bold('Bubbly')} ${chalk.dim(`v${facts.version}`)}\n\n`;
  }

  const budget = Math.max(24, cols - 16);
  out += fact('workspace', chalk.white(shortenPath(facts.workspace, budget)));
  out += fact('backend', chalk.dim(facts.backendUrl));
  if (facts.model) out += fact('model', chalk.cyan(facts.model));
  if (facts.approvals) {
    const tone =
      facts.approvals === 'auto' ? chalk.yellow('auto — it will not ask before acting')
      : facts.approvals === 'deny' ? chalk.red('deny — anything needing permission is refused')
      : chalk.green('ask — you approve anything risky');
    out += fact('approvals', tone);
  }
  if (facts.threadId) out += fact('thread', chalk.dim(facts.threadId));

  out += `\n  ${chalk.dim('Type a message, or /help for commands. Ctrl-C stops the agent; Ctrl-D exits.')}\n\n`;
  return out;
}
