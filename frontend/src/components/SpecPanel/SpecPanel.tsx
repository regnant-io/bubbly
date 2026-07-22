import React, { useEffect, useCallback } from 'react';
import { useStore } from '../../store';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { fetchSpecs } from '../../hooks/useApi';
import type { Spec } from '../../types';
import { ClipboardList, CheckCircle, Clock, RefreshCw, Plus } from '../Shared/icons';
import { MarkdownContent } from '../Shared/MarkdownContent';

function statusColor(status: Spec['status']): string {
  switch (status) {
    case 'done': return 'text-green-agent bg-success-bg border-green-agent/40';
    case 'in_progress': return 'text-blue-agent bg-info-bg border-blue-agent/40';
    case 'cancelled': return 'text-text-dim bg-surface-3 border-border';
    default: return 'text-amber-agent bg-warning-bg border-amber-agent/40';
  }
}

function typeColor(type: Spec['type']): string {
  switch (type) {
    case 'feature': return 'text-accent-bright';
    case 'bugfix': return 'text-red-agent';
    case 'refactor': return 'text-amber-agent';
    case 'research': return 'text-blue-agent';
  }
}

function SpecCard({ spec }: { spec: Spec }) {
  const [expanded, setExpanded] = React.useState(false);
  const [showDesign, setShowDesign] = React.useState(false);
  const doneTasks = (spec.tasks ?? []).filter((t) => t.status === 'done').length;
  const totalTasks = (spec.tasks ?? []).length;
  const properties = spec.properties ?? [];
  const requirements = spec.requirements ?? [];
  const phase = spec.phase ?? 'ready';

  return (
    <div className="border border-border rounded-xl p-3 mb-2 bg-surface-2 hover:border-border-bright transition-colors">
      <div
        className="flex items-start justify-between gap-2 mb-2 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-xs font-medium ${typeColor(spec.type)}`}>{spec.type}</span>
            <span className={`tag text-xs border ${statusColor(spec.status)}`}>{spec.status}</span>
            {phase !== 'ready' && (
              <span className="tag text-xs bg-accent/15 text-accent-bright border border-accent/30">
                phase: {phase}
              </span>
            )}
            {properties.length > 0 && (
              <span className="tag text-xs bg-surface-3 text-text-dim border border-border">
                {properties.length} props
              </span>
            )}
          </div>
          <h4 className="text-sm font-medium text-text truncate">{spec.title}</h4>
        </div>
        <span className="text-text-dim text-xs mt-1 shrink-0">{expanded ? '▼' : '▶'}</span>
      </div>

      {/* Staged-workflow phase tracker */}
      {phase !== 'ready' && (
        <div className="flex items-center gap-1 mb-2 text-[10px]">
          {(['requirements', 'design', 'tasks'] as const).map((p, i) => {
            const order = ['requirements', 'design', 'tasks', 'ready'];
            const reached = order.indexOf(phase) > order.indexOf(p);
            const current = phase === p;
            const approved = spec.approvals?.[p];
            return (
              <React.Fragment key={p}>
                {i > 0 && <span className="text-text-dim">→</span>}
                <span className={`px-1.5 py-0.5 rounded ${
                  approved || reached ? 'bg-green-agent/15 text-green-agent' :
                  current ? 'bg-accent/15 text-accent-bright' : 'bg-surface-3 text-text-dim'
                }`}>
                  {approved || reached ? '✓ ' : ''}{p}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Acceptance properties (EARS) */}
      {properties.length > 0 && (
        <ul className="text-xs text-text-muted space-y-0.5 mb-2">
          {(expanded ? properties : properties.slice(0, 3)).map((p) => (
            <li key={p.id} className="flex items-start gap-1.5">
              <span className="text-accent-bright mt-0.5 shrink-0 font-mono">{p.id}</span>
              <span className={expanded ? '' : 'truncate'}>{p.statement}</span>
            </li>
          ))}
          {!expanded && properties.length > 3 && (
            <li className="text-text-dim">+{properties.length - 3} more…</li>
          )}
        </ul>
      )}

      {/* Design document (collapsible) */}
      {expanded && spec.design && spec.design.trim().length > 0 && (
        <div className="mb-2 border-t border-border pt-2">
          <button
            onClick={(e) => { e.stopPropagation(); setShowDesign((s) => !s); }}
            className="text-xs text-accent-bright hover:underline"
          >
            {showDesign ? '▼' : '▶'} Design document
          </button>
          {showDesign && (
            // design.md is real markdown — render it, don't dump it as raw text.
            <div className="mt-1.5 max-h-80 overflow-y-auto bg-surface-1 rounded-lg p-3 border border-border">
              <MarkdownContent content={spec.design} className="text-xs" />
            </div>
          )}
        </div>
      )}

      {/* Fallback to plain requirements if no structured properties */}
      {properties.length === 0 && requirements.length > 0 && (
        <ul className="text-xs text-text-muted space-y-0.5 mb-2">
          {requirements.slice(0, expanded ? undefined : 3).map((r, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="text-text-dim mt-0.5 shrink-0">•</span>
              <span className={expanded ? '' : 'truncate'}>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {totalTasks > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all"
              style={{ width: `${(doneTasks / totalTasks) * 100}%` }}
            />
          </div>
          <span className="text-xs text-text-dim whitespace-nowrap">
            {doneTasks}/{totalTasks} tasks
          </span>
        </div>
      )}

      {/* Expanded task detail with target files + dependencies */}
      {expanded && totalTasks > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-2">
          {(spec.tasks ?? []).map((t) => (
            <div key={t.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                {/* Mirrors the tasks.md marker: [ ] / [~] / [x] */}
                <span className={
                  t.status === 'done' ? 'text-green-agent' :
                  t.status === 'in_progress' ? 'text-blue-agent' : 'text-text-dim'
                }>
                  {t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span className={
                  t.status === 'done' ? 'text-text-dim line-through decoration-text-dim/50' :
                  t.status === 'in_progress' ? 'text-text font-medium' : 'text-text'
                }>
                  {t.title}
                </span>
              </div>
              {t.targetFiles && t.targetFiles.length > 0 && (
                <div className="ml-5 text-text-dim font-mono truncate">→ {t.targetFiles.join(', ')}</div>
              )}
              {t.acceptance && (
                <div className="ml-5 text-text-dim italic truncate">done when: {t.acceptance}</div>
              )}
              {t.subTasks && t.subTasks.length > 0 && (
                <div className="ml-5 mt-0.5 space-y-0.5">
                  {t.subTasks.map((st) => (
                    <div key={st.id} className="flex items-center gap-1.5 text-text-dim">
                      <span className={st.status === 'done' ? 'text-green-agent' : st.status === 'in_progress' ? 'text-blue-agent' : ''}>
                        {st.status === 'done' ? '✓' : st.status === 'in_progress' ? '◐' : '○'}
                      </span>
                      <span>{st.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 text-xs text-text-dim">
        {new Date(spec.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

export function SpecPanel() {
  const { workspacePath, specs, setSpecs } = useStore();
  const { scrollRef } = useScrollRestoration('spec-panel', true);

  const loadSpecs = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const data = await fetchSpecs(workspacePath);
      if (Array.isArray(data)) setSpecs(data);
    } catch (e) {
      console.error(e);
    }
  }, [workspacePath, setSpecs]);

  useEffect(() => {
    loadSpecs();
  }, [loadSpecs]);

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
          title="Refresh specs"
        >
          <RefreshCw size={12} />
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
            <ClipboardList size={24} className="mx-auto mb-2 opacity-30" />
            <p>No specs yet</p>
            <p className="text-xs mt-1 text-text-dim">
              Ask the agent to create a spec for your feature
            </p>
          </div>
        ) : (
          specs.map((spec) => <SpecCard key={spec.id} spec={spec} />)
        )}
      </div>
    </div>
  );
}
