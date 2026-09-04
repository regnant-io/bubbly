/**
 * MCP server manager.
 *
 * Reads the user's configured MCP servers from settings (`mcpServers` JSON),
 * connects the enabled ones, discovers their tools, and exposes them to the
 * agent as namespaced tool definitions (`mcp__<server>__<tool>`). Tool calls
 * are routed back to the owning server.
 *
 * Connections are lazy + cached: the first time tools are requested for a run
 * we connect any enabled servers; subsequent runs reuse live connections.
 */

import { StdioMcpClient, HttpMcpClient, type McpClient, type McpToolDef } from './client';
import { getSetting } from '../db/index';
import { logger } from '../utils/logger';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Static headers for remote (HTTP/SSE) servers — e.g. Authorization. */
  headers?: Record<string, string>;
  enabled: boolean;
}

/** An agent-facing tool definition (matches the shape used by TOOL_DEFINITIONS). */
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const PREFIX = 'mcp__';

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
}

/**
 * Normalize an MCP configuration of ANY common shape into our internal
 * McpServerConfig[]. This is what lets users paste configs from Claude Desktop,
 * Cursor, VS Code, Windsurf, etc. without reformatting. Accepted shapes:
 *
 *   1. Our native array:           [ { id, name, transport, command, ... } ]
 *   2. Claude/Cursor object form:  { "mcpServers": { "name": { command, args, env, disabled } } }
 *   3. VS Code form:               { "servers": { "name": { command|url, type } } }
 *   4. A bare keyed object:        { "name": { command, ... } }
 *
 * Per-server variations handled: `disabled` vs `enabled`, `type` vs
 * `transport` (stdio/sse/http), `url`/`serverUrl`/`endpoint` for remote,
 * `headers` for remote auth, `autoApprove` passthrough. Never throws.
 */
