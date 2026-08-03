import React from 'react';
import { Check, Loader2 } from './icons';
import { getToolDisplay } from '../../utils/toolDisplay';
import { useAppContextMenu } from './ContextMenu';

interface ToolIndicatorProps {
  tool: string;
  status: 'preparing' | 'executing' | 'complete';
  duration?: number;
  args?: Record<string, unknown>;
  result?: string;
  /** File changes produced by this call (write/edit/append/delete). */
  diff?: Array<{ path: string; type: string; additions: number; deletions: number }>;
  /** When >1, this represents N consolidated consecutive edits to one file. */
  repeatCount?: number;
  /** 1..9 keyboard-shortcut number for the most recent tool calls. */
  shortcutIndex?: number;
  /** Live stats while the call's arguments are still streaming from the model. */
  progress?: { path?: string; bytes: number; lines: number };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Split a relative path into a dim directory prefix and a bright basename. */
function splitPath(p: string): { dir: string; base: string } {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i === -1) return { dir: '', base: norm };
  return { dir: norm.slice(0, i + 1), base: norm.slice(i + 1) };
}

/** Tools whose primary argument is a file path (shown dir-dimmed). */
const PATH_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'delete_file', 'append_file',
  'get_file_outline', 'read_config', 'write_config',
]);

/** A short, friendly result summary for the line. */
function resultSummary(tool: string, result: string): string | null {
  const r = result.trim();
  if (!r) return null;
  const clean = tool.replace(/^function:/, '');
  if (['search', 'grep_search', 'search_in_files', 'find_files', 'list_directory', 'find_references'].includes(clean)) {
    const lines = r.split('\n').filter((l) => l.trim()).length;
    if (/no (matches|files|results|references)/i.test(r)) return 'no results';
    return `${lines} result${lines === 1 ? '' : 's'}`;
  }
  if (/error|failed|cannot|not found/i.test(r.slice(0, 80))) return 'error';
  return null;
}

/** Parse the read_files stitched output into per-file sections. */
function parseReadFilesBlocks(result: string): Array<{ title: string; body: string }> {
  return result
    .split('\n\n---\n\n')
    .map((section) => {
      const nl = section.indexOf('\n');
      const firstLine = (nl === -1 ? section : section.slice(0, nl)).trim();
      const m = /^#{1,3}\s+(.*)$/.exec(firstLine);
      if (m) return { title: m[1].trim(), body: nl === -1 ? '' : section.slice(nl + 1) };
      return { title: '', body: section };
    })
    .filter((b) => b.title || b.body.trim());
}

/** Output body: plain indented text behind a hairline, not a boxed card. */
function OutputBlock({ label, body, isError }: { label?: string; body: string; isError?: boolean }) {
  return (
    <div className="mt-1 mb-2 ml-1 pl-3 border-l border-border">
      {label && <div className="text-[10px] text-text-dim mb-1 font-mono">{label}</div>}
      <pre className={`text-[12px] font-mono whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed ${isError ? 'text-red-agent/90' : 'text-text-dim'}`}>
        {body.length > 4000 ? body.slice(0, 4000) + '\n…(truncated)' : body}
      </pre>
    </div>
  );
}

/**
 * A tool call, rendered as a LINE OF WORDS rather than a card.
 *
 * Tool calls are punctuation in a conversation, not content. Framing each one in
 * a bordered card with an icon, a colour rail and a status chip gave a
 * `read_file` the same visual weight as the answer it was gathered for — twenty
 * of them turned a transcript into a wall of boxes. So: one quiet line of text.
 * "Read src/index.ts · 42 lines". Colour is used only where it carries
 * information (an error, a diff stat), never as decoration. The line stays
 * clickable to reveal its output, which appears as indented text behind a
 * hairline — subordinate to the call, not another card.
 */
