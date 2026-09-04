import { Router } from 'express';
import { getAllSettings, setSetting } from '../db/index';
import { listOllamaModels, listGeminiModels, listOpenRouterModels, getOpenRouterModelContext } from '../models/index';
import { resolveModelVision, resolveNumCtx, resolveModelContextLength, isOllamaCloudModel } from '../models/ollama';
import { ollamaNameLooksVision } from '../models/capabilities';
import { logger } from '../utils/logger';
import { validateSettings } from '../utils/settingsValidator';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  logger.info('Getting all settings');
  const settings = getAllSettings();
  // Mask API keys
  const masked = { ...settings };
  if (masked.anthropicApiKey && masked.anthropicApiKey.length > 8) {
    masked.anthropicApiKey = masked.anthropicApiKey.slice(0, 8) + '...';
  }
  if (masked.geminiApiKey && masked.geminiApiKey.length > 8) {
    masked.geminiApiKey = masked.geminiApiKey.slice(0, 8) + '...';
  }
  if (masked.openrouterApiKey && masked.openrouterApiKey.length > 8) {
    masked.openrouterApiKey = masked.openrouterApiKey.slice(0, 8) + '...';
  }
  res.json(masked);
});

settingsRouter.put('/', async (req, res) => {
  const updates = req.body as Record<string, string>;
  logger.info('Updating settings', { keys: Object.keys(updates) });
  
  // Get current settings for comparison
  const currentSettings = getAllSettings();
  
  // Validate all settings
  const validation = await validateSettings(updates, currentSettings);
  
  if (!validation.valid) {
    logger.warn('Settings validation failed', { errors: validation.errors });
    return res.status(400).json({ 
      ok: false, 
      errors: validation.errors 
    });
  }
  
  // Save all valid settings
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'string') {
      setSetting(key, value);
    }
  }
  
  logger.info('Settings updated successfully');
  res.json({ ok: true });
});

