import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_WITH_HL = [rehypeHighlight];
const REHYPE_NONE: any[] = [];

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
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={highlight ? REHYPE_WITH_HL : REHYPE_NONE}
        components={LINK_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