export const ToolIndicator = React.memo(function ToolIndicator({ tool, status, duration, args, result, diff, repeatCount, shortcutIndex, progress }: ToolIndicatorProps) {
  const [expanded, setExpanded] = React.useState(false);
  /**
   * Has the user taken control of this step's disclosure?
   *
   * A step opens itself while it runs — you want to see a build's arguments and
   * a write's growing line count as they happen — and closes itself the moment
   * it finishes, so a settled transcript is a list of one-line outcomes rather
   * than a wall of output. That automation must stop dead the first time the
   * user clicks, or a step they deliberately opened to read would snap shut
   * under them the instant its result landed.
   */
  const userControlled = React.useRef(false);
  const toggle = React.useCallback(() => {
    userControlled.current = true;
    setExpanded((e) => !e);
  }, []);
  const { bind } = useAppContextMenu();
  const display = getToolDisplay(tool, args);
  const done = status === 'complete';
  const verb = done ? display.past : display.gerund;

  const hasDetails = done && !!result && result.length > 0;
  const isReadFiles = /(^|:)read_files$/.test(tool);
  const isError = !!result && /^(error|tool (execution )?failed|cannot|could not)|failed verification/i.test(result.trim());
  const summary = done && result ? resultSummary(tool, result) : null;

  const cleanTool = tool.replace(/^function:/, '');
  // While arguments stream, the real args aren't parsed yet — but the streaming
  // progress already knows the path. Prefer it so the file name appears within
  // a moment of the call starting, not a minute later when it completes.
  const rawPath = (PATH_TOOLS.has(cleanTool) && typeof args?.path === 'string' ? String(args.path) : null)
    ?? (status !== 'complete' ? progress?.path ?? null : null);
  const pathParts = rawPath ? splitPath(rawPath) : null;
  /** Show a live line count only for a call big enough that the wait is felt. */
  const showWriting = status !== 'complete' && !!progress && progress.lines > 3;

  const additions = diff?.reduce((n, d) => n + (d.additions || 0), 0) ?? 0;
  const deletions = diff?.reduce((n, d) => n + (d.deletions || 0), 0) ?? 0;
  const showDiffStats = done && !isError && (additions > 0 || deletions > 0);

  const blocks = isReadFiles && result ? parseReadFilesBlocks(result) : [];

  // A live detail line worth opening for while the step runs: what it is
  // actually doing, drawn from whatever has arrived so far.
  const liveDetail = React.useMemo(() => {
    if (done) return null;
    const a = args ?? {};
    const first = (...keys: string[]) => {
      for (const k of keys) {
        const v = (a as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null;
    };
    return first('command', 'query', 'pattern', 'instruction', 'path', 'url', 'content')
      ?? progress?.path
      ?? null;
  }, [done, args, progress]);

  // The automatic half of the disclosure: open while running, closed once the
  // outcome is a single line. Manual control always wins (see userControlled).
  React.useEffect(() => {
    if (userControlled.current) return;
    setExpanded(!done && !!liveDetail);
  }, [done, liveDetail]);

  return (
    <div className="group my-0.5 animate-fade-in">
      <div
        {...(shortcutIndex ? { 'data-tc-index': shortcutIndex } : {})}
        className={`flex items-baseline gap-1.5 py-0.5 text-[13px] leading-relaxed ${
          hasDetails ? 'cursor-pointer' : ''
        }`}
        onClick={() => { if (hasDetails || liveDetail) toggle(); }}
        role={hasDetails || liveDetail ? 'button' : undefined}
        aria-expanded={hasDetails || liveDetail ? expanded : undefined}
        {...bind(() => [
          ...(result ? [{ label: 'Copy output', onSelect: () => { navigator.clipboard?.writeText(result); } }] : []),
          { label: 'Copy tool name', onSelect: () => { navigator.clipboard?.writeText(cleanTool); } },
          ...(hasDetails || liveDetail ? [{ label: expanded ? 'Collapse' : 'Expand', onSelect: toggle, separatorAfter: true }] : []),
        ])}
      >
        {/* Status: a spinner only while working, a quiet tick when done. The
            tick is the ONLY glyph on a finished line — everything else is text. */}
        <span className="shrink-0 w-3.5 self-center">
          {status === 'executing'
            ? <Loader2 size={11} className="animate-spin text-text-dim" />
            : isError
            ? <span className="text-red-agent text-[11px] font-bold">!</span>
            : <Check size={11} className="text-text-dim/50 group-hover:text-green-agent transition-colors" />}
        </span>

        <span className="flex-1 min-w-0 truncate">
          <span className={`${isError ? 'text-red-agent' : 'text-text-muted'} ${status === 'executing' ? 'shimmer-text' : ''}`}>
            {verb}
          </span>
          {pathParts ? (
            <span className="font-mono text-[12.5px]">
              {' '}
              {pathParts.dir && <span className="text-text-dim/70">{pathParts.dir}</span>}
              <span className="text-text-dim">{pathParts.base}</span>
            </span>
          ) : display.target ? (
            <span className="text-text-dim font-mono text-[12.5px]"> {display.target}</span>
          ) : null}
          {status === 'executing' && !showWriting && <span className="text-text-dim">…</span>}

          {/* The live writing counter. This is the whole point: a 700-line file
              used to sit on a motionless spinner for a minute. Now the line
              count climbs as the model emits the file, so the wait is legibly
              progress rather than a hang. */}
          {showWriting && (
            <span className="text-accent-bright/80 tabular-nums"> · {progress!.lines.toLocaleString()} lines<span className="text-text-dim">…</span></span>
          )}

          {repeatCount && repeatCount > 1 && <span className="text-text-dim/70"> · {repeatCount} edits</span>}
          {summary && <span className={isError ? 'text-red-agent/80' : 'text-text-dim/70'}> · {summary}</span>}
          {showDiffStats && (
            <span className="font-mono tabular-nums">
              {additions > 0 && <span className="text-green-agent/80"> +{additions}</span>}
              {deletions > 0 && <span className="text-red-agent/80"> −{deletions}</span>}
            </span>
          )}
          {/* Duration and the expand hint stay on the line, revealed on hover so
              a settled transcript reads as clean prose. */}
          {done && duration !== undefined && duration >= 0 && (
            <span className="text-text-dim/50 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity"> · {formatDuration(duration)}</span>
          )}
          {hasDetails && (
            <span className="text-text-dim/50 opacity-0 group-hover:opacity-100 transition-opacity"> · {expanded ? 'hide' : 'show'}</span>
          )}
          {shortcutIndex && (
            <span className="text-text-dim/40 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity" title={`Press ${shortcutIndex}`}> [{shortcutIndex}]</span>
          )}
        </span>
      </div>

      {expanded && result && (
        blocks.length > 1
          ? <div className="space-y-1">{blocks.map((b, i) => <OutputBlock key={i} label={b.title || `file ${i + 1}`} body={b.body} />)}</div>
          : <OutputBlock body={result} isError={isError} />
      )}

      {/* What the step is doing, while it's doing it. Replaced by the result
          (and folded away) the moment it completes. */}
      {expanded && !result && liveDetail && (
        <OutputBlock label="running" body={liveDetail} />
      )}
    </div>
  );
});
