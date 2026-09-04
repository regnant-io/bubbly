import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { useStore } from '../../store';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { fetchSpecs, fetchFileContent } from '../../hooks/useApi';
import type { Spec, SpecTask } from '../../types';
import { ClipboardList, RefreshCw, FileText, ChevronRight } from '../Shared/icons';
import { MarkdownContent } from '../Shared/MarkdownContent';

/**
 * The Specs panel.
 *
 * A spec is three markdown files on disk — requirements.md, design.md,
 * tasks.md — so this panel's job is to render THOSE, not a database projection
 * of them. It reads the actual files, which means what you see here is exactly
 * what the agent reads and exactly what `git diff` will show. There is nothing
 * to get out of sync.
 *
 * Task state is the checkbox character in tasks.md: `- [ ]`, `- [~]`, `- [x]`.
 * The list below renders those three states directly rather than inventing its
 * own vocabulary, so the panel and the file always agree — and a user who edits
 * a checkbox by hand in the editor sees the change here on the next refresh.
 */

type DocTab = 'requirements' | 'design' | 'tasks';

const DOC_FILES: Record<DocTab, string> = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
};

/** The marker as it appears in tasks.md, which is the whole point. */
function markerFor(status: SpecTask['status']): string {
  return status === 'done' ? 'x' : status === 'in_progress' ? '~' : ' ';
}

function TaskRow({ task, depth = 0 }: { task: SpecTask | { id: string; title: string; status: SpecTask['status']; acceptance?: string }; depth?: number }) {
  const t = task as SpecTask;
  const done = t.status === 'done';
  const active = t.status === 'in_progress';

  return (
    <div style={{ paddingLeft: depth * 14 }} className="py-1">
      <div className="flex items-start gap-2">
        <span
          className={`font-mono text-[11px] leading-5 shrink-0 select-none ${
            done ? 'text-green-agent' : active ? 'text-accent-bright' : 'text-text-dim'
          }`}
          title={done ? 'done' : active ? 'in progress' : 'not started'}
        >
          [{markerFor(t.status)}]
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={`text-xs ${
              done ? 'text-text-dim line-through decoration-text-dim/40'
              : active ? 'text-text font-medium'
              : 'text-text'
            }`}
          >
            {t.title}
          </span>
          {active && (
            <span className="ml-2 align-middle inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-slow" />
          )}

          {/* The task's own contract, straight from the file. */}
          {t.targetFiles && t.targetFiles.length > 0 && (
            <div className="text-[11px] text-text-dim font-mono truncate mt-0.5">{t.targetFiles.join(', ')}</div>
          )}
          {t.acceptance && (
            <div className="text-[11px] text-text-muted mt-0.5">
              <span className="text-text-dim">done when </span>{t.acceptance}
            </div>
          )}
          {t.verifyWith && (
            <div className="text-[11px] text-text-muted mt-0.5">
              <span className="text-text-dim">verify </span>
              <code className="font-mono text-[10px] bg-surface-3 rounded px-1 py-0.5">{t.verifyWith}</code>
            </div>
          )}
          {t.dependsOn && t.dependsOn.length > 0 && (
            <div className="text-[11px] text-text-dim mt-0.5">after {t.dependsOn.join(', ')}</div>
          )}
        </div>
      </div>

      {t.subTasks?.map((st) => <TaskRow key={st.id} task={st} depth={depth + 1} />)}
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-surface-3 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${done === total ? 'bg-green-agent' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] text-text-dim tabular-nums whitespace-nowrap">{done}/{total}</span>
    </div>
  );
}

function phaseLabel(spec: Spec): string {
  switch (spec.phase) {
    case 'requirements': return 'writing requirements';
    case 'design': return 'writing design';
    case 'tasks': return 'writing tasks';
    default: return spec.status === 'done' ? 'complete' : 'in progress';
  }
}

