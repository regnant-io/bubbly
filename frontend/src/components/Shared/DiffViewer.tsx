import React, { useState } from 'react';
import hljs from 'highlight.js/lib/common';
import type { FileDiff } from '../../types';
import { ChevronDown, ChevronRight, Plus, Minus } from './icons';

interface DiffViewerProps {
  diffs: FileDiff[];
  compact?: boolean;
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  content: string;
  /** Line number in the file BEFORE the change, where there is one. */
  oldNo: number | null;
  /** Line number in the file AFTER the change, where there is one. */
  newNo: number | null;
}

/**
 * Parse a unified diff, keeping the line numbers.
 *
 * The old parser threw them away, which made the panel almost useless for the
 * thing people actually do with a diff: go and look at the change in the file.
 * "It's somewhere in the third green block" is not a location. The `@@` header
 * carries both starting numbers, so counting from it is exact and free.
 */
function parseDiffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      out.push({ type: 'hunk', content: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ type: 'add', content: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ type: 'del', content: line.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      out.push({ type: 'ctx', content: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

/**
 * highlight.js language for a path, or null to leave it plain.
 *
 * `highlightAuto` is deliberately NOT used. On a single line of a diff it
 * guesses wrong constantly — a line of English in a markdown file comes back as
 * Perl — and a diff where the colours change meaning from row to row is worse
 * than one with no colour at all. An extension we do not recognise gets no
 * highlighting, which is an honest outcome.
 */
const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile',
};

function languageFor(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? path;
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^makefile$/i.test(name)) return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const lang = EXT_LANGUAGE[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

/**
 * How many lines a diff may have before highlighting is skipped.
 *
 * Highlighting is per line — a diff line is not valid standalone code, so a
 * whole-file pass would mis-tokenise every hunk boundary — and per line it is
 * linear in the number of lines. A thousand-line diff would spend longer being
 * coloured than read, so past this it renders plain and says nothing about it,
 * because the alternative is a panel that hangs.
 */
const HIGHLIGHT_LINE_BUDGET = 600;

function highlightLine(content: string, language: string | null): string | null {
  if (!language || !content) return null;
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

function FileDiffCard({ diff }: { diff: FileDiff }) {
  const [expanded, setExpanded] = useState(true);
  const lines = React.useMemo(() => parseDiffLines(diff.diff), [diff.diff]);

  const language = React.useMemo(() => languageFor(diff.path), [diff.path]);
  const highlighting = language !== null && lines.length <= HIGHLIGHT_LINE_BUDGET;

  // Highlight once per diff, not once per render: a diff panel re-renders on
  // every store update, and re-tokenising six hundred lines each time is
  // exactly the kind of cost that makes a long session feel progressively slower.
  const painted = React.useMemo(
    () => (highlighting ? lines.map((l) => (l.type === 'hunk' ? null : highlightLine(l.content, language))) : []),
    [lines, language, highlighting],
  );

  // The gutter has to be wide enough for the largest number in this file, and
  // then stay that width — a gutter that grows as you scroll shifts every line.
  const widest = React.useMemo(
    () => String(Math.max(1, ...lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)))).length,
    [lines],
  );
  const gutterCh = `${widest + 1}ch`;

  const typeColor =
    diff.type === 'created'
      ? 'text-green-agent border-green-agent/30 bg-success-bg'
      : diff.type === 'deleted'
      ? 'text-red-agent border-red-agent/30 bg-error-bg'
      : 'text-blue-agent border-blue-agent/30 bg-info-bg';

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-2 text-xs font-mono">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-3 hover:bg-surface-4 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-dim shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-dim shrink-0" />
        )}
        <span className={`tag ${typeColor} shrink-0`}>{diff.type}</span>
        <span className="text-text truncate flex-1" title={diff.path}>{diff.path}</span>
        <span className="flex items-center gap-2 shrink-0">
          {diff.additions > 0 && (
            <span className="text-green-agent flex items-center gap-0.5">
              <Plus size={10} />
              {diff.additions}
            </span>
          )}
          {diff.deletions > 0 && (
            <span className="text-red-agent flex items-center gap-0.5">
              <Minus size={10} />
              {diff.deletions}
            </span>
          )}
        </span>
      </button>

      {/*
        THE COLOUR DOES TWO JOBS AND MUST NOT CONFUSE THEM.
        The BACKGROUND says what happened to the line (added, removed, context);
        the FOREGROUND says what the code means. Before this the foreground was
        doing both — every added line was solid green, including its strings,
        keywords and comments — so a diff was legible as a shape and illegible
        as code. Now the tint stays on the background where it belongs and the
        code is syntax-highlighted exactly as it is in the editor.
      */}
      {expanded && (
        <div className="overflow-x-auto max-h-80 overflow-y-auto diff-body">
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return (
                <div key={i} className="px-3 py-0.5 bg-info-bg text-blue-agent/70 sticky top-0 backdrop-blur-sm">
                  {line.content}
                </div>
              );
            }
            const html = highlighting ? painted[i] : null;
            return (
              <div
                key={i}
                className={`flex items-start whitespace-pre leading-[1.55] ${
                  line.type === 'add'
                    ? 'bg-success-bg'
                    : line.type === 'del'
                    ? 'bg-error-bg'
                    : ''
                }`}
              >
                <span
                  className="shrink-0 select-none text-right pr-2 pl-2 text-text-dim/45 tabular-nums"
                  style={{ width: gutterCh }}
                  aria-hidden
                >
                  {line.oldNo ?? ''}
                </span>
                <span
                  className="shrink-0 select-none text-right pr-2 text-text-dim/45 tabular-nums"
                  style={{ width: gutterCh }}
                  aria-hidden
                >
                  {line.newNo ?? ''}
                </span>
                <span
                  className={`shrink-0 select-none w-4 text-center ${
                    line.type === 'add' ? 'text-green-agent' : line.type === 'del' ? 'text-red-agent' : 'text-text-dim/40'
                  }`}
                >
                  {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                </span>
                <span className={`flex-1 pr-3 ${line.type === 'ctx' ? 'text-text-muted' : 'text-text'}`}>
                  {html !== null
                    ? <code className="hljs-inline" dangerouslySetInnerHTML={{ __html: html }} />
                    : line.content || '​'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ diffs, compact }: DiffViewerProps) {
  if (diffs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-dim text-sm py-12">
        <div className="text-4xl mb-3 opacity-30">∅</div>
        <div>No file changes yet</div>
      </div>
    );
  }

  const totalAdd = diffs.reduce((s, d) => s + d.additions, 0);
  const totalDel = diffs.reduce((s, d) => s + d.deletions, 0);

  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <div className="flex items-center gap-3 text-xs text-text-dim pb-2 border-b border-border">
          <span>{diffs.length} file{diffs.length !== 1 ? 's' : ''} changed</span>
          {totalAdd > 0 && (
            <span className="text-green-agent">+{totalAdd}</span>
          )}
          {totalDel > 0 && (
            <span className="text-red-agent">-{totalDel}</span>
          )}
        </div>
      )}
      {diffs.map((diff, i) => (
        <FileDiffCard key={`${diff.path}-${i}`} diff={diff} />
      ))}
    </div>
  );
}
