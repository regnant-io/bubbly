import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { fetchOllamaModels, fetchGeminiModels, fetchOpenRouterModels, saveSettings, fetchModelVision } from './useApi';
import type { Provider } from '../types';

export interface ModelOption {
  provider: Provider;
  /** Model id sent to the backend. */
  id: string;
  /** Human label shown in the menu. */
  label: string;
}

const CLAUDE_MODELS: string[] = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-3-5-haiku-latest',
];

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
};

/**
 * Name-based vision heuristic — mirrors backend capabilities.ts. This is only
 * the IMMEDIATE default shown while the accurate capability (resolved via the
 * backend's /api/show probe) is being fetched. Errs toward including known
 * vision families (llava, qwen-vl, minimax, gemma3, …).
 */
export function supportsVision(provider: Provider, model: string): boolean {
  if (provider === 'claude') return true;
  if (provider === 'gemini') return true;
  if (provider === 'openrouter') return true;
  if (provider === 'ollama') {
    return /llava|bakllava|moondream|minicpm-?v|pixtral|vision|\bvl\b|-vl\b|qwen2?\.?5?-?vl|internvl|cogvlm|llama3\.2.*vision|mllama|gemma3|granite3\.\d+-vision|minimax|\bgpt-4o|\bo3\b|phi-?3\.5?-?vision|phi-?4.*vision/i.test(model);
  }
  return false;
}

/**
 * Centralizes "what model is active" and "what can I switch to".
 *
 * Switching a model writes it back to settings (defaultProvider + that
 * provider's model field) so the choice persists and the next message uses it.
 * This keeps the source of truth in one place (settings) rather than threading
 * a per-message override through the websocket protocol.
 */
export function useModels() {
  const { settings, setSettings } = useStore();
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [openrouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const provider = (settings?.defaultProvider ?? 'claude') as Provider;
  const activeModel =
    provider === 'claude' ? settings?.claudeModel ?? ''
    : provider === 'gemini' ? settings?.geminiModel ?? ''
    : provider === 'openrouter' ? settings?.openrouterModel ?? ''
    : settings?.ollamaModel ?? '';

  // Accurate vision capability, resolved from the backend's /api/show probe.
  // null = not yet resolved → fall back to the name heuristic below.
  const [resolvedVision, setResolvedVision] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResolvedVision(null);
    if (!activeModel) return;
    // Claude/Gemini/OpenRouter are always vision; skip the round-trip.
    if (provider === 'claude' || provider === 'gemini' || provider === 'openrouter') { setResolvedVision(true); return; }
    fetchModelVision(provider, activeModel)
      .then((v) => { if (!cancelled) setResolvedVision(v); })
      .catch(() => { if (!cancelled) setResolvedVision(null); });
    return () => { cancelled = true; };
  }, [provider, activeModel]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [oll, gem, openr] = await Promise.allSettled([
        fetchOllamaModels(), 
        fetchGeminiModels(),
        fetchOpenRouterModels()
      ]);
      if (oll.status === 'fulfilled' && Array.isArray(oll.value?.models)) {
        setOllamaModels(oll.value.models.map((m: { name?: string } | string) => (typeof m === 'string' ? m : m.name ?? '')).filter(Boolean));
      }
      if (gem.status === 'fulfilled' && Array.isArray(gem.value?.models)) {
        setGeminiModels(gem.value.models.map((m: { name?: string } | string) => (typeof m === 'string' ? m : m.name ?? '')).filter(Boolean));
      }
      if (openr.status === 'fulfilled' && Array.isArray(openr.value?.models)) {
        setOpenRouterModels(openr.value.models.filter(Boolean));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build the full grouped option list, only including providers that are usable.
  const options: ModelOption[] = [];
  if (settings?.anthropicApiKey) {
    for (const id of CLAUDE_MODELS) options.push({ provider: 'claude', id, label: id });
  }
  if (settings?.geminiApiKey) {
    const list = geminiModels.length > 0 ? geminiModels : [settings.geminiModel].filter(Boolean);
    for (const id of list) options.push({ provider: 'gemini', id, label: id });
  }
  if (settings?.openrouterApiKey) {
    const list = openrouterModels.length > 0 ? openrouterModels : [settings.openrouterModel].filter(Boolean);
    for (const id of list) options.push({ provider: 'openrouter', id, label: id });
  }
  for (const id of ollamaModels) options.push({ provider: 'ollama', id, label: id });

  const selectModel = useCallback(
    async (opt: ModelOption) => {
      if (!settings) return;
      const field = opt.provider === 'claude' ? 'claudeModel' 
        : opt.provider === 'gemini' ? 'geminiModel' 
        : opt.provider === 'openrouter' ? 'openrouterModel'
        : 'ollamaModel';
      // Optimistic local update so the UI reflects the choice immediately.
      const next = { ...settings, defaultProvider: opt.provider, [field]: opt.id };
      setSettings(next);
      try {
        await saveSettings({ defaultProvider: opt.provider, [field]: opt.id });
      } catch (e) {
        console.warn('Failed to persist model selection', e);
      }
    },
    [settings, setSettings]
  );

  // Prefer the resolved capability; fall back to the name heuristic until it lands.
  const activeModelSupportsVision = resolvedVision ?? supportsVision(provider, activeModel);

  return {
    provider,
    providerLabel: PROVIDER_LABEL[provider],
    activeModel,
    activeModelSupportsVision,
    options,
    ollamaModels,
    geminiModels,
    openrouterModels,
    loading,
    refresh,
    selectModel,
    providerLabelOf: (p: Provider) => PROVIDER_LABEL[p],
  };
}
