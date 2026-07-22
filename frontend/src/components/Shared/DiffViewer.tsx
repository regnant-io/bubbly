import React, { useState } from 'react';
import type { FileDiff } from '../../types';
import { ChevronDown, ChevronRight, Plus, Minus } from './icons';

interface DiffViewerProps {
  diffs: FileDiff[];
  compact?: boolean;
}

function parseDiffLines(diff: string): Array<{ type: 'add' | 'del' | 'ctx' | 'hunk'; content: string }> {
  const lines = diff.split('\n');
  const result: Array<{ type: 'add' | 'del' | 'ctx' | 'hunk'; content: string }> = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) {
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1) });
    } else {
      result.push({ type: 'ctx', content: line.slice(1) || line });
    }
  }
  return result;
}

function FileDiffCard({ diff }: { diff: FileDiff }) {
  const [expanded, setExpanded] = useState(true);
  const lines = parseDiffLines(diff.diff);

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
        <span className="text-text truncate flex-1">{diff.path}</span>
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

      {/* Diff lines */}
      {expanded && (
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return (
                <div key={i} className="px-3 py-0.5 bg-info-bg text-blue-agent/70 text-xs">
                  {line.content}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`px-3 py-0.5 whitespace-pre ${
                  line.type === 'add'
                    ? 'bg-success-bg text-green-agent'
                    : line.type === 'del'
                    ? 'bg-error-bg text-red-agent'
                    : 'text-text-dim'
                }`}
              >
                <span className="select-none mr-2 text-text-dim opacity-50">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                {line.content}
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
