import { Router } from 'express';
import { mcpManager } from '../mcp/manager';
import { logger } from '../utils/logger';

export const mcpRouter = Router();

/** Test a single MCP server config (used by the Settings "Test connection" button). */
mcpRouter.post('/test', async (req, res) => {
  const config = req.body;
  logger.info('Testing MCP server', { name: config?.name, transport: config?.transport });
  try {
    const result = await mcpManager.testConfig(config);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** List currently connected MCP tools (for diagnostics). */
mcpRouter.get('/tools', async (_req, res) => {
  try {
    await mcpManager.ensureConnected();
    res.json({ tools: mcpManager.getToolDefinitions() });
  } catch (err) {
    res.json({ tools: [], error: err instanceof Error ? err.message : String(err) });
  }
});