export function normalizeMcpConfigs(raw: unknown): McpServerConfig[] {
  if (raw == null) return [];

  // String → parse JSON first.
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try { value = JSON.parse(trimmed); } catch { return []; }
  }

  // Unwrap the common container keys.
  let entries: Array<{ key?: string; cfg: Record<string, unknown> }> = [];
  if (Array.isArray(value)) {
    entries = value
      .filter((v) => v && typeof v === 'object')
      .map((v) => ({ cfg: v as Record<string, unknown> }));
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const container =
      (obj.mcpServers && typeof obj.mcpServers === 'object' && obj.mcpServers) ||
      (obj.servers && typeof obj.servers === 'object' && obj.servers) ||
      obj;
    for (const [key, v] of Object.entries(container as Record<string, unknown>)) {
      if (v && typeof v === 'object') entries.push({ key, cfg: v as Record<string, unknown> });
    }
  }

  const out: McpServerConfig[] = [];
  const usedIds = new Set<string>();
  for (const { key, cfg } of entries) {
    const name = String(cfg.name ?? key ?? '').trim() || 'server';
    // Stable, unique id.
    let id = String(cfg.id ?? key ?? sanitizeName(name)) || sanitizeName(name);
    while (usedIds.has(id)) id = `${id}_2`;
    usedIds.add(id);

    // Transport: explicit `transport` or `type`; infer from url/command.
    const rawType = String(cfg.transport ?? cfg.type ?? '').toLowerCase();
    const url = (cfg.url ?? cfg.serverUrl ?? cfg.endpoint) as string | undefined;
    let transport: McpServerConfig['transport'];
    if (rawType === 'sse' || rawType === 'http' || rawType === 'streamable-http') transport = 'sse';
    else if (rawType === 'stdio') transport = 'stdio';
    else transport = url ? 'sse' : 'stdio';

    // enabled: respect either `enabled:false` or `disabled:true`.
    const enabled = cfg.enabled === false ? false : cfg.disabled === true ? false : true;

    const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : undefined;
    const env = (cfg.env && typeof cfg.env === 'object')
      ? Object.fromEntries(Object.entries(cfg.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    const headers = (cfg.headers && typeof cfg.headers === 'object')
      ? Object.fromEntries(Object.entries(cfg.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;

    out.push({
      id,
      name,
      transport,
      command: cfg.command != null ? String(cfg.command) : undefined,
      args,
      url: url != null ? String(url) : undefined,
      env,
      headers,
      enabled,
    });
  }
  return out;
}

interface LiveServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpToolDef[];
}

class McpManager {
  private servers = new Map<string, LiveServer>();
  /** toolName (namespaced) → { serverId, originalName } */
  private toolRoute = new Map<string, { serverId: string; original: string }>();

  parseConfigs(): McpServerConfig[] {
    try {
      const raw = getSetting('mcpServers') || '[]';
      return normalizeMcpConfigs(raw);
    } catch {
      return [];
    }
  }

  /** Connect (or reuse) all enabled stdio servers and refresh their tool lists. */
  async ensureConnected(): Promise<void> {
    const configs = this.parseConfigs().filter((c) => c.enabled);

    // Disconnect servers that were removed/disabled.
    for (const [id, live] of this.servers) {
      if (!configs.find((c) => c.id === id)) {
        live.client.close();
        this.servers.delete(id);
      }
    }

    for (const config of configs) {
      if (this.servers.get(config.id)?.client.isConnected) continue;

      // Build the right transport client. stdio = local command; sse = remote
      // Streamable-HTTP endpoint.
      let client: McpClient;
      if (config.transport === 'sse') {
        if (!config.url) { logger.warn('Remote MCP server has no url; skipping', { name: config.name }); continue; }
        client = new HttpMcpClient(config.url, config.headers ?? {});
      } else {
        if (!config.command) continue;
        client = new StdioMcpClient(config.command, config.args ?? [], config.env ?? {});
      }

      try {
        await client.connect();
        const tools = await client.listTools();
        this.servers.set(config.id, { config, client, tools });
        logger.info('MCP server connected', { name: config.name, transport: config.transport, toolCount: tools.length });
      } catch (err) {
        logger.warn('Failed to connect MCP server', { name: config.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.rebuildRoutes();
  }

  private rebuildRoutes(): void {
    this.toolRoute.clear();
    for (const [serverId, live] of this.servers) {
      const serverSlug = sanitizeName(live.config.name || serverId);
      for (const tool of live.tools) {
        const namespaced = `${PREFIX}${serverSlug}__${sanitizeName(tool.name)}`;
        this.toolRoute.set(namespaced, { serverId, original: tool.name });
      }
    }
  }

  /** Agent-facing tool definitions for all connected MCP tools. */
  getToolDefinitions(): AgentToolDef[] {
    const defs: AgentToolDef[] = [];
    for (const [serverId, live] of this.servers) {
      const serverSlug = sanitizeName(live.config.name || serverId);
      for (const tool of live.tools) {
        const namespaced = `${PREFIX}${serverSlug}__${sanitizeName(tool.name)}`;
        // Coerce the server's JSON Schema into our strict object shape. MCP
        // input schemas are always JSON-Schema objects; default safely if not.
        const raw = (tool.inputSchema && typeof tool.inputSchema === 'object') ? tool.inputSchema as Record<string, unknown> : {};
        const props = (raw.properties && typeof raw.properties === 'object') ? raw.properties as Record<string, unknown> : {};
        const required = Array.isArray(raw.required) ? (raw.required as string[]) : undefined;
        defs.push({
          name: namespaced,
          description: `[MCP: ${live.config.name}] ${tool.description ?? tool.name}`,
          inputSchema: { type: 'object', properties: props, ...(required ? { required } : {}) },
        });
      }
    }
    return defs;
  }

  isMcpTool(name: string): boolean {
    return name.startsWith(PREFIX);
  }

  /** Route a namespaced tool call to the owning server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const route = this.toolRoute.get(name);
    if (!route) return `Unknown MCP tool: ${name}`;
    const live = this.servers.get(route.serverId);
    if (!live || !live.client.isConnected) return `MCP server for "${name}" is not connected.`;
    try {
      return await live.client.callTool(route.original, args);
    } catch (err) {
      return `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** One-off connectivity test used by the Settings "Test connection" button. */
  async testConfig(config: McpServerConfig): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    let client: McpClient;
    if (config.transport === 'sse') {
      if (!config.url) return { ok: false, error: 'No URL specified for the remote server.' };
      client = new HttpMcpClient(config.url, config.headers ?? {});
    } else {
      if (!config.command) return { ok: false, error: 'No command specified.' };
      client = new StdioMcpClient(config.command, config.args ?? [], config.env ?? {});
    }
    try {
      await client.connect();
      const tools = await client.listTools();
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      client.close();
    }
  }

  closeAll(): void {
    for (const [, live] of this.servers) live.client.close();
    this.servers.clear();
    this.toolRoute.clear();
  }
}

export const mcpManager = new McpManager();
