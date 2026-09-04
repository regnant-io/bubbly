import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownContentProps {
  content: string;
  className?: string;
  /**
   * Run syntax highlighting (highlight.js). Highlighting is by far the most
   * expensive part of rendering markdown, so callers pass `false` while a
   * message is still STREAMING — re-highlighting a growing code block on every
   * token is O(n²) and is the main cause of streaming lag. The final render
   * (streaming done) highlights once.
   */
  highlight?: boolean;
}

const LINK_COMPONENTS = {
  // Open links in a new tab.
  a({ children, href, ...props }: any) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

/* -------------------------------------------------------------------------- *
 * MATHS
 *
 * Models write LaTeX. Not because a coding conversation needs it, but because
 * they have read a great deal of it: "$\rightarrow$" turns up in the middle of
 * an explanation of a data flow, and before this it rendered as the literal
 * seven characters `$\rightarrow$` — the same wrong output in every single
 * generation, which is exactly the kind of thing that makes an app feel unfinished.
 *
 * WHY THE PLUGINS ARE CONDITIONAL
 *
 * The obvious fix is to switch remark-math on permanently. That trades one bug
 * for a worse one: with single-dollar maths enabled, "it costs $5 rather than
 * $10" is a valid maths span, and the sentence renders as "it costs 5rather
 * than10". Prices, shell variables and awk one-liners all contain lone dollars,
 * and a coding tool sees far more of those than it sees equations.
 *
 * So maths is enabled per message, and only when the text contains something
 * that is unambiguously LaTeX: a display block, or a `$…$` span with an actual
 * backslash-command inside it. `$5` and `$10` contain neither, so they are left
 * alone; `$\rightarrow$` is caught on the first test.
 *
 * The system prompt separately asks the model to write → rather than
 * $\rightarrow$ in the first place. This is the safety net for when it doesn't,
 * which — models being models — is often.
 * -------------------------------------------------------------------------- */

const MATH_HINT =
  /\$\$[\s\S]+?\$\$|\$[^\s$][^$\n]*\\[a-zA-Z]+[^$\n]*\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/;

/**
 * Normalise the delimiters remark-math does not know about.
 *
 * `\( … \)` and `\[ … \]` are as common in model output as `$…$` and are not
 * recognised by remark-math, so they would fall through to the page as literal
 * backslashes. Rewriting them to dollar form is a pure delimiter swap — the
 * maths inside is untouched.
 *
 * Fenced code is protected: a code block containing `\(` is a regex, not an
 * equation, and rewriting it would corrupt the code being discussed.
 */
function normaliseMathDelimiters(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // the captured code spans
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`);
    })
    .join('');
}

const KATEX_OPTIONS = {
  // A malformed expression must never take the message down with it. KaTeX
  // renders what it can and leaves the rest as visible red source, which is
  // both honest and debuggable.
  throwOnError: false,
  errorColor: 'var(--error)',
  strict: false as const,
  // Long derivations are not what this is for; wrapping keeps a stray display
  // block from forcing the whole transcript to scroll sideways.
  output: 'htmlAndMathml' as const,
};

/* -------------------------------------------------------------------------- *
 * KATEX IS LOADED ON DEMAND.
 *
 * The renderer plus its stylesheet and font files are roughly a quarter of a
 * megabyte, and the overwhelming majority of messages in a coding conversation
 * contain no mathematics at all. Bundling it eagerly makes every user pay, at
 * first paint, for a feature most of them will never trigger.
 *
 * So the import happens the first time a message actually contains LaTeX. Until
 * it resolves the message renders without maths — a fraction of a second in
 * which the source is visible, which is exactly what was shown before this
 * feature existed and is a great deal better than an empty bubble. Once loaded
 * it is cached for the session, so only the first such message ever waits.
 * -------------------------------------------------------------------------- */
let katexPlugin: unknown | null = null;
let katexLoading: Promise<void> | null = null;
/** Bumped when KaTeX finishes loading, to re-render the messages waiting on it. */
const katexListeners = new Set<() => void>();

function loadKatex(): void {
  if (katexPlugin || katexLoading) return;
  katexLoading = Promise.all([
    import('rehype-katex'),
    // @ts-expect-error — a CSS side-effect import has no type
    import('katex/dist/katex.min.css'),
  ])
    .then(([mod]) => {
      katexPlugin = mod.default;
      for (const fn of katexListeners) fn();
    })
    .catch(() => {
      // A failed chunk load must not break the message. The source stays
      // visible, which is what it looked like before maths was supported.
    })
    .finally(() => { katexLoading = null; });
}

/** Re-render this component once KaTeX is available. */
function useKatex(enabled: boolean): unknown | null {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!enabled || katexPlugin) return;
    loadKatex();
    katexListeners.add(force);
    return () => { katexListeners.delete(force); };
  }, [enabled]);
  return enabled ? katexPlugin : null;
}

const REMARK_BASE = [remarkGfm];
const REMARK_WITH_MATH = [remarkGfm, remarkMath];
const REHYPE_NONE: any[] = [];
const REHYPE_HL: any[] = [rehypeHighlight];

/**
 * Renders GitHub-flavored markdown with optional syntax highlighting.
 *
 * Memoized: identical `content` (and `highlight`) skips a full markdown re-parse
 * + re-highlight. This matters enormously during streaming — without it, every
 * token re-parses/re-highlights EVERY message in the transcript, which is what
 * makes long sessions progressively lag.
 */
export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  className = '',
  highlight = true,
}: MarkdownContentProps) {
  const hasMath = React.useMemo(() => MATH_HINT.test(content), [content]);
  const body = React.useMemo(
    () => (hasMath ? normaliseMathDelimiters(content) : content),
    [content, hasMath],
  );

  const katex = useKatex(hasMath);

  const rehype = React.useMemo<any[]>(() => {
    const plugins: any[] = highlight ? [rehypeHighlight] : [];
    if (katex) plugins.push([katex, KATEX_OPTIONS]);
    if (plugins.length === 0) return REHYPE_NONE;
    if (plugins.length === 1 && highlight) return REHYPE_HL;
    return plugins;
  }, [highlight, katex]);

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={hasMath && katex ? REMARK_WITH_MATH : REMARK_BASE}
        rehypePlugins={rehype}
        components={LINK_COMPONENTS}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});
