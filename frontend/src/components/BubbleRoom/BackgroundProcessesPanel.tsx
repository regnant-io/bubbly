import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import {
  listBackgroundProcesses,
  getBackgroundOutput,
  stopBackgroundProcess,
  BackgroundProcessInfo,
} from '../../hooks/useApi';
import { ChevronRight, ChevronDown, Square, RefreshCw, ExternalLink, Server } from '../Shared/icons';
import { isDesktop } from '../../hooks/useDesktop';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const STATUS_STYLE: Record<string, string> = {
  running: 'bg-green-agent',
  exited: 'bg-text-dim',
  killed: 'bg-red-agent',
};

/**
 * Background tab — every process Bubbly is running (dev servers, watchers,
 * builds the agent or the preview started). Each row is collapsible; expanding
 * it polls and shows the process's live log in a scrollable pane.
 */
export function BackgroundProcessesPanel() {
  const [procs, setProcs] = useState<BackgroundProcessInfo[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const setPreviewUrl = useStore((s) => s.setPreviewUrl);
  const revealBottomPanel = useStore((s) => s.revealBottomPanel);

  const refresh = useCallback(async () => {
    const r = await listBackgroundProcesses();
    setProcs(r.processes);
    setLoaded(true);
  }, []);

  // Poll the process list every 2s while the tab is mounted.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const openInPreview = (url: string) => {
    setPreviewUrl(url);
    revealBottomPanel('preview');
  };

  const running = procs.filter((p) => p.status === 'running').length;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border shrink-0 text-[11px] text-text-dim">
        <span className="uppercase tracking-wide font-medium">
          {running} running · {procs.length} total
        </span>
        <div className="flex-1" />
        <button onClick={refresh} title="Refresh" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loaded && procs.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-2 text-text-dim">
            <div className="w-11 h-11 rounded-2xl bg-surface-2 border border-border flex items-center justify-center">
              <Server size={20} className="text-accent-bright" />
            </div>
            <p className="text-sm font-medium text-text">No background processes</p>
            <p className="text-xs leading-relaxed max-w-[240px]">
              Dev servers, watchers and builds that Bubbly starts show up here with their live logs.
            </p>
          </div>
        )}

        {procs.map((p) => (
          <ProcessRow
            key={p.id}
            proc={p}
            open={expanded.has(p.id)}
            onToggle={() => toggle(p.id)}
            onOpenInPreview={openInPreview}
            onStopped={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function ProcessRow({
  proc,
  open,
  onToggle,
  onOpenInPreview,
  onStopped,
}: {
  proc: BackgroundProcessInfo;
  open: boolean;
  onToggle: () => void;
  onOpenInPreview: (url: string) => void;
  onStopped: () => void;
}) {
  const [log, setLog] = useState('');
  const [stopping, setStopping] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const pinnedBottom = useRef(true);

  // While expanded, poll this process's output every 1.5s and keep it pinned to
  // the bottom unless the user has scrolled up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const pull = async () => {
      const r = await getBackgroundOutput(proc.id);
      if (cancelled) return;
      setLog(stripAnsi(r.output || ''));
    };
    pull();
    const t = setInterval(pull, 1500);
    return () => { cancelled = true; clearInterval(t); };
  }, [open, proc.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const stop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStopping(true);
    await stopBackgroundProcess(proc.id).catch(() => { /* best-effort */ });
    setStopping(false);
    onStopped();
  };

  const openExternal = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!proc.detectedUrl) return;
    const api = (window as any).bubblyDesktop;
    if (isDesktop() && api?.openExternal) api.openExternal(proc.detectedUrl);
    else window.open(proc.detectedUrl, '_blank', 'noreferrer');
  };

  const isRunning = proc.status === 'running';

  return (
    <div className="border-b border-border">
      {/* Header row (click to expand) */}
      <div
        onClick={onToggle}
        className="group flex items-center gap-2 px-2 py-2 cursor-pointer hover:bg-surface-2 transition-colors"
      >
        {open ? <ChevronDown size={13} className="text-text-dim shrink-0" /> : <ChevronRight size={13} className="text-text-dim shrink-0" />}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_STYLE[proc.status] ?? 'bg-text-dim'} ${isRunning ? 'animate-pulse' : ''}`}
          title={proc.status}
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-text truncate" title={proc.command}>{proc.command}</div>
          <div className="flex items-center gap-2 text-[10px] text-text-dim">
            <span>{proc.id}</span>
            <span>· {isRunning ? uptime(proc.uptimeMs) : proc.status === 'exited' ? `exit ${proc.exitCode ?? 0}` : 'stopped'}</span>
            {proc.awaitingInput && <span className="text-amber-agent">· awaiting input</span>}
          </div>
        </div>
        {proc.detectedUrl && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenInPreview(proc.detectedUrl!); }}
            title={`Open ${proc.detectedUrl} in Bubbly Preview`}
            className="px-1.5 py-0.5 rounded bg-accent/15 text-accent-bright text-[10px] font-mono hover:bg-accent/25 transition-colors shrink-0 max-w-[120px] truncate"
          >
            {proc.detectedUrl.replace(/^https?:\/\//, '')}
          </button>
        )}
        {proc.detectedUrl && (
          <button onClick={openExternal} title="Open in system browser" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <ExternalLink size={12} />
          </button>
        )}
        {isRunning && (
          <button
            onClick={stop}
            disabled={stopping}
            title="Stop this process"
            className="p-1 rounded text-red-agent hover:bg-surface-3 transition-colors shrink-0 disabled:opacity-40"
          >
            <Square size={12} />
          </button>
        )}
      </div>

      {/* Expanded: live log in a scrollable pane */}
      {open && (
        <pre
          ref={logRef}
          onScroll={onScroll}
          className="max-h-64 overflow-y-auto bg-surface-0 border-t border-border px-3 py-2 m-0 font-mono text-[11.5px] leading-relaxed text-text-muted whitespace-pre-wrap break-words"
        >
          {log || <span className="text-text-dim italic">No output yet…</span>}
        </pre>
      )}
    </div>
  );
}
