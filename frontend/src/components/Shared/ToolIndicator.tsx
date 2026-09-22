import React from 'react';
import {
  FileText, Pencil, FilePlus, Trash2, Terminal, Search, FolderTree, GitBranch, GitCommit,
  ClipboardList, Layers, Map as MapIcon, Hash, ListTree, ShieldCheck, SlidersHorizontal,
  Globe, Wrench, ChevronRight, X, Clock,
} from './icons';
import type { LucideIcon } from 'lucide-react';
import { getToolDisplay, type ToolIconName } from '../../utils/toolDisplay';
import { useAppContextMenu } from './ContextMenu';
import { useStore } from '../../store';
import { ColorizedLog } from '../../utils/logColor';
import { DiffViewer } from './DiffViewer';
import type { FileDiff } from '../../types';

interface ToolIndicatorProps {
  tool: string;
  status: 'preparing' | 'executing' | 'complete';
  duration?: number;
  args?: Record<string, unknown>;
  result?: string;
  /** File changes produced by this call (write/edit/append/delete). */
  diff?: Array<{ path: string; type: string; additions: number; deletions: number; diff?: string }>;
  /** When >1, this represents N consolidated consecutive edits to one file. */
  repeatCount?: number;
  /** 1..9 keyboard-shortcut number for the most recent tool calls. */
  shortcutIndex?: number;
  /** Live stats while the call's arguments are still streaming from the model. */
  progress?: { path?: string; bytes: number; lines: number };
  /** The live output of a command this step is running (see MessageList). */
  live?: { output: Array<{ stream: 'stdout' | 'stderr'; content: string }>; exitCode?: number };
}

/** The same test the transcript uses to count failures — keep them in step. */
export const TOOL_ERROR_RE = /^(error|tool (execution )?failed|cannot|could not)|failed verification/i;

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Split a relative path into a dim directory prefix and a bright basename. */
function splitPath(p: string): { dir: string; base: string } {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i === -1) return { dir: '', base: norm };
  return { dir: norm.slice(0, i + 1), base: norm.slice(i + 1) };
}

/** Tools whose primary argument is a file path (shown as an openable file). */
const PATH_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'delete_file', 'append_file',
  'get_file_outline', 'read_config', 'write_config',
]);
const COMMAND_TOOLS = new Set(['run_command', 'run_background']);

/**
 * One glyph per KIND of work, drawn in a single ink.
 *
 * The old line had a colour per tool (blue reads, green writes, amber commands,
 * violet git …), which turned a busy burst into confetti and made the one
 * colour that matters — red, for a failure — just another colour. Kinds are
 * told apart by shape; colour is kept for state.
 */
const GLYPH: Record<ToolIconName, LucideIcon> = {
  read: FileText,
  write: FilePlus,
  edit: Pencil,
  delete: Trash2,
  list: FolderTree,
  tree: FolderTree,
  search: Search,
  terminal: Terminal,
  git: GitBranch,
  commit: GitCommit,
  spec: ClipboardList,
  context: Layers,
  map: MapIcon,
  symbol: Hash,
  references: Hash,
  outline: ListTree,
  validate: ShieldCheck,
  config: SlidersHorizontal,
  browser: Globe,
  generic: Wrench,
};

export function ToolGlyph({ tool, args, size = 13 }: { tool: string; args?: Record<string, unknown>; size?: number }) {
  const clean = tool.replace(/^function:/, '');
  const Icon = clean === 'watch' ? Clock : GLYPH[getToolDisplay(tool, args).icon] ?? Wrench;
  return <Icon size={size} strokeWidth={1.75} />;
}

