import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from '../../store';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Terminal, Plus, X, Bot, Monitor } from '../Shared/icons';
import { ExternalLink, Copy } from '../Shared/icons';
import { isDesktop } from '../../hooks/useDesktop';
import { XtermView } from './XtermView';
import { getTerminalScrollback } from '../../utils/terminalBus';

/**
 * IDE-style integrated panel, modeled on VS Code's bottom panel:
 *   - A row of SECTION tabs (Problems · Output · Debug Console · Terminal · Ports).
 *   - In the Terminal section, the active shell fills the main area and the list
 *     of open terminals sits on the RIGHT (VS Code's terminal split list), with
 *     a + to create more — so many terminals never break the layout.
 *
 * User terminals are real PTYs (xterm.js). Agent terminals are read-only
 * transcripts of commands the AI ran.
 */

type Section = 'problems' | 'output' | 'debug' | 'terminal' | 'ports';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

export function TerminalPanel() {
  const { terminals, activeTerminalId, workspacePath, setActiveTerminal, closeTerminal, settings, previewUrl, setPreviewUrl } = useStore();
  const { createTerminal, sendTerminalInput, sendTerminalResize, killTerminal } = useWebSocket();
  const autoOpenedPreview = useRef<Set<string>>(new Set());
  const outputRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>('terminal');

  const fontSize = Number(settings?.terminalFontSize ?? '13') || 13;
  const active = terminals.find((t) => t.id === activeTerminalId || t.clientRef === activeTerminalId);

  // Detect listening ports from terminal output (e.g. "localhost:3000").
  const ports = useMemo(() => {
    const found = new Map<string, string>(); // port → url
    const re = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/gi;
    for (const t of terminals) {
      const text = stripAnsi(t.buffer || getTerminalScrollback(t.id) || '');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const port = m[1];
        found.set(port, `http://localhost:${port}`);
      }
    }
    return Array.from(found.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
  }, [terminals]);

  // When a dev server appears (a port shows up in terminal output — including
  // servers the AGENT started), open it in the live Bubbly Preview once, so the
  // preview shows the running app as the agent works. Only auto-opens if the
  // preview isn't already showing something AND the server is actually
  // reachable — a port can linger in restored/stale terminal scrollback for a
  // server that has since been killed, and auto-loading that dead URL would
  // show a jarring "connection refused" in the preview. We probe with a
  // no-cors fetch (resolves opaquely if something responds, rejects on a
  // refused connection) and only mark the URL as handled once it opens, so a
  // server that comes up later can still trigger the auto-open.
  useEffect(() => {
    if (ports.length === 0 || previewUrl) return;
    const url = ports[0][1];
    if (autoOpenedPreview.current.has(url)) return;
    let cancelled = false;
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(), 2500);
    fetch(url, { mode: 'no-cors', signal: probe.signal })
      .then(() => {
        clearTimeout(timer);
        if (cancelled) return;
        if (!useStore.getState().previewUrl) {
          autoOpenedPreview.current.add(url);
          setPreviewUrl(url);
        }
      })
      .catch(() => { clearTimeout(timer); /* not reachable — don't auto-open */ });
    return () => { cancelled = true; clearTimeout(timer); probe.abort(); };
  }, [ports, previewUrl, setPreviewUrl]);

  // Auto-create a USER terminal the first time the Terminal section is shown.
  useEffect(() => {
    if (section !== 'terminal') return;
    const hasUserTerminal = terminals.some((t) => t.origin !== 'agent');
    if (!hasUserTerminal && workspacePath) createTerminal(workspacePath);
  }, [section, terminals, workspacePath, createTerminal]);

  useEffect(() => {
    if (active?.origin === 'agent' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [active?.origin, active?.buffer]);

  const sections: Array<{ id: Section; label: string; badge?: number }> = [
    { id: 'problems', label: 'Problems' },
    { id: 'output', label: 'Output' },
    { id: 'debug', label: 'Debug Console' },
    { id: 'terminal', label: 'Terminal', badge: terminals.length || undefined },
    { id: 'ports', label: 'Ports', badge: ports.length || undefined },
  ];

  return (
    <div className="flex flex-col h-full bg-surface-0 text-text">
      {/* Section tabs */}
      <div className="flex items-center gap-0.5 px-2 h-9 border-b border-border shrink-0 bg-surface-1 overflow-x-auto">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] uppercase tracking-wide font-medium whitespace-nowrap shrink-0 transition-colors ${
              section === s.id ? 'text-text bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-2'
            }`}
          >
            {s.label}
            {s.badge ? <span className="text-[9px] bg-surface-0 text-text-dim rounded-full px-1.5">{s.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {section === 'terminal' && (
          <div className="flex h-full">
            {/* Main: active terminal */}
            <div className="flex-1 min-w-0 relative">
              {!active && <div className="p-3 text-xs text-text-dim">No terminal. Click + to open one.</div>}

              {active && active.origin !== 'agent' && (
                <div className="absolute inset-0 flex flex-col">
                  {active.awaitingInput && active.alive && (
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-200 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                      <span className="truncate">Waiting for input: <span className="font-mono text-amber-100">{active.awaitingInput.prompt}</span></span>
                      {active.awaitingInput.suggestedReply && (
                        <button
                          onClick={() => sendTerminalInput(active.id, `${active.awaitingInput!.suggestedReply}\r`)}
                          className="ml-auto px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 transition-colors shrink-0"
                        >
                          Send "{active.awaitingInput.suggestedReply}"
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-h-0 px-2 py-1.5">
                    <XtermView
                      key={active.id}
                      terminalId={active.id}
                      fontSize={fontSize}
                      onData={(data) => sendTerminalInput(active.id, data)}
                      onResize={(cols, rows) => sendTerminalResize(active.id, cols, rows)}
                    />
                  </div>
                </div>
              )}

              {active && active.origin === 'agent' && (
                <div
                  ref={outputRef}
                  className="absolute inset-0 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words"
                  style={{ fontSize }}
                >
                  {stripAnsi(active.buffer || getTerminalScrollback(active.id))}
                </div>
              )}
            </div>

            {/* Right: terminal list (VS Code-style split list) */}
            <div className="w-48 shrink-0 border-l border-border bg-surface-1 flex flex-col">
              <div className="flex items-center justify-between px-2 h-7 border-b border-border shrink-0">
                <span className="text-[10px] uppercase tracking-wide text-text-dim font-medium">Terminals</span>
                <button
                  onClick={() => workspacePath && createTerminal(workspacePath)}
                  className="p-0.5 rounded text-text-dim hover:bg-surface-3 hover:text-text transition-colors"
                  title="New terminal"
                >
                  <Plus size={13} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {terminals.length === 0 && <div className="px-2 py-1 text-[11px] text-text-dim">No terminals</div>}
                {terminals.map((t) => {
                  const isActive = activeTerminalId === t.id || activeTerminalId === t.clientRef;
                  const isAgent = t.origin === 'agent';
                  return (
                    <div
                      key={t.clientRef}
                      onClick={() => setActiveTerminal(t.id)}
                      className={`group flex items-center gap-1.5 px-2 h-7 cursor-pointer text-xs transition-colors ${
                        isActive ? 'bg-surface-3 text-text' : 'text-text-dim hover:bg-surface-2'
                      }`}
                    >
                      {isAgent
                        ? <Bot size={12} className={t.alive ? 'text-violet-agent' : 'text-text-dim'} />
                        : <Terminal size={12} className={t.alive ? 'text-green-agent' : 'text-text-dim'} />}
                      <span className="truncate flex-1">{isAgent ? `AI: ${t.title}` : t.title}</span>
                      {t.awaitingInput && t.alive && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
                      <button
                        onClick={(e) => { e.stopPropagation(); isAgent ? closeTerminal(t.id) : killTerminal(t.id); }}
                        className="opacity-0 group-hover:opacity-100 hover:text-red-agent transition-opacity shrink-0"
                        title="Close"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {section === 'problems' && <ProblemsPane />}
        {section === 'output' && <OutputPane terminals={terminals} />}
        {section === 'debug' && (
          <EmptyPane title="Debug Console" message="Run a debug session to see output here. Debugging integration is coming soon." />
        )}
        {section === 'ports' && <PortsPane ports={ports} onOpenInPreview={setPreviewUrl} />}
      </div>
    </div>
  );
}

function EmptyPane({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <p className="text-sm text-text-muted font-medium mb-1">{title}</p>
      <p className="text-xs text-text-dim max-w-sm leading-relaxed">{message}</p>
    </div>
  );
}

function ProblemsPane() {
  const lastValidation = useStore((s) => s.lastValidation);
  if (!lastValidation || lastValidation.length === 0) {
    return <EmptyPane title="No problems detected" message="Validation issues from the agent's checks will appear here." />;
  }
  return (
    <div className="h-full overflow-y-auto p-2 text-xs font-mono space-y-1">
      {lastValidation.map((p, i) => (
        <div key={i} className="flex items-start gap-2 px-2 py-1 rounded hover:bg-surface-2">
          <span className={p.severity === 'error' ? 'text-red-agent' : 'text-amber-agent'}>
            {p.severity === 'error' ? '✕' : '⚠'}
          </span>
          <span className="text-text-dim">{p.file}{p.line ? `:${p.line}` : ''}</span>
          <span className="text-text-muted flex-1">{p.message}</span>
        </div>
      ))}
    </div>
  );
}

function OutputPane({ terminals }: { terminals: ReturnType<typeof useStore.getState>['terminals'] }) {
  const agent = terminals.filter((t) => t.origin === 'agent');
  if (agent.length === 0) {
    return <EmptyPane title="Output" message="Output from agent commands appears here. Run something and it'll show up." />;
  }
  return (
    <div className="h-full overflow-y-auto p-3 font-mono text-[12px] whitespace-pre-wrap break-words text-text-muted">
      {agent.map((t) => (
        <div key={t.clientRef} className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">AI: {t.title}</div>
          {stripAnsi(t.buffer || getTerminalScrollback(t.id))}
        </div>
      ))}
    </div>
  );
}

function PortsPane({ ports, onOpenInPreview }: { ports: Array<[string, string]>; onOpenInPreview: (url: string) => void }) {
  const [copied, setCopied] = React.useState<string | null>(null);
  if (ports.length === 0) {
    return <EmptyPane title="No forwarded ports" message="When a dev server prints a localhost URL, it'll be detected and listed here." />;
  }
  const openExternal = (url: string) => {
    const api = (window as any).bubblyDesktop;
    if (isDesktop() && api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank', 'noreferrer');
  };
  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => { setCopied(url); setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500); }).catch(() => {});
  };
  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="text-[10px] uppercase tracking-wide text-text-dim font-medium px-2 pb-1">Forwarded Ports · {ports.length}</div>
      {ports.map(([port, url]) => (
        <div key={port} className="group flex items-center gap-2 px-2 h-8 rounded hover:bg-surface-2 text-xs">
          <span className="w-2 h-2 rounded-full bg-green-agent shrink-0" title="Detected" />
          <span className="font-mono text-text w-14 shrink-0">{port}</span>
          <button onClick={() => onOpenInPreview(url)} className="font-mono text-accent-bright hover:underline truncate flex-1 text-left" title={`Open ${url} in Bubbly Preview`}>
            {url}
          </button>
          <button
            onClick={() => copy(url)}
            className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            title="Copy URL"
          >
            <Copy size={12} />
          </button>
          <button
            onClick={() => openExternal(url)}
            className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            title="Open in system browser"
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={() => onOpenInPreview(url)}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent-bright hover:bg-accent/25 transition-colors shrink-0"
            title="Open in Bubbly Preview"
          >
            <Monitor size={11} /> {copied === url ? 'Copied' : 'Preview'}
          </button>
        </div>
      ))}
    </div>
  );
}
