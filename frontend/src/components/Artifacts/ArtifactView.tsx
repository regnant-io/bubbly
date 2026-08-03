import React from 'react';
import type { Artifact } from '../../types';
import { MarkdownContent } from '../Shared/MarkdownContent';

/**
 * Render an artifact as the thing it IS.
 *
 * A generated landing page shown as escaped HTML source, or a diagram shown as
 * markup, is a document the user has to mentally compile before they can judge
 * it — which defeats the purpose of the agent producing it. So each kind gets
 * the presentation it was written for, with a source view always one click
 * away for the cases where the markup is the point.
 *
 * HTML renders inside a SANDBOXED iframe with no `allow-same-origin`: the
 * document is model-authored and may contain anything, and it must never be
 * able to reach Bubbly's DOM, storage, or backend. Scripts are allowed so a
 * generated page actually behaves like a page, but the sandbox means they run
 * in an opaque origin with nothing of ours in reach.
 */
export function ArtifactView({ artifact, version, source }: { artifact: Artifact; version?: number; source?: boolean }) {
  const v = version != null
    ? artifact.versions.find((x) => x.version === version)
    : artifact.versions[artifact.versions.length - 1];
  const content = v?.content ?? '';

  if (!content) {
    return <div className="p-4 text-xs text-text-dim">This version is empty.</div>;
  }

  if (source || artifact.kind === 'json') {
    return (
      <pre className="p-3 text-[12px] font-mono whitespace-pre-wrap break-words text-text-muted leading-relaxed">
        {content}
      </pre>
    );
  }

  switch (artifact.kind) {
    case 'markdown':
      return (
        <div className="p-4">
          <MarkdownContent content={content} />
        </div>
      );

    case 'html':
      return (
        <iframe
          title={artifact.title}
          srcDoc={content}
          // No allow-same-origin: model-authored markup gets an opaque origin
          // and cannot touch anything of Bubbly's.
          sandbox="allow-scripts allow-forms allow-popups"
          className="w-full h-full border-0 bg-white"
        />
      );

    case 'svg':
      return (
        <div className="p-4 flex items-start justify-center overflow-auto h-full">
          {/* Same reasoning as HTML: an SVG can carry script, so it renders in
              the sandbox rather than being injected into our document. */}
          <iframe
            title={artifact.title}
            srcDoc={content}
            sandbox="allow-scripts"
            className="w-full h-full border-0"
          />
        </div>
      );

    case 'mermaid':
      // Mermaid isn't bundled, so showing the definition is the honest option —
      // claiming to render a diagram and showing a blank box would be worse.
      return (
        <div className="p-3">
          <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1.5">Mermaid definition</div>
          <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-text-muted leading-relaxed">
            {content}
          </pre>
        </div>
      );

    case 'code':
      // Round-trip through markdown so it picks up the app's existing syntax
      // highlighting rather than growing a second highlighter here.
      return (
        <div className="p-3">
          <MarkdownContent content={'```' + (artifact.language ?? '') + '\n' + content + '\n```'} />
        </div>
      );
  }
}