settingsRouter.get('/gemini/models', async (_req, res) => {
  const settings = getAllSettings();
  const apiKey = settings.geminiApiKey || '';
  logger.info('Listing Gemini models');
  try {
    const models = await listGeminiModels(apiKey);
    res.json({ models });
  } catch (err) {
    logger.error('Failed to list Gemini models', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({ models: [] });
  }
});

settingsRouter.get('/openrouter/models', async (_req, res) => {
  const settings = getAllSettings();
  const apiKey = settings.openrouterApiKey || '';
  logger.info('Listing OpenRouter models');
  try {
    const models = await listOpenRouterModels(apiKey);
    res.json({ models });
  } catch (err) {
    logger.error('Failed to list OpenRouter models', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({ models: [] });
  }
});

settingsRouter.get('/openrouter/context', async (req, res) => {
  const settings = getAllSettings();
  const apiKey = settings.openrouterApiKey || '';
  const model = String(req.query.model || '');
  
  if (!model) {
    return res.json({ ok: false, error: 'No model specified' });
  }
  
  logger.info('Getting OpenRouter model context', { model });
  try {
    const contextLength = await getOpenRouterModelContext(apiKey, model);
    if (contextLength) {
      res.json({ ok: true, model, contextLength });
    } else {
      res.json({ ok: false, error: 'Could not resolve context length' });
    }
  } catch (err) {
    logger.error('Failed to get OpenRouter model context', {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({ ok: false, error: 'Failed to fetch model context' });
  }
});

settingsRouter.get('/ollama/models', async (req, res) => {
  const settings = getAllSettings();
  // Allow ?url= so setup flows can test a URL BEFORE it is saved.
  const baseUrl = (typeof req.query.url === 'string' && req.query.url.trim())
    || settings.ollamaBaseUrl
    || 'http://localhost:11434';
  logger.info('Listing Ollama models', { baseUrl });
  
  try {
    const models = await listOllamaModels(baseUrl);
    res.json({ models });
  } catch (err) {
    logger.error('Failed to list Ollama models', { 
      baseUrl, 
      error: err instanceof Error ? err.message : String(err) 
    });
    res.json({ models: [] });
  }
});

/**
 * GET /api/settings/model/vision?provider=&model=
 * Resolve whether a model supports image input. For Ollama this queries the
 * model's REAL capabilities via /api/show (accurate for models like minimax
 * whose name doesn't reveal vision support); Claude/Gemini are always vision.
 * Falls back to the name heuristic when the probe is inconclusive.
 */
settingsRouter.get('/model/vision', async (req, res) => {
  const provider = String(req.query.provider || 'claude');
  const model = String(req.query.model || '');
  if (provider === 'claude' || provider === 'gemini' || provider === 'openrouter') return res.json({ supportsVision: true, source: 'provider' });
  const settings = getAllSettings();
  const baseUrl = settings.ollamaBaseUrl || 'http://localhost:11434';
  try {
    const resolved = await resolveModelVision(baseUrl, model);
    if (resolved !== null) return res.json({ supportsVision: resolved, source: 'api/show' });
  } catch { /* fall through to heuristic */ }
  res.json({ supportsVision: ollamaNameLooksVision(model), source: 'heuristic' });
});

/**
 * GET /api/settings/model/context?model=&url=&numCtx=&ceiling=&auto=
 *
 * Resolve the EFFECTIVE context window a run would actually use for a model,
 * using the exact same logic as the orchestrator (resolveNumCtx). The settings
 * UI calls this whenever the model / ceiling / auto-size inputs change so the
 * page always shows the real resolved window instead of a stale configured
 * number — otherwise saving settings would persist a value that isn't what the
 * agent runs with.
 *
 * Query params mirror the unsaved FORM state so the readout reflects what the
 * user is currently looking at, not what's already in the DB.
 */
settingsRouter.get('/model/context', async (req, res) => {
  const settings = getAllSettings();
  const model = String(req.query.model || settings.ollamaModel || '');
  const baseUrl = (typeof req.query.url === 'string' && req.query.url.trim())
    || settings.ollamaBaseUrl
    || 'http://localhost:11434';

  // Auto-sizing on unless explicitly disabled (matches orchestrator default).
  const autoRaw = req.query.auto;
  const auto = autoRaw === undefined
    ? settings.ollamaAutoNumCtx !== 'false'
    : String(autoRaw) !== 'false';

  const num = (v: unknown, fallback: number): number => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const configuredNumCtx = num(req.query.numCtx, num(settings.ollamaNumCtx, 16384));
  const ceiling = num(req.query.ceiling, num(settings.ollamaNumCtxCeiling, 32768));

  if (!model) {
    return res.json({ ok: false, error: 'No model specified' });
  }

  try {
    const modelMax = await resolveModelContextLength(baseUrl, model);
    const cloud = isOllamaCloudModel(model);

    // Auto OFF → the configured number is used verbatim. Auto ON → mirror the
    // orchestrator by handing the ceiling to resolveNumCtx.
    const resolved = auto
      ? await resolveNumCtx({ baseUrl, model, configuredNumCtx, ceiling })
      : { numCtx: configuredNumCtx, source: 'configured' as const };

    res.json({
      ok: true,
      model,
      numCtx: resolved.numCtx,
      source: resolved.source,
      modelMax,
      // Cloud models are served remotely, so the local memory ceiling doesn't apply.
      ceiling: cloud ? null : ceiling,
      cloud,
      auto,
      // True when the model could go bigger but the memory ceiling held it back.
      cappedByCeiling: auto && !cloud && !!modelMax && modelMax > ceiling && resolved.numCtx === ceiling,
    });
  } catch (err) {
    logger.warn('Failed to resolve model context window', {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({ ok: false, error: 'Could not reach the model to resolve its context window' });
  }
});

settingsRouter.get('/ollama/status', async (req, res) => {
  const settings = getAllSettings();
  const baseUrl = (typeof req.query.url === 'string' && req.query.url.trim())
    || settings.ollamaBaseUrl
    || 'http://localhost:11434';
  logger.info('Checking Ollama status', { baseUrl });
  
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
    const running = resp.ok;
    logger.info('Ollama status checked', { baseUrl, running });
    res.json({ running });
  } catch (err) {
    logger.warn('Ollama status check failed', { 
      baseUrl, 
      error: err instanceof Error ? err.message : String(err) 
    });
    res.json({ running: false });
  }
});

/**
 * The full skill catalogue, for the Settings page.
 *
 * Returns built-ins and user skills together with their enabled state and
 * category, but WITHOUT the instructions body — the list view shows a name, a
 * description and a toggle, and shipping fifty multi-paragraph instruction
 * blocks to render three lines each is a slow page for no reason. The body is
 * fetched per skill when one is expanded.
 */
settingsRouter.get('/skills', (_req, res) => {
  try {
    const { skillsForSettings } = require('../agent/skills') as typeof import('../agent/skills');
    const { SKILL_CATEGORY_LABELS } = require('../agent/builtinSkills') as typeof import('../agent/builtinSkills');
    const skills = skillsForSettings().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category ?? 'practice',
      enabled: s.enabled,
      builtin: !!s.builtin,
      alwaysOn: !!s.alwaysOn,
      triggers: s.keywords ?? [],
      fileHints: s.fileHints ?? [],
      instructionsLength: s.instructions.length,
    }));
    res.json({ skills, categories: SKILL_CATEGORY_LABELS });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** One skill's full instructions, for the expanded view. */
settingsRouter.get('/skills/:id', (req, res) => {
  try {
    const { skillsForSettings } = require('../agent/skills') as typeof import('../agent/skills');
    const skill = skillsForSettings().find((s) => s.id === req.params.id);
    if (!skill) { res.status(404).json({ error: 'No such skill.' }); return; }
    res.json({ skill });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Turn a built-in skill on or off.
 *
 * Built-ins are never deleted — only disabled — so this is the whole write API
 * for them. User skills continue to be edited through the `skills` setting.
 */
settingsRouter.post('/skills/:id/enabled', (req, res) => {
  try {
    const { toggleBuiltinSkill } = require('../agent/skills') as typeof import('../agent/skills');
    const { BUILTIN_SKILL_IDS } = require('../agent/builtinSkills') as typeof import('../agent/builtinSkills');
    const id = req.params.id;
    if (!BUILTIN_SKILL_IDS.has(id)) {
      res.status(400).json({
        error: 'That is a user skill — edit it in the Skills editor rather than toggling it here.',
      });
      return;
    }
    const enabled = req.body?.enabled !== false;
    const disabled = toggleBuiltinSkill(id, enabled);
    setSetting('disabledBuiltinSkills', JSON.stringify(disabled));
    res.json({ ok: true, id, enabled, disabledCount: disabled.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * The workflow catalogue — what the slash-command picker renders.
 *
 * Served from the backend rather than duplicated in the client so that the
 * desktop app and the CLI cannot disagree about what commands exist or what
 * arguments they take.
 */
/**
 * The CLIENT-side slash commands, catalogued in one place.
 *
 * Served rather than hard-coded in each client for the same reason workflows
 * are: there are two clients, and two copies of a command list drift within a
 * week. `surface` filters to the ones that actually do something where they are
 * being shown — `/bg` needs a terminal, `/paste` needs a composer and a
 * clipboard — because a menu entry that does nothing is worse than one that is
 * missing. See agent/clientCommands.ts.
 */
/**
 * Every tool the agent can call.
 *
 * `/tools` in the terminal and the tool list in the app both need this, and
 * both were previously reduced to whatever the person writing them remembered.
 * TOOL_DEFINITIONS is the actual registry the agent is handed, so serving it is
 * the only version that cannot be out of date.
 */
settingsRouter.get('/tools', (_req, res) => {
  try {
    const { TOOL_DEFINITIONS } = require('../agent/tools/index') as typeof import('../agent/tools/index');
    res.json({
      tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

settingsRouter.get('/commands', (req, res) => {
  try {
    const { commandsFor, CLIENT_COMMANDS } = require('../agent/clientCommands') as typeof import('../agent/clientCommands');
    const surface = req.query.surface === 'cli' ? 'cli' : req.query.surface === 'desktop' ? 'desktop' : null;
    res.json({ commands: surface ? commandsFor(surface) : CLIENT_COMMANDS });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

settingsRouter.get('/workflows', (_req, res) => {
  try {
    const { workflowCatalogue } = require('../agent/workflows') as typeof import('../agent/workflows');
    res.json({ workflows: workflowCatalogue() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
