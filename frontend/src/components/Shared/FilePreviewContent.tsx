import React from 'react';
import { File, Loader2, AlertCircle, RefreshCw } from './icons';
import { DiffViewer } from './DiffViewer';
import { useStore, type FilePreview } from '../../store';

/**
 * The file behind a tool call, in the right-hand stack.
 *
 * WHAT THIS USED TO GET WRONG
 *
 * It rendered whatever string the tool call returned and called it the file.
 * That is only true for `read_file`. For a write, an edit, an append or a
 * delete the tool returns a STATUS SENTENCE — "Wrote 42 lines to src/app.ts" —
 * so clicking the file chip right after an edit showed that sentence where the
 * file should have been. The one moment you most want to see the file is the
 * moment after it changed, and that was exactly the moment it wasn't there.
 *
 * Now the panel takes a path and shows three things, in the order they matter:
 * WHAT CHANGED (the diff, when the call changed something), WHAT THE FILE SAYS
 * NOW (fetched fresh, never inferred from the result), and what the call
 * reported. A deleted file has no content to show, so it says so plainly
 * instead of rendering an empty box.
 */
export function FilePreviewContent({
  path, content, type, lineRange, loading, error, diff, summary, tool,
}: FilePreview) {
  const [tab, setTab] = React.useState<'content' | 'diff'>(diff ? 'diff' : 'content');
  const openFilePreview = useStore((s) => s.openFilePreview);

  // A new file arriving resets which tab is showing, since the old choice was
  // about a different file.
  React.useEffect(() => { setTab(diff ? 'diff' : 'content'); }, [path, diff]);

  const fileName = path.split(/[/\\]/).pop() || path;
  const dirPath = path.slice(0, path.length - fileName.length);

  const operation = {
    read: { label: 'Read', color: 'text-blue-agent' },
    create: { label: 'Created', color: 'text-green-agent' },
    write: { label: 'Written', color: 'text-green-agent' },
    edit: { label: 'Edited', color: 'text-amber-agent' },
    delete: { label: 'Deleted', color: 'text-red-agent' },
  }[type] ?? { label: 'Opened', color: 'text-text-muted' };

  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header: what file, what happened to it */}
      <div className="px-3 py-2 border-b border-border bg-surface-2 shrink-0">
        <div className="flex items-center gap-2">
          <File size={14} className="text-text-dim shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1 font-mono text-xs">
              <span className="text-text-dim/60 text-[10px] truncate">{dirPath}</span>
              <span className="text-text font-medium truncate">{fileName}</span>
            </div>
          </div>
          {loading && <Loader2 size={12} className="animate-spin text-text-dim shrink-0" />}
        </div>

        <div className="mt-1 flex items-center gap-2 text-[10px]">
          <span className={operation.color}>{operation.label}</span>
          {tool && <span className="text-text-dim">· {tool}</span>}
          {lineRange && <span className="text-text-dim">· lines {lineRange.start}–{lineRange.end}</span>}
          {!loading && lineCount > 0 && <span className="text-text-dim">· {lineCount.toLocaleString()} lines</span>}
          {diff && (
            <span className="font-mono tabular-nums">
              {diff.additions > 0 && <span className="text-green-agent"> +{diff.additions}</span>}
              {diff.deletions > 0 && <span className="text-red-agent"> −{diff.deletions}</span>}
            </span>
          )}
        </div>

        {/* The tool's own words, kept but subordinated — it is a note about the
            operation, not the file. */}
        {summary && (
          <p className="mt-1 text-[11px] text-text-dim leading-snug line-clamp-2">{summary}</p>
        )}

        {diff && (
          <div className="mt-2 flex items-center gap-1">
            {(['diff', 'content'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                  tab === t
                    ? 'bg-accent/15 text-accent-bright'
                    : 'text-text-dim hover:text-text hover:bg-surface-3'
                }`}
              >
                {t === 'diff' ? 'Change' : 'File now'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'diff' && diff ? (
          <div className="p-2">
            <DiffViewer diffs={[diff]} />
          </div>
        ) : type === 'delete' ? (
          <div className="h-full flex items-center justify-center p-6">
            <p className="text-sm text-text-dim text-center">
              This file was deleted.
              {diff ? ' Its last contents are under “Change”.' : ''}
            </p>
          </div>
        ) : loading ? (
          <div className="p-3 space-y-2" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-3 rounded bg-surface-3/60 animate-pulse"
                style={{ width: `${90 - (i % 4) * 17}%` }}
              />
            ))}
          </div>
        ) : error ? (
          <div className="p-4 flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-agent mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-muted leading-relaxed">{error}</p>
              {/*
                A retry, because the commonest cause is transient — the file was
                mid-write when it was fetched, the backend had just restarted.
                Telling someone their file is gone and giving them nothing to do
                about it turns a two-second problem into a reload of the app.
              */}
              <button
                onClick={() => openFilePreview(path, { type, tool })}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1
                           text-[11px] text-text-muted hover:text-text hover:border-accent/50 hover:bg-surface-3
                           transition-colors"
              >
                <RefreshCw size={11} />
                Try again
              </button>
            </div>
          </div>
        ) : (
          <pre className="p-3 font-mono text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap break-words">
            {content}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-1.5 bg-surface-2 shrink-0 flex items-center gap-3">
        <button
          onClick={() => navigator.clipboard?.writeText(content)}
          className="text-[11px] text-accent-bright hover:underline disabled:opacity-40 disabled:no-underline"
          disabled={!content}
        >
          Copy content
        </button>
        <button
          onClick={() => navigator.clipboard?.writeText(path)}
          className="text-[11px] text-text-dim hover:text-text"
        >
          Copy path
        </button>
      </div>
    </div>
  );
}
