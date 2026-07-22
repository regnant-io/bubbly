import React, { useMemo, useState } from 'react';
import { Server, Plus, Trash2, Check, AlertCircle, Plug } from '../Shared/icons';
import { saveSettings } from '../../hooks/useApi';

export interface McpServerConfig {
  id: string;
  name: string;
  /** "stdio" (command+args) or "sse"/"http" (url). */
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

interface McpSettingsProps {
  /** JSON string of McpServerConfig[]. */
  value: string;
  onChange: (json: string) => void;
}

function parse(value: string): McpServerConfig[] {
  try {
    const arr = JSON.parse(value || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function nanoid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * MCP (Model Context Protocol) server manager. Servers are stored as a JSON
 * array in the `mcpServers` setting. Each server exposes tools the agent can
 * call. We persist immediately (own Save button) so the backend can connect.
 */
export function McpSettings({ value, onChange }: McpSettingsProps) {
  const servers = useMemo(() => parse(value), [value]);
  const [saved, setSaved] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const commit = async (next: McpServerConfig[]) => {
    const json = JSON.stringify(next);
    onChange(json);
    try {
      await saveSettings({ mcpServers: json });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* surfaced elsewhere */ }
  };

  const addServer = () => {
    commit([
      ...servers,
      { id: nanoid(), name: 'New server', transport: 'stdio', command: '', args: [], env: {}, enabled: true },
    ]);
  };

  const updateServer = (id: string, patch: Partial<McpServerConfig>) => {
    commit(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeServer = (id: string) => commit(servers.filter((s) => s.id !== id));

  const testServer = async (s: McpServerConfig) => {
    setSavingId(s.id);
    try {
      const res = await fetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const data = await res.json();
      updateServer(s.id, { /* no-op, just to trigger re-render */ });
      alert(data.ok ? `Connected: ${data.toolCount ?? 0} tool(s) found` : `Failed: ${data.error ?? 'unknown error'}`);
    } catch (e) {
      alert(`Failed to reach backend: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold text-text-dim uppercase tracking-wider mb-1.5 flex items-center gap-2">
          <Server size={13} /> MCP Servers
        </h3>
        <p className="text-xs text-text-dim leading-relaxed">
          Connect Model Context Protocol servers to give the agent extra tools (databases, browsers, APIs).
          Use <span className="font-mono text-text-muted">stdio</span> for local commands or <span className="font-mono text-text-muted">sse</span> for remote URLs.
        </p>
      </div>

      {servers.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <Plug size={22} className="text-text-dim mx-auto mb-2" />
          <p className="text-sm text-text-muted">No MCP servers configured</p>
          <p className="text-xs text-text-dim mt-1">Add one to extend what Bubbly can do.</p>
        </div>
      )}

      <div className="space-y-3">
        {servers.map((s) => (
          <div key={s.id} className="rounded-xl border border-border bg-surface-1 p-3.5 space-y-3">
            <div className="flex items-center gap-2">
              <input
                value={s.name}
                onChange={(e) => updateServer(s.id, { name: e.target.value })}
                className="input flex-1 font-medium"
                placeholder="Server name"
              />
              <button
                onClick={() => updateServer(s.id, { enabled: !s.enabled })}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                  s.enabled ? 'border-green-agent/40 text-green-agent bg-green-agent/10' : 'border-border text-text-dim'
                }`}
                title={s.enabled ? 'Enabled' : 'Disabled'}
              >
                {s.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <button onClick={() => removeServer(s.id)} className="shrink-0 p-1.5 rounded-lg text-text-dim hover:text-red-agent hover:bg-surface-3" title="Remove">
                <Trash2 size={14} />
              </button>
            </div>

            <div className="flex gap-2">
              {(['stdio', 'sse'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => updateServer(s.id, { transport: t })}
                  className={`px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                    s.transport === t ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
                  }`}
                >
                  {t === 'stdio' ? 'Local (stdio)' : 'Remote (SSE/HTTP)'}
                </button>
              ))}
            </div>

            {s.transport === 'stdio' ? (
              <div className="space-y-2">
                <input
                  value={s.command ?? ''}
                  onChange={(e) => updateServer(s.id, { command: e.target.value })}
                  className="input font-mono text-xs"
                  placeholder="command (e.g. npx, uvx, node)"
                />
                <input
                  value={(s.args ?? []).join(' ')}
                  onChange={(e) => updateServer(s.id, { args: e.target.value.split(' ').filter(Boolean) })}
                  className="input font-mono text-xs"
                  placeholder="args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem .)"
                />
              </div>
            ) : (
              <input
                value={s.url ?? ''}
                onChange={(e) => updateServer(s.id, { url: e.target.value })}
                className="input font-mono text-xs"
                placeholder="https://server.example.com/sse"
              />
            )}

            <div className="flex justify-end">
              <button
                onClick={() => testServer(s)}
                disabled={savingId === s.id}
                className="btn-ghost text-xs flex items-center gap-1.5"
              >
                <Plug size={12} />
                {savingId === s.id ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <button onClick={addServer} className="btn-ghost w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-border rounded-xl">
        <Plus size={14} /> Add MCP server
      </button>

      {saved && (
        <div className="flex items-center gap-2 text-xs text-green-agent">
          <Check size={13} /> Saved
        </div>
      )}
      <p className="text-[11px] text-text-dim flex items-start gap-1.5">
        <AlertCircle size={12} className="shrink-0 mt-0.5" />
        MCP servers run external processes or connect to remote endpoints. Only add servers you trust.
      </p>
    </div>
  );
}
