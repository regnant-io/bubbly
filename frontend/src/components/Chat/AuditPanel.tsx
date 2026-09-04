import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { useStore } from '../../store';
import { auditEventLabel, TONE_CLASS } from '../../utils/eventLabels';
import { fetchAuditEvents } from '../../hooks/useApi';
import type { AuditEvent } from '../../types';
import { ChevronRight, Clock, Terminal, FileCode, GitBranch, AlertCircle, RefreshCw, Zap, Download, Filter } from '../Shared/icons';

function eventIcon(type: string, tool?: string) {
  if (tool?.startsWith('git')) return <GitBranch size={12} className="text-green-agent" />;
  if (tool === 'run_command') return <Terminal size={12} className="text-amber-agent" />;
  if (tool?.includes('file')) return <FileCode size={12} className="text-blue-agent" />;
  if (type === 'error') return <AlertCircle size={12} className="text-red-agent" />;
  if (type === 'session_complete') return <Zap size={12} className="text-accent-bright" />;
  return <Clock size={12} className="text-text-dim" />;
}

// Cost estimates per 1M tokens (approximate)
const COST_PER_MILLION_TOKENS = {
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'ollama': { input: 0, output: 0 }, // Local models are free
};

export function AuditPanel() {
  const { currentSessionId } = useStore();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterEventType, setFilterEventType] = useState<string>('all');
  const [filterTool, setFilterTool] = useState<string>('all');
  const [filterDateRange, setFilterDateRange] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  const load = useCallback(async () => {
    if (!currentSessionId) return;
    setLoading(true);
    try {
      const data = await fetchAuditEvents(currentSessionId);
      setEvents(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // Get unique event types and tools for filter dropdowns
  const uniqueEventTypes = useMemo(() => {
    const types = new Set(events.map(e => e.event_type));
    return ['all', ...Array.from(types).sort()];
  }, [events]);

  const uniqueTools = useMemo(() => {
    const tools = new Set(events.filter(e => e.tool).map(e => e.tool!));
    return ['all', ...Array.from(tools).sort()];
  }, [events]);

  // Filter events based on selected filters
  const filteredEvents = useMemo(() => {
    let filtered = events;

    // Filter by event type
    if (filterEventType !== 'all') {
      filtered = filtered.filter(e => e.event_type === filterEventType);
    }

    // Filter by tool
    if (filterTool !== 'all') {
      filtered = filtered.filter(e => e.tool === filterTool);
    }

    // Filter by date range
    if (filterDateRange !== 'all') {
      const now = new Date();
      const cutoff = new Date();
      
      switch (filterDateRange) {
        case 'last_hour':
          cutoff.setHours(now.getHours() - 1);
          break;
        case 'last_24h':
          cutoff.setHours(now.getHours() - 24);
          break;
        case 'last_7d':
          cutoff.setDate(now.getDate() - 7);
          break;
      }

      filtered = filtered.filter(e => new Date(e.created_at) >= cutoff);
    }

    return filtered;
  }, [events, filterEventType, filterTool, filterDateRange]);

  const totalTokens = filteredEvents.reduce((s, e) => s + (e.tokens_used ?? 0), 0);

  // Calculate cost estimate (we'll need to get the model from session)
  // For now, assume Claude 3.5 Sonnet as default
  const estimatedCost = useMemo(() => {
    // This is a simplified calculation - in reality we'd need to track input vs output tokens separately
    const costPerToken = (COST_PER_MILLION_TOKENS['claude-3-5-sonnet-20241022'].input + 
                          COST_PER_MILLION_TOKENS['claude-3-5-sonnet-20241022'].output) / 2;
    return (totalTokens / 1_000_000) * costPerToken;
  }, [totalTokens]);

  // Export to JSON
  const exportToJSON = useCallback(() => {
    const dataStr = JSON.stringify(filteredEvents, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${currentSessionId}-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredEvents, currentSessionId]);

  // Export to CSV
  const exportToCSV = useCallback(() => {
    const headers = ['ID', 'Event Type', 'Tool', 'Tokens Used', 'Result Summary', 'Created At'];
    const rows = filteredEvents.map(e => [
      e.id,
      e.event_type,
      e.tool || '',
      e.tokens_used?.toString() || '0',
      (e.result_summary || '').replace(/"/g, '""'), // Escape quotes
      e.created_at
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const dataBlob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${currentSessionId}-${new Date().toISOString()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredEvents, currentSessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-accent-bright" />
          <span className="text-sm font-medium text-text">Audit Log</span>
        </div>
        <div className="flex items-center gap-2">
          {totalTokens > 0 && (
            <div className="flex flex-col items-end text-xs text-text-dim">
              <div>
                <Zap size={10} className="inline mr-0.5" />
                {totalTokens.toLocaleString()} tokens
              </div>
              {estimatedCost > 0 && (
                <div className="text-text-dim/70">
                  ~${estimatedCost.toFixed(4)}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-1 rounded hover:bg-surface-3 transition-colors ${
              showFilters ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text'
            }`}
            title="Toggle filters"
          >
            <Filter size={12} />
          </button>
          <button
            onClick={load}
            className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <div className="relative group">
            <button
              className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors"
              title="Export"
            >
              <Download size={12} />
            </button>
            <div className="absolute right-0 top-full mt-1 bg-surface-2 border border-border rounded shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              <button
                onClick={exportToJSON}
                className="block w-full px-3 py-2 text-xs text-left hover:bg-surface-3 transition-colors whitespace-nowrap"
              >
                Export as JSON
              </button>
              <button
                onClick={exportToCSV}
                className="block w-full px-3 py-2 text-xs text-left hover:bg-surface-3 transition-colors whitespace-nowrap"
              >
                Export as CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="px-4 py-3 border-b border-border bg-surface-2 shrink-0">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-text-dim mb-1">Event Type</label>
              <select
                value={filterEventType}
                onChange={(e) => setFilterEventType(e.target.value)}
                className="w-full px-2 py-1 text-xs bg-surface-1 border border-border rounded text-text focus:outline-none focus:border-accent-bright"
              >
                {uniqueEventTypes.map(type => (
                  <option key={type} value={type}>
                    {type === 'all' ? 'All Types' : type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-dim mb-1">Tool</label>
              <select
                value={filterTool}
                onChange={(e) => setFilterTool(e.target.value)}
                className="w-full px-2 py-1 text-xs bg-surface-1 border border-border rounded text-text focus:outline-none focus:border-accent-bright"
              >
                {uniqueTools.map(tool => (
                  <option key={tool} value={tool}>
                    {tool === 'all' ? 'All Tools' : tool}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-dim mb-1">Date Range</label>
              <select
                value={filterDateRange}
                onChange={(e) => setFilterDateRange(e.target.value)}
                className="w-full px-2 py-1 text-xs bg-surface-1 border border-border rounded text-text focus:outline-none focus:border-accent-bright"
              >
                <option value="all">All Time</option>
                <option value="last_hour">Last Hour</option>
                <option value="last_24h">Last 24 Hours</option>
                <option value="last_7d">Last 7 Days</option>
              </select>
            </div>
          </div>
          <div className="mt-2 text-xs text-text-dim">
            Showing {filteredEvents.length} of {events.length} events
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!currentSessionId ? (
          <div className="text-center py-8 text-text-dim text-sm">
            <Clock size={24} className="mx-auto mb-2 opacity-30" />
            No active session
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="text-center py-8 text-text-dim text-sm">
            {loading ? 'Loading…' : events.length === 0 ? 'No events yet' : 'No events match filters'}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredEvents.map((event) => (
              <AuditRow key={event.id} event={event} icon={eventIcon(event.event_type, event.tool)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * One audit row, expandable.
 *
 * The collapsed row answers "what happened", which is what you are scanning
 * for. Everything else — the arguments the tool was given, the full result, the
 * exact timestamp — is what you want only once you have found the row that
 * matters, and putting it on screen for every row makes finding that row
 * harder. So it expands.
 *
 * The arguments are the reason this is worth having at all: "Edited a file" is
 * a fact, and "Edited src/auth/session.ts, replacing the token check" is
 * evidence.
 */
function AuditRow({ event, icon }: { event: AuditEvent; icon: React.ReactNode }) {
  const [expanded, setExpanded] = React.useState(false);
  const { label, detail, tone } = auditEventLabel(event.event_type, event.tool);

  const args = React.useMemo(() => {
    if (!event.args) return null;
    try {
      const parsed = typeof event.args === 'string' ? JSON.parse(event.args) : event.args;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [event.args]);

  /** The single most identifying argument, shown on the collapsed row. */
  const subject = React.useMemo(() => {
    if (!args) return null;
    for (const key of ['path', 'command', 'query', 'name', 'url', 'instruction', 'message', 'question']) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) {
        return v.length > 70 ? `${v.slice(0, 69)}…` : v;
      }
    }
    if (Array.isArray(args.paths)) return `${(args.paths as unknown[]).length} files`;
    return null;
  }, [args]);

  const hasDetail = !!args || !!event.result_summary || !!detail;

  return (
    <div className="px-4 py-2 hover:bg-surface-3/50 transition-colors">
      <button
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`w-full flex items-start gap-3 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className={`text-xs font-medium ${TONE_CLASS[tone]}`}>{label}</span>
            {subject && <span className="text-[11px] text-text-dim font-mono truncate">{subject}</span>}
            {event.tokens_used ? (
              <span className="ml-auto shrink-0 text-[10px] text-text-dim tabular-nums">
                {event.tokens_used.toLocaleString()} tok
              </span>
            ) : null}
          </div>
          <p className="text-[10px] text-text-dim/70 mt-0.5 tabular-nums">
            {new Date(event.created_at).toLocaleTimeString()}
          </p>
        </div>
        {hasDetail && (
          <ChevronRight
            size={12}
            className={`shrink-0 mt-1 text-text-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        )}
      </button>

      {expanded && (
        <div className="mt-2 ml-7 space-y-2">
          {detail && <p className="text-[11px] text-text-muted leading-relaxed">{detail}</p>}

          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wide text-text-dim mb-1">Arguments</div>
              <dl className="space-y-0.5">
                {Object.entries(args).slice(0, 12).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-[11px]">
                    <dt className="text-text-dim shrink-0 font-mono">{key}</dt>
                    <dd className="text-text-muted font-mono break-all">
                      {typeof value === 'string'
                        ? (value.length > 300 ? `${value.slice(0, 299)}…` : value)
                        : JSON.stringify(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {event.result_summary && (
            <div>
              <div className="text-[9px] uppercase tracking-wide text-text-dim mb-1">Result</div>
              <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-words bg-surface-2 rounded-lg p-2 max-h-40 overflow-y-auto">
                {event.result_summary}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
