import React from 'react';
import {
  FileCode, FilePlus, Trash2, Folder, Terminal, GitBranch, GitCommit,
  Search, ListTree, Settings, ClipboardList, File, Map, Network,
  FileText, Hash, Check, Loader2, Bug, Monitor, ChevronRight,
} from './icons';
import { getToolDisplay, type ToolIconName } from '../../utils/toolDisplay';
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
  /** 1..9 keyboard-shortcut number for the most recent tool calls (badge). */
  shortcutIndex?: number;
}

function iconFor(name: ToolIconName, size = 15): React.ReactNode {
  switch (name) {
    case 'read': return <FileText size={size} />;
    case 'write': return <FilePlus size={size} />;
    case 'edit': return <FileCode size={size} />;
    case 'delete': return <Trash2 size={size} />;
    case 'list': return <Folder size={size} />;
    case 'tree': return <ListTree size={size} />;
    case 'search': return <Search size={size} />;
    case 'terminal': return <Terminal size={size} />;
    case 'git': return <GitBranch size={size} />;
    case 'commit': return <GitCommit size={size} />;
    case 'spec': return <ClipboardList size={size} />;
    case 'context': return <Network size={size} />;
    case 'map': return <Map size={size} />;
    case 'symbol': return <Hash size={size} />;
    case 'references': return <Network size={size} />;
    case 'outline': return <ListTree size={size} />;
    case 'validate': return <Bug size={size} />;
    case 'config': return <Settings size={size} />;
    case 'browser': return <Monitor size={size} />;
    default: return <File size={size} />;
  }
}

/**
 * Left accent rail per tool category. Static literal classes (not derived from
 * display.color at runtime) so Tailwind's scanner keeps them in the build.
 */
const RAIL: Record<string, string> = {
  'text-blue-agent': 'bg-blue-agent/50',
  'text-green-agent': 'bg-green-agent/50',
  'text-red-agent': 'bg-red-agent/50',
  'text-amber-agent': 'bg-amber-agent/50',
  'text-violet-agent': 'bg-violet-agent/50',
  'text-cyan-agent': 'bg-cyan-agent/50',
  'text-orange-agent': 'bg-orange-agent/50',
  'text-brown-agent': 'bg-brown-agent/50',
  'text-accent-bright': 'bg-accent/50',
  'text-text-muted': 'bg-border',
};

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

/** A short, friendly result summary line for the collapsed header. */
function resultSummary(tool: string, result: string): string | null {
  const r = result.trim();
  if (!r) return null;
  const clean = tool.replace(/^function:/, '');
  // For searches / lists, show how many lines came back.
  if (['grep_search', 'search_in_files', 'find_files', 'list_directory', 'find_references'].includes(clean)) {
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
      if (m) {
        return { title: m[1].trim(), body: nl === -1 ? '' : section.slice(nl + 1) };
      }
      return { title: '', body: section };
    })
    .filter((b) => b.title || b.body.trim());
}

/** Render read_files output as separate titled rectangles, one per file. */
function ReadFilesBlocks({ result }: { result: string }) {
  const blocks = parseReadFilesBlocks(result);
  if (blocks.length <= 1) return null;
  return (
    <div className="ml-3.5 mr-2 mt-0.5 mb-1.5 space-y-1.5">
      {blocks.map((b, i) => (
        <div key={i} className="rounded-lg bg-surface-1 border border-border overflow-hidden">
          <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-border bg-surface-2">
            <FileText size={11} className="text-blue-agent shrink-0" />
            <span className="text-[11px] font-mono text-text-muted truncate">{b.title || `file ${i + 1}`}</span>
          </div>
          <pre className="text-[12px] font-mono whitespace-pre-wrap max-h-56 overflow-y-auto p-2.5 leading-relaxed text-text-muted">
            {b.body.length > 4000 ? b.body.slice(0, 4000) + '\n…(truncated)' : b.body}
          </pre>
        </div>
      ))}
    </div>
  );
}