/** A short, factual result summary for the line: counts, never adjectives. */
function resultSummary(tool: string, result: string): string | null {
  const r = result.trim();
  if (!r) return null;
  const clean = tool.replace(/^function:/, '');
  if (['search', 'grep_search', 'search_in_files', 'find_files', 'list_directory', 'find_references'].includes(clean)) {
    if (/no (matches|files|results|references)/i.test(r)) return 'no results';
    const lines = r.split('\n').filter((l) => l.trim()).length;
    return `${lines} result${lines === 1 ? '' : 's'}`;
  }
  if (clean === 'read_file') {
    const lines = r.split('\n').length;
    return lines > 1 ? `${lines.toLocaleString()} lines` : null;
  }
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

/**
 * The expanded body: a recessed console, not another card.
 *
 * Output goes through the log colouriser because a shell result is a LOG — a
 * failure message, an exit line, a URL a dev server printed — and one flat grey
 * made "'.' is not recognized" look exactly like a successful build.
 */
function Console({ prompt, body, label, isError }: { prompt?: string; body?: string; label?: string; isError?: boolean }) {
  return (
    <div className={`tl-console ${isError ? 'tl-console--error' : ''}`}>
      {label && <div className="tl-console-label">{label}</div>}
      {prompt && <div className="tl-console-prompt"><span aria-hidden="true">$</span> {prompt}</div>}
      {body && body.trim() && <ColorizedLog text={body} maxChars={6000} />}
    </div>
  );
}

/**
 * ONE STEP OF AGENT WORK — ONE LINE.
 *
 *   [glyph]  Edited  src/app/App.tsx  +12 −3                      1.2s  ›
 *
 * The glyph sits on the trail's rail (see ToolStepGroup); the verb says what
 * happened in the tense you are reading it in; the target is the thing it
 * happened to, and a file target opens the file. Everything else — duration,
 * the disclosure caret, the shortcut number — waits for hover, so a settled
 * transcript reads as a column of plain sentences.
 *
 * The step opens on click to show what it produced: a diff for a change, a
 * console for a command, the matches for a search. A running step with
 * something worth watching (a command, a long write) opens by itself and closes
 * when it lands — until the user touches it, after which it is theirs.
 */
export const ToolIndicator = React.memo(function ToolIndicator({ tool, status, duration, args, result, diff, repeatCount, shortcutIndex, progress, live }: ToolIndicatorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const userControlled = React.useRef(false);
  const toggle = React.useCallback(() => {
    userControlled.current = true;
    setExpanded((e) => !e);
  }, []);
  const { bind } = useAppContextMenu();
  const openFilePreview = useStore((s) => s.openFilePreview);

  const cleanTool = tool.replace(/^function:/, '');
  const display = getToolDisplay(tool, args);
  const done = status === 'complete';
  const verb = done ? display.past : display.gerund;
  const isError = done && !!result && TOOL_ERROR_RE.test(result.trim());
  const summary = done && result && !isError ? resultSummary(tool, result) : null;
  const isCommand = COMMAND_TOOLS.has(cleanTool);
  const command = isCommand && typeof args?.command === 'string' ? args.command : null;

  // While arguments stream, the parsed args are not there yet but the progress
  // already knows the path — so the file name shows within a moment of the call.
  const rawPath = (PATH_TOOLS.has(cleanTool) && typeof args?.path === 'string' ? String(args.path) : null)
    ?? (!done ? progress?.path ?? null : null);
  const pathParts = rawPath ? splitPath(rawPath) : null;

  const diffs = (diff ?? []).filter((d) => typeof d.diff === 'string' && d.diff.length > 0) as FileDiff[];
  const additions = diff?.reduce((n, d) => n + (d.additions || 0), 0) ?? 0;
  const deletions = diff?.reduce((n, d) => n + (d.deletions || 0), 0) ?? 0;
  const showDiffStats = done && !isError && (additions > 0 || deletions > 0);
  const showWriting = !done && !!progress && progress.lines > 3;

  const hasBody = done ? (diffs.length > 0 || !!result?.trim() || !!command) : !!command;

  /**
   * Open the file this call touched — its CURRENT content, with this call's
   * diff alongside. The tool result is only the file for a read; for a write it
   * is a status sentence, which is what clicking used to show instead.
   */
  const openFile = React.useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (!rawPath) return;
    const type: 'read' | 'write' | 'edit' | 'delete' =
      cleanTool.includes('delete') ? 'delete'
      : cleanTool === 'write_file' ? 'write'
      : cleanTool.includes('edit') || cleanTool.includes('append') ? 'edit'
      : 'read';
    openFilePreview(rawPath, {
      type,
      tool: cleanTool,
      diff: diff?.find((d) => d.path === rawPath) as never,
      summary: type === 'read' ? undefined : (result ?? '').split('\n')[0]?.trim() || undefined,
    });
  }, [rawPath, cleanTool, diff, result, openFilePreview]);

  // Automatic disclosure: a running command shows its console; everything
  // folds once it has landed. Manual control always wins.
  React.useEffect(() => {
    if (userControlled.current) return;
    setExpanded(!done && isCommand);
  }, [done, isCommand]);

  const blocks = /(^|:)read_files$/.test(tool) && result ? parseReadFilesBlocks(result) : [];
  // While the command runs, its console is the live stream; once it lands,
  // the recorded result (which is what a reloaded thread has) takes over.
  const liveText = live ? live.output.map((o) => o.content).join('') : '';
  const exitCode = live?.exitCode;
  const errorLine = isError ? result!.trim().split('\n')[0].replace(/^error:\s*/i, '') : null;

  return (
    <div
      className={`tl-step motion-rise ${!done ? 'is-running' : ''} ${isError ? 'is-error' : ''} ${expanded ? 'is-open' : ''}`}
    >
      <div
        {...(shortcutIndex ? { 'data-tc-index': shortcutIndex } : {})}
        className={`tl-row ${hasBody ? 'is-interactive' : ''}`}
        onClick={hasBody ? toggle : undefined}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? expanded : undefined}
        onKeyDown={(e) => { if (hasBody && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } }}
        {...bind(() => [
          ...(result ? [{ label: 'Copy output', onSelect: () => { navigator.clipboard?.writeText(result); } }] : []),
          ...(command ? [{ label: 'Copy command', onSelect: () => { navigator.clipboard?.writeText(command); } }] : []),
          ...(rawPath ? [{ label: 'Open file', onSelect: () => openFile({ stopPropagation() {} } as React.SyntheticEvent) }] : []),
          ...(hasBody ? [{ label: expanded ? 'Collapse' : 'Expand', onSelect: toggle }] : []),
        ])}
      >
        <span className="tl-glyph" aria-hidden="true">
          {isError ? <X size={12} strokeWidth={2.25} /> : <ToolGlyph tool={tool} args={args} />}
        </span>

        <span className="tl-line">
          <span className={`tl-verb ${!done ? 'sheen-text' : ''}`}>{verb}</span>
          {pathParts ? (
            <span
              className={`tl-target tl-file ${done ? 'is-link' : ''}`}
              onClick={done ? openFile : undefined}
              onKeyDown={done ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(e); } } : undefined}
              role={done ? 'link' : undefined}
              tabIndex={done ? 0 : undefined}
              title={rawPath ?? undefined}
            >
              {pathParts.dir && <span className="tl-file-dir">{pathParts.dir}</span>}
              <span className="tl-file-base">{pathParts.base}</span>
            </span>
          ) : display.target ? (
            <span className={`tl-target ${isCommand ? 'tl-code' : ''}`} title={isCommand ? command ?? undefined : undefined}>
              {display.target}
            </span>
          ) : null}

          {showWriting && (
            <span className="tl-meta tabular-nums">{progress!.lines.toLocaleString()} lines</span>
          )}
          {repeatCount && repeatCount > 1 && <span className="tl-meta">{repeatCount} edits</span>}
          {summary && <span className="tl-meta">{summary}</span>}
          {showDiffStats && (
            <span className="tl-diffstat">
              {additions > 0 && <span className="is-add">+{additions}</span>}
              {deletions > 0 && <span className="is-del">−{deletions}</span>}
            </span>
          )}
          {errorLine && <span className="tl-error-line" title={result}>{errorLine}</span>}
          {!errorLine && exitCode !== undefined && exitCode !== 0 && (
            <span className="tl-error-line">exit {exitCode}</span>
          )}
        </span>

        <span className="tl-aside">
          {shortcutIndex && <kbd title={`Press ${shortcutIndex} to toggle`}>{shortcutIndex}</kbd>}
          {done && duration !== undefined && duration >= 0 && <span className="tabular-nums">{formatDuration(duration)}</span>}
          {hasBody && <ChevronRight size={12} className="tl-caret" />}
        </span>
      </div>

      {expanded && (
        <div className="tl-body motion-appear">
          {diffs.length > 0 && !isError ? (
            <div className="tl-diff"><DiffViewer diffs={diffs} compact /></div>
          ) : blocks.length > 1 ? (
            blocks.map((b, i) => <Console key={i} label={b.title || `file ${i + 1}`} body={b.body} />)
          ) : (
            <Console
              prompt={command ?? undefined}
              body={done ? (result || liveText) : liveText}
              isError={isError || (exitCode !== undefined && exitCode !== 0)}
            />
          )}
        </div>
      )}
    </div>
  );
});
