import { Router } from 'express';
import { getAllSettings, setSetting } from '../db/index';
import { listOllamaModels, listGeminiModels } from '../models/index';
import { resolveModelVision, resolveNumCtx, resolveModelContextLength, isOllamaCloudModel } from '../models/ollama';
import { ollamaNameLooksVision } from '../models/capabilities';
import { logger } from '../utils/logger';
import { validateSettings } from '../utils/settingsValidator';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  logger.info('Getting all settings');
  const settings = getAllSettings();
  // Mask API key
  const masked = { ...settings };
  if (masked.anthropicApiKey && masked.anthropicApiKey.length > 8) {
    masked.anthropicApiKey = masked.anthropicApiKey.slice(0, 8) + '...';
  }
  if (masked.geminiApiKey && masked.geminiApiKey.length > 8) {
    masked.geminiApiKey = masked.geminiApiKey.slice(0, 8) + '...';
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
  if (provider === 'claude' || provider === 'gemini') return res.json({ supportsVision: true, source: 'provider' });
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