function SpecCard({ spec, workspacePath }: { spec: Spec; workspacePath: string }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<DocTab>('tasks');
  const [doc, setDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tasks = spec.tasks ?? [];
  const done = tasks.filter((t) => t.status === 'done').length;

  // Which documents actually exist, so we never offer an empty tab.
  const available = useMemo<DocTab[]>(() => {
    const list: DocTab[] = [];
    if ((spec.requirements ?? []).length > 0) list.push('requirements');
    if (spec.design && spec.design.trim()) list.push('design');
    if (tasks.length > 0) list.push('tasks');
    return list;
  }, [spec.requirements, spec.design, tasks.length]);

  useEffect(() => {
    if (available.length > 0 && !available.includes(tab)) setTab(available[available.length - 1]);
  }, [available, tab]);

  // Read the real file for prose documents. Tasks are rendered from the parsed
  // structure instead — the checkbox list is more useful as a live list than as
  // a wall of markdown, and it is derived from the same file either way.
  useEffect(() => {
    if (!expanded || tab === 'tasks') { setDoc(null); return; }
    let cancelled = false;
    setLoading(true);
    fetchFileContent(workspacePath, `.bubbly/specs/${spec.id}/${DOC_FILES[tab]}`)
      .then((r) => { if (!cancelled) setDoc(typeof r?.content === 'string' ? r.content : null); })
      .catch(() => { if (!cancelled) setDoc(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, tab, spec.id, spec.updatedAt, workspacePath]);

  return (
    <div className="border border-border rounded-xl mb-2 bg-surface-2 overflow-hidden hover:border-border-bright transition-colors">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left p-3"
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-2">
          <ChevronRight
            size={12}
            className={`mt-1 shrink-0 text-text-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h4 className="text-sm font-medium text-text truncate">{spec.title}</h4>
              <span className={`tag text-[10px] border ${
                spec.status === 'done' ? 'text-green-agent bg-success-bg border-green-agent/40'
                : spec.status === 'in_progress' ? 'text-blue-agent bg-info-bg border-blue-agent/40'
                : 'text-amber-agent bg-warning-bg border-amber-agent/40'
              }`}>
                {phaseLabel(spec)}
              </span>
            </div>
            {/* The path is the point: these are real files you can open. */}
            <div className="text-[10px] text-text-dim font-mono truncate mb-1.5">
              .bubbly/specs/{spec.id}/
            </div>
            <ProgressBar done={done} total={tasks.length} />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {available.length > 1 && (
            <div className="flex items-center gap-1 px-3 pt-2">
              {available.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-2 py-1 rounded-md text-[11px] transition-colors ${
                    tab === t ? 'bg-accent/15 text-accent-bright' : 'text-text-dim hover:text-text hover:bg-surface-3'
                  }`}
                >
                  {t}
                </button>
              ))}
              <span className="flex-1" />
              <span className="text-[10px] text-text-dim font-mono">{DOC_FILES[tab]}</span>
            </div>
          )}

          <div className="p-3 max-h-[28rem] overflow-y-auto">
            {tab === 'tasks' ? (
              tasks.length === 0
                ? <p className="text-xs text-text-dim">No tasks written yet.</p>
                : (
                  <div className="divide-y divide-border">
                    {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
                  </div>
                )
            ) : loading ? (
              <p className="text-xs text-text-dim">Reading {DOC_FILES[tab]}…</p>
            ) : doc ? (
              <MarkdownContent content={doc} className="text-xs" />
            ) : (
              <p className="text-xs text-text-dim">
                {DOC_FILES[tab]} could not be read. It may not have been written yet.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SpecPanel() {
  const { workspacePath, specs, setSpecs } = useStore();
  const { scrollRef } = useScrollRestoration('spec-panel', true);
  const [loading, setLoading] = useState(false);

  const loadSpecs = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      const data = await fetchSpecs(workspacePath);
      if (Array.isArray(data)) setSpecs(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, setSpecs]);

  useEffect(() => { loadSpecs(); }, [loadSpecs]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <ClipboardList size={14} className="text-accent-bright" />
          <span className="text-sm font-medium text-text">Specs</span>
          {specs.length > 0 && (
            <span className="tag bg-accent/15 text-accent-bright">{specs.length}</span>
          )}
        </div>
        <button
          onClick={loadSpecs}
          className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors"
          title="Re-read the spec files from disk"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
        {!workspacePath ? (
          <div className="text-center py-8 text-text-dim text-sm">
            <ClipboardList size={24} className="mx-auto mb-2 opacity-30" />
            Set a workspace in Settings
          </div>
        ) : specs.length === 0 ? (
          <div className="text-center py-8 text-text-dim text-sm">
            <FileText size={24} className="mx-auto mb-2 opacity-30" />
            <p>No specs yet</p>
            <p className="text-xs mt-1 text-text-dim">
              Start a Spec Session and the agent will write
              <br />
              <code className="font-mono text-[10px]">.bubbly/specs/&lt;name&gt;/</code>
            </p>
          </div>
        ) : (
          specs.map((spec) => <SpecCard key={spec.id} spec={spec} workspacePath={workspacePath} />)
        )}
      </div>
    </div>
  );
}