export const ToolIndicator = React.memo(function ToolIndicator({ tool, status, duration, args, result, diff, repeatCount, shortcutIndex }: ToolIndicatorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const { bind } = useAppContextMenu();
  const display = getToolDisplay(tool, args);
  const done = status === 'complete';
  const verb = done ? display.past : display.gerund;

  const hasDetails = done && result && result.length > 0;
  const isReadFiles = /(^|:)read_files$/.test(tool);
  const isError = !!result && /^(error|tool (execution )?failed|cannot|could not)|failed verification/i.test(result.trim());
  const summary = done && result ? resultSummary(tool, result) : null;
  const rail = isError ? 'bg-red-agent/60' : (RAIL[display.color] ?? 'bg-border');

  // Dim-directory / bright-basename rendering for file tools.
  const cleanTool = tool.replace(/^function:/, '');
  const rawPath = PATH_TOOLS.has(cleanTool) && typeof args?.path === 'string' ? String(args.path) : null;
  const pathParts = rawPath ? splitPath(rawPath) : null;

  // Net line changes for file-mutating calls: "+12 −3" chips like a real IDE.
  const additions = diff?.reduce((n, d) => n + (d.additions || 0), 0) ?? 0;
  const deletions = diff?.reduce((n, d) => n + (d.deletions || 0), 0) ?? 0;
  const showDiffStats = done && !isError && (additions > 0 || deletions > 0);

  const outputLines = result ? result.split('\n').length : 0;

  const copyResult = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!result) return;
    navigator.clipboard?.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore */ });
  };

  return (
    // The category spine lives on the GROUP, not the header row, so when a call
    // is expanded the rail runs the full height and visually binds the call to
    // its output. Previously the output was an indented box floating with no
    // connection to the call that produced it.
    <div className="group relative my-1 animate-fade-in">
      <span
        className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-full ${rail} ${
          status === 'executing' ? 'animate-pulse-slow' : ''
        }`}
      />
      <div
        {...(shortcutIndex ? { 'data-tc-index': shortcutIndex } : {})}
        className={`relative flex items-center gap-2.5 py-1.5 pl-3.5 pr-2.5 rounded-lg transition-colors ${
          status === 'executing'
            ? 'bg-accent/5'
            : isError
            ? 'bg-error-bg/40'
            : 'group-hover:bg-surface-1/60'
        } ${hasDetails ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetails && setExpanded((e) => !e)}
        role={hasDetails ? 'button' : undefined}
        aria-expanded={hasDetails ? expanded : undefined}
        {...bind(() => [
          ...(result ? [{ label: copied ? 'Copied' : 'Copy output', onSelect: () => { navigator.clipboard?.writeText(result); }, hint: '' }] : []),
          { label: 'Copy tool name', onSelect: () => { navigator.clipboard?.writeText(tool.replace(/^function:/, '')); } },
          ...(hasDetails ? [{ label: expanded ? 'Collapse' : 'Expand', onSelect: () => setExpanded((e) => !e), separatorAfter: true }] : []),
        ])}
      >
        {/* Keyboard-shortcut number badge (1..9 for the most recent tool calls). */}
        {shortcutIndex && (
          <span className="shrink-0 w-4 h-4 -ml-1 rounded bg-surface-3 text-text-dim text-[9px] font-bold flex items-center justify-center" title={`Press ${shortcutIndex} to toggle this`}>
            {shortcutIndex}
          </span>
        )}
        {/* Status icon */}
        <span className={`shrink-0 ${isError ? 'text-red-agent' : display.color}`}>
          {status === 'executing' ? <Loader2 size={15} className="animate-spin" /> : iconFor(display.icon)}
        </span>

        {/* Humanized label: "Reading index.html" → "Read index.html" */}
        <span className="text-sm text-text flex-1 min-w-0 truncate">
          <span className={`font-medium ${status === 'executing' ? 'shimmer-text' : ''}`}>{verb}</span>
          {pathParts ? (
            <span className="font-mono text-[13px]">
              {' '}
              {pathParts.dir && <span className="text-text-dim">{pathParts.dir}</span>}
              <span className="text-text-muted">{pathParts.base}</span>
            </span>
          ) : display.target ? (
            <span className="text-text-muted font-mono text-[13px]"> {display.target}</span>
          ) : null}
          {status === 'executing' && <span className="text-text-dim">…</span>}
          {repeatCount && repeatCount > 1 && (
            <span className="ml-2 text-[11px] text-text-dim">· {repeatCount} edits</span>
          )}
          {summary && (
            <span className={`ml-2 text-[11px] ${isError ? 'text-red-agent' : 'text-text-dim'}`}>· {summary}</span>
          )}
        </span>

        {/* Right side: diff stats + duration + check */}
        <div className="flex items-center gap-2 shrink-0">
          {showDiffStats && (
            <span className="flex items-center gap-1 text-[11px] font-mono tabular-nums">
              {additions > 0 && <span className="text-green-agent">+{additions}</span>}
              {deletions > 0 && <span className="text-red-agent">−{deletions}</span>}
            </span>
          )}
          {done && duration !== undefined && duration >= 0 && (
            <span className="text-[11px] text-text-dim tabular-nums">{formatDuration(duration)}</span>
          )}
          {done && !isError && <Check size={13} className="text-green-agent" />}
          {done && isError && <span className="text-red-agent text-xs font-bold">!</span>}
          {hasDetails && (
            <ChevronRight size={13} className={`text-text-dim transition-transform ${expanded ? 'rotate-90' : ''}`} />
          )}
        </div>
      </div>

      {expanded && result && (
        isReadFiles && parseReadFilesBlocks(result).length > 1 ? (
          <ReadFilesBlocks result={result} />
        ) : (
        // Sits just inside the spine so the output reads as belonging to the
        // call above it, not as a detached block.
        <div className="ml-3.5 mr-2 mt-0.5 mb-1.5 rounded-lg bg-surface-1 border border-border overflow-hidden">
          <div className="flex items-center justify-between px-2.5 py-1 border-b border-border bg-surface-2">
            <span className="text-[10px] uppercase tracking-wide text-text-dim font-medium">
              {isError ? 'Error output' : 'Output'}
              <span className="ml-1.5 normal-case tracking-normal">· {outputLines} line{outputLines === 1 ? '' : 's'}</span>
            </span>
            <button
              onClick={copyResult}
              className="text-[10px] text-text-dim hover:text-text transition-colors flex items-center gap-1"
              title="Copy output"
            >
              {copied ? <><Check size={10} /> Copied</> : 'Copy'}
            </button>
          </div>
          <pre className={`text-[12px] font-mono whitespace-pre-wrap break-words max-h-56 overflow-y-auto p-2.5 leading-relaxed ${isError ? 'text-red-agent/90' : 'text-text-muted'}`}>
            {result.length > 4000 ? result.slice(0, 4000) + '\n…(truncated)' : result}
          </pre>
        </div>
        )
      )}
    </div>
  );
});
