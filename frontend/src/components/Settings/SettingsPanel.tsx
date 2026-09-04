import React, { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { ThemePicker } from './ThemePicker';
import { fetchSettings, fetchOllamaModels, fetchOllamaStatus, fetchGeminiModels, fetchOpenRouterModels, fetchModelContext, type ResolvedContext } from '../../hooks/useApi';
import type { Settings } from '../../types';
import {
  Settings as SettingsIcon, Check, AlertCircle, RefreshCw, Cpu, Zap, Sparkles,
  Sun, Moon, Monitor, Folder, Code2, SlidersHorizontal, Server, Puzzle, ShieldCheck, Palette, Plug,
} from '../Shared/icons';
import { isDesktop } from '../../hooks/useDesktop';
import { notifyDesktop } from '../../utils/notifications';
import { McpSettings } from './McpSettings';
import { SkillsSettings } from './SkillsSettings';
import { ConnectionsSettings } from './ConnectionsSettings';

interface ValidationError {
  field: string;
  message: string;
}

type CategoryId = 'general' | 'providers' | 'agent' | 'editor' | 'connections' | 'mcp' | 'skills' | 'safety';

const CATEGORIES: { id: CategoryId; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Palette size={15} /> },
  { id: 'providers', label: 'AI Providers', icon: <Sparkles size={15} /> },
  { id: 'agent', label: 'Agent', icon: <SlidersHorizontal size={15} /> },
  { id: 'editor', label: 'Editor & Terminal', icon: <Code2 size={15} /> },
  { id: 'connections', label: 'Connections', icon: <Plug size={15} /> },
  { id: 'mcp', label: 'MCP Servers', icon: <Server size={15} /> },
  { id: 'skills', label: 'Skills', icon: <Puzzle size={15} /> },
  { id: 'safety', label: 'Safety', icon: <ShieldCheck size={15} /> },
];

export function SettingsPanel() {
  const { settings, setSettings, setWorkspacePath, setTheme } = useStore();
  /**
   * Which category is open, honouring `#/settings/<category>`.
   *
   * A slash command that says "opens Settings on Connections" has to actually
   * land there — dropping the user on General and letting them find it is the
   * kind of nearly-working that makes a command surface feel unreliable. The
   * hash is also what makes a settings page linkable at all.
   */
  const [category, setCategory] = useState<CategoryId>(() => {
    const m = /^#\/settings\/([a-z]+)/.exec(typeof window === 'undefined' ? '' : window.location.hash);
    const wanted = m?.[1] as CategoryId | undefined;
    return wanted && CATEGORIES.some((c) => c.id === wanted) ? wanted : 'general';
  });

  React.useEffect(() => {
    const apply = () => {
      const m = /^#\/settings\/([a-z]+)/.exec(window.location.hash);
      const wanted = m?.[1] as CategoryId | undefined;
      if (wanted && CATEGORIES.some((c) => c.id === wanted)) setCategory(wanted);
    };
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
  const [form, setForm] = useState<Partial<Settings>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [openrouterModels, setOpenRouterModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualOllamaInput, setManualOllamaInput] = useState(false);
  const [manualGeminiInput, setManualGeminiInput] = useState(false);
  const [manualOpenRouterInput, setManualOpenRouterInput] = useState(false);
  // The context window a run would ACTUALLY use for the currently-selected
  // model, resolved server-side. Kept in sync with the live (unsaved) form so
  // the page never shows — or saves — a stale number.
  const [resolvedCtx, setResolvedCtx] = useState<ResolvedContext | null>(null);
  const [resolvingCtx, setResolvingCtx] = useState(false);

  useEffect(() => {
    fetchSettings().then((s: Settings) => {
      const cleaned: Partial<Settings> = {};
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'string') {
          cleaned[k as keyof Settings] = v.replace(/^["']|["']$/g, '') as any;
        } else {
          cleaned[k as keyof Settings] = v as any;
        }
      }
      setSettings(cleaned as Settings);
      setForm(cleaned);
      if (cleaned.workspacePath) setWorkspacePath(cleaned.workspacePath);
    });
  }, []);

  useEffect(() => {
    checkOllama();
    loadGeminiModels();
  }, []);

  // Re-resolve the effective context window whenever the model or any input
  // that feeds the calculation changes. Debounced so typing in the number
  // fields doesn't spray requests at the model host.
  useEffect(() => {
    const model = String(form.ollamaModel ?? '');
    if (!model) { setResolvedCtx(null); return; }
    let cancelled = false;
    setResolvingCtx(true);
    const t = setTimeout(() => {
      fetchModelContext({
        model,
        url: form.ollamaBaseUrl ? String(form.ollamaBaseUrl) : undefined,
        numCtx: form.ollamaNumCtx ?? '16384',
        ceiling: form.ollamaNumCtxCeiling ?? '32768',
        auto: form.ollamaAutoNumCtx !== 'false',
      })
        .then((r) => { if (!cancelled) setResolvedCtx(r); })
        .catch(() => { if (!cancelled) setResolvedCtx(null); })
        .finally(() => { if (!cancelled) setResolvingCtx(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.ollamaModel, form.ollamaBaseUrl, form.ollamaNumCtx, form.ollamaNumCtxCeiling, form.ollamaAutoNumCtx]);

  const checkOllama = async () => {
    try {
      const status = await fetchOllamaStatus();
      setOllamaRunning(status.running);
      if (status.running) {
        const models = await fetchOllamaModels();
        setOllamaModels(models.models ?? []);
      }
    } catch {
      setOllamaRunning(false);
    }
  };

  const loadGeminiModels = async () => {
    try {
      const res = await fetchGeminiModels();
      setGeminiModels(res.models ?? []);
    } catch {
      setGeminiModels([]);
    }
  };

  const loadOpenRouterModels = async () => {
    try {
      const res = await fetchOpenRouterModels();
      setOpenRouterModels(res.models ?? []);
    } catch {
      setOpenRouterModels([]);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const toSave: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v !== undefined && v !== null) {
          const stringValue = String(v).replace(/^["']|["']$/g, '');
          toSave[k] = stringValue;
        }
      }
      // Don't send masked keys back (would wipe the stored value).
      if (typeof toSave.anthropicApiKey === 'string' && toSave.anthropicApiKey.endsWith('...')) {
        delete toSave.anthropicApiKey;
      }
      if (typeof toSave.geminiApiKey === 'string' && toSave.geminiApiKey.endsWith('...')) {
        delete toSave.geminiApiKey;
      }
      if (typeof toSave.openrouterApiKey === 'string' && toSave.openrouterApiKey.endsWith('...')) {
        delete toSave.openrouterApiKey;
      }
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (result.errors && Array.isArray(result.errors)) {
          const errors: Record<string, string> = {};
          for (const err of result.errors as ValidationError[]) errors[err.field] = err.message;
          setFieldErrors(errors);
          setError('Please fix the validation errors below');
        } else {
          const errorMsg = typeof result.errors === 'string'
            ? result.errors
            : Array.isArray(result.errors) ? result.errors.join(', ') : 'Failed to save settings';
          setError(errorMsg);
        }
        return;
      }
      const updated = await fetchSettings();
      setSettings(updated);
      setForm(updated);
      if (updated.workspacePath) setWorkspacePath(updated.workspacePath);
      if (updated.theme) setTheme(updated.theme);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  const update = (key: keyof Settings, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: String(value) }));
  };

  // MCP/Skills manage their own persistence; they don't use the Save button.
  const showSaveBar = category !== 'mcp' && category !== 'skills';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <SettingsIcon size={14} className="text-accent-bright" />
        <span className="text-sm font-medium text-text">Settings</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Category nav */}
        <nav className="w-48 shrink-0 border-r border-border overflow-y-auto py-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors ${
                category === c.id
                  ? 'bg-accent/10 text-accent-bright border-r-2 border-accent'
                  : 'text-text-muted hover:bg-surface-3 hover:text-text'
              }`}
            >
              <span className="shrink-0">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto p-5 space-y-6">
            {category === 'general' && (
              <>
                <Section title="Appearance">
                  <Field
                    label="Theme"
                    hint="Every theme ships a light and a dark mode, so switching mode never changes which theme you are using."
                  >
                    <ThemePicker />
                  </Field>
                  <Field label="Mode">
                    <div className="flex gap-3">
                      {(['light', 'dark', 'system'] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => update('theme', t)}
                          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${
                            form.theme === t
                              ? 'border-accent bg-accent/10 text-accent-bright'
                              : 'border-border text-text-muted hover:border-border-bright'
                          }`}
                        >
                          {t === 'light' && <Sun size={14} />}
                          {t === 'dark' && <Moon size={14} />}
                          {t === 'system' && <Monitor size={14} />}
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </button>
                      ))}
                    </div>
                  </Field>
                </Section>

                <Section title="Workspace">
                  <Field label="Workspace Path" hint="Absolute path to your project directory" error={fieldErrors.workspacePath}>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className={`input font-mono text-xs flex-1 ${fieldErrors.workspacePath ? 'border-red-agent' : ''}`}
                        value={String(form.workspacePath ?? '')}
                        onChange={(e) => update('workspacePath', e.target.value)}
                        placeholder={isDesktop() ? 'C:\\Users\\you\\my-project' : '/home/user/my-project'}
                      />
                      {isDesktop() && (
                        <button
                          type="button"
                          onClick={async () => {
                            const folder = await window.bubblyDesktop?.pickFolder();
                            if (folder) update('workspacePath', folder);
                          }}
                          className="btn-ghost shrink-0 flex items-center gap-1.5"
                          title="Browse for a folder"
                        >
                          <Folder size={13} />
                          Browse
                        </button>
                      )}
                    </div>
                  </Field>
                </Section>
              </>
            )}

            {category === 'providers' && (
              <>
                <Section title="Default Provider">
                  <Field label="Provider">
                    <div className="flex gap-3">
                      {(['claude', 'ollama', 'gemini', 'openrouter'] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => update('defaultProvider', p)}
                          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${
                            form.defaultProvider === p
                              ? 'border-accent bg-accent/10 text-accent-bright'
                              : 'border-border text-text-muted hover:border-border-bright'
                          }`}
                        >
                          {p === 'claude' ? <Zap size={14} /> : p === 'gemini' ? <Sparkles size={14} /> : p === 'openrouter' ? <Sparkles size={14} /> : <Cpu size={14} />}
                          {p === 'claude' ? 'Claude' : p === 'gemini' ? 'Gemini' : p === 'openrouter' ? 'OpenRouter' : 'Ollama'}
                        </button>
                      ))}
                    </div>
                  </Field>
                </Section>

                <Section title="Claude / Anthropic">
                  <Field label="API Key" hint="Get yours at console.anthropic.com" error={fieldErrors.anthropicApiKey}>
                    <input
                      type="password"
                      className={`input font-mono ${fieldErrors.anthropicApiKey ? 'border-red-agent' : ''}`}
                      value={String(form.anthropicApiKey ?? '')}
                      onChange={(e) => update('anthropicApiKey', e.target.value)}
                      placeholder="sk-ant-..."
                    />
                  </Field>
                  <Field label="Model">
                    <select
                      className="input"
                      value={String(form.claudeModel ?? 'claude-sonnet-4-5')}
                      onChange={(e) => update('claudeModel', e.target.value)}
                    >
                      <option value="claude-opus-4-5">claude-opus-4-5 (most capable)</option>
                      <option value="claude-sonnet-4-5">claude-sonnet-4-5 (recommended)</option>
                      <option value="claude-haiku-4-5">claude-haiku-4-5 (fastest)</option>
                    </select>
                  </Field>
                </Section>

                <Section title="Google Gemini">
                  <Field label="API Key" hint="Get yours at aistudio.google.com/app/apikey" error={fieldErrors.geminiApiKey}>
                    <input
                      type="password"
                      className={`input font-mono ${fieldErrors.geminiApiKey ? 'border-red-agent' : ''}`}
                      value={String(form.geminiApiKey ?? '')}
                      onChange={(e) => update('geminiApiKey', e.target.value)}
                      placeholder="AIza..."
                      onBlur={loadGeminiModels}
                    />
                  </Field>
                  <Field label="Model" hint={geminiModels.length > 0 && !manualGeminiInput ? 'Double-click to type manually' : undefined}>
                    {geminiModels.length > 0 && !manualGeminiInput ? (
                      <select
                        className="input cursor-pointer"
                        value={String(form.geminiModel ?? 'gemini-2.0-flash')}
                        onChange={(e) => update('geminiModel', e.target.value)}
                        onDoubleClick={() => setManualGeminiInput(true)}
                      >
                        {geminiModels.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          className="input font-mono flex-1"
                          value={String(form.geminiModel ?? 'gemini-2.0-flash')}
                          onChange={(e) => update('geminiModel', e.target.value)}
                          placeholder="gemini-2.0-flash"
                        />
                        {geminiModels.length > 0 && manualGeminiInput ? (
                          <button onClick={() => setManualGeminiInput(false)} className="btn-ghost shrink-0 text-xs">Use Dropdown</button>
                        ) : (
                          <button onClick={loadGeminiModels} className="btn-ghost shrink-0 flex items-center gap-1"><RefreshCw size={12} />Load</button>
                        )}
                      </div>
                    )}
                  </Field>
                </Section>

                <Section title="OpenRouter">
                  <Field label="API Key" hint="Get yours at openrouter.ai/keys" error={fieldErrors.openrouterApiKey}>
                    <input
                      type="password"
                      className={`input font-mono ${fieldErrors.openrouterApiKey ? 'border-red-agent' : ''}`}
                      value={String(form.openrouterApiKey ?? '')}
                      onChange={(e) => update('openrouterApiKey', e.target.value)}
                      placeholder="sk-or-v1-..."
                      onBlur={loadOpenRouterModels}
                    />
                  </Field>
                  <Field label="Model" hint={openrouterModels.length > 0 && !manualOpenRouterInput ? 'Double-click to type manually' : undefined}>
                    {openrouterModels.length > 0 && !manualOpenRouterInput ? (
                      <select
                        className="input cursor-pointer"
                        value={String(form.openrouterModel ?? 'anthropic/claude-3.5-sonnet')}
                        onChange={(e) => update('openrouterModel', e.target.value)}
                        onDoubleClick={() => setManualOpenRouterInput(true)}
                      >
                        {openrouterModels.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          className="input font-mono flex-1"
                          value={String(form.openrouterModel ?? 'anthropic/claude-3.5-sonnet')}
                          onChange={(e) => update('openrouterModel', e.target.value)}
                          placeholder="anthropic/claude-3.5-sonnet"
                        />
                        {openrouterModels.length > 0 && manualOpenRouterInput ? (
                          <button onClick={() => setManualOpenRouterInput(false)} className="btn-ghost shrink-0 text-xs">Use Dropdown</button>
                        ) : (
                          <button onClick={loadOpenRouterModels} className="btn-ghost shrink-0 flex items-center gap-1"><RefreshCw size={12} />Load</button>
                        )}
                      </div>
                    )}
                  </Field>
                </Section>

                <Section title="Ollama (Local LLMs)">
                  <Field label="Ollama Base URL" error={fieldErrors.ollamaBaseUrl}>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className={`input font-mono flex-1 ${fieldErrors.ollamaBaseUrl ? 'border-red-agent' : ''}`}
                        value={String(form.ollamaBaseUrl ?? 'http://localhost:11434')}
                        onChange={(e) => update('ollamaBaseUrl', e.target.value)}
                      />
                      <button onClick={checkOllama} className="btn-ghost shrink-0 flex items-center gap-1"><RefreshCw size={12} />Check</button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className={`w-2 h-2 rounded-full ${ollamaRunning === null ? 'bg-text-dim' : ollamaRunning ? 'bg-green-agent' : 'bg-red-agent'}`} />
                      <span className="text-xs text-text-dim">{ollamaRunning === null ? 'Not checked' : ollamaRunning ? 'Running' : 'Not running'}</span>
                    </div>
                  </Field>

                  <Field label="Ollama Model" hint={ollamaModels.length > 0 && !manualOllamaInput ? 'Double-click to type manually' : undefined}>
                    {ollamaModels.length > 0 && !manualOllamaInput ? (
                      <select
                        className="input cursor-pointer"
                        value={String(form.ollamaModel ?? '')}
                        onChange={(e) => update('ollamaModel', e.target.value)}
                        onDoubleClick={() => setManualOllamaInput(true)}
                      >
                        {ollamaModels.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          className="input font-mono flex-1"
                          value={String(form.ollamaModel ?? 'llama3.1')}
                          onChange={(e) => update('ollamaModel', e.target.value)}
                          placeholder="llama3.1"
                        />
                        {ollamaModels.length > 0 && manualOllamaInput && (
                          <button onClick={() => setManualOllamaInput(false)} className="btn-ghost shrink-0 text-xs">Use Dropdown</button>
                        )}
                      </div>
                    )}
                  </Field>

                  <Toggle
                    label="Enable thinking mode"
                    hint="Show model's reasoning process (supported models only)"
                    checked={form.ollamaEnableThinking === 'true'}
                    onChange={(v) => update('ollamaEnableThinking', v)}
                  />

                  <Field
                    label={form.ollamaAutoNumCtx !== 'false' ? 'Minimum context window (num_ctx)' : 'Context window (num_ctx)'}
                    hint={form.ollamaAutoNumCtx !== 'false'
                      ? 'Auto-sizing is on, so this acts as a FLOOR — the model\'s own maximum is used when it\'s larger. The effective value is shown below.'
                      : 'Ollama\'s default (~4096) is often too small and causes responses to cut off. 16384+ recommended.'}
                  >
                    <input type="number" min="4096" max="131072" step="2048" className="input"
                      value={String(form.ollamaNumCtx ?? '16384')} onChange={(e) => update('ollamaNumCtx', e.target.value)} />
                  </Field>

                  <Toggle
                    label="Auto-size context window"
                    hint="Detect each model's real maximum context and use it (capped below). Strongly recommended."
                    checked={form.ollamaAutoNumCtx !== 'false'}
                    onChange={(v) => update('ollamaAutoNumCtx', v)}
                  />
                  <Field label="Auto context ceiling" hint="Upper bound when auto-sizing (memory safety). 32768 is a good balance.">
                    <input type="number" min="8192" max="262144" step="8192" className="input"
                      value={String(form.ollamaNumCtxCeiling ?? '32768')} onChange={(e) => update('ollamaNumCtxCeiling', e.target.value)} />
                  </Field>

                  {/* Live readout of the window a run would ACTUALLY use. This is
                      resolved server-side with the same logic the orchestrator
                      uses, against the current (unsaved) form values — so what
                      you see here is what saving will actually produce. */}
                  <EffectiveContext resolved={resolvedCtx} loading={resolvingCtx} model={String(form.ollamaModel ?? '')} />

                  <div className="mt-6 pt-6 border-t border-border">
                    <h4 className="text-xs font-semibold text-text-dim uppercase tracking-wider mb-3">Retry Configuration</h4>
                    <p className="text-xs text-text-dim mb-4">How Bubbly handles connection issues with Ollama (useful for cloud/unstable connections).</p>
                    <Field label="Max Retry Attempts" hint="1-10, default: 5" error={fieldErrors.ollamaRetryMaxAttempts}>
                      <input type="number" min="1" max="10" className={`input ${fieldErrors.ollamaRetryMaxAttempts ? 'border-red-agent' : ''}`}
                        value={String(form.ollamaRetryMaxAttempts ?? '5')}
                        onChange={(e) => { const val = parseInt(e.target.value, 10); if (val >= 1 && val <= 10) update('ollamaRetryMaxAttempts', String(val)); }} />
                    </Field>
                    <Field label="Initial Retry Delay (ms)" hint="100-5000ms, default: 1000ms" error={fieldErrors.ollamaRetryInitialDelayMs}>
                      <input type="number" min="100" max="5000" step="100" className={`input ${fieldErrors.ollamaRetryInitialDelayMs ? 'border-red-agent' : ''}`}
                        value={String(form.ollamaRetryInitialDelayMs ?? '1000')}
                        onChange={(e) => { const val = parseInt(e.target.value, 10); if (val >= 100 && val <= 5000) update('ollamaRetryInitialDelayMs', String(val)); }} />
                    </Field>
                    <Field label="Backoff Multiplier" hint="1.5-3.0, default: 2.0" error={fieldErrors.ollamaRetryBackoffMultiplier}>
                      <input type="number" min="1.5" max="3.0" step="0.1" className={`input ${fieldErrors.ollamaRetryBackoffMultiplier ? 'border-red-agent' : ''}`}
                        value={String(form.ollamaRetryBackoffMultiplier ?? '2')}
                        onChange={(e) => { const val = parseFloat(e.target.value); if (val >= 1.5 && val <= 3.0) update('ollamaRetryBackoffMultiplier', String(val)); }} />
                    </Field>
                    <Field label="Request timeout (ms)" hint="How long to wait for an Ollama response before aborting (30000–600000). Large local models may need more.">
                      <input type="number" min="30000" max="600000" step="10000" className="input"
                        value={String(form.ollamaRequestTimeoutMs ?? '300000')}
                        onChange={(e) => update('ollamaRequestTimeoutMs', e.target.value)} />
                    </Field>
                  </div>
                </Section>
              </>
            )}

            {category === 'agent' && (
              <Section title="Agent Behavior">
                <Toggle
                  label="Multi-agent spec execution"
                  hint="In Spec Sessions, dispatch a focused agent per task with progress tracking (recommended)"
                  checked={form.multiAgentSpec !== 'false'}
                  onChange={(v) => update('multiAgentSpec', v)}
                />
                <Toggle
                  label="Auto-validate changes"
                  hint="Run syntax/type checks after edits and feed errors back to the agent for repair"
                  checked={form.autoValidate !== 'false'}
                  onChange={(v) => update('autoValidate', v)}
                />
                <Field label="Vibe delegation threshold" hint="When the Vibe lead should spin up a worker instead of editing directly.">
                  <div className="flex gap-2">
                    {(['auto', 'always', 'never'] as const).map((s) => (
                      <button key={s} onClick={() => update('vibeWorkerThreshold', s)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm capitalize transition-all ${
                          (form.vibeWorkerThreshold ?? 'auto') === s ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
                        }`}>{s}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Context token budget" hint="History is compacted above this to keep long runs stable (8000–128000)">
                  <input type="number" min="8000" max="128000" step="1000" className="input"
                    value={String(form.contextTokenBudget ?? '24000')} onChange={(e) => update('contextTokenBudget', e.target.value)} />
                </Field>
                <Toggle
                  label="Auto context migration"
                  hint="Near the context limit, summarize and continue automatically in a fresh thread"
                  checked={form.autoContextMigration !== 'false'}
                  onChange={(v) => update('autoContextMigration', v)}
                />
                <Field label="Migration threshold" hint="Fraction of usable context at which to migrate (0.5–0.95)">
                  <input type="number" min="0.5" max="0.95" step="0.05" className="input"
                    value={String(form.contextMigrationThreshold ?? '0.85')} onChange={(e) => update('contextMigrationThreshold', e.target.value)} />
                </Field>
                <Field label="Max iterations per task" hint="How long a single task agent may work before handing back (10–100)">
                  <input type="number" min="10" max="100" className="input"
                    value={String(form.maxTaskIterations ?? '40')} onChange={(e) => update('maxTaskIterations', e.target.value)} />
                </Field>
                <Toggle
                  label="Spec docs as Markdown"
                  hint="Write requirements.md, design.md, and tasks.md to .bubbly/specs for each spec"
                  checked={form.specDocsAsMarkdown !== 'false'}
                  onChange={(v) => update('specDocsAsMarkdown', v)}
                />
              </Section>
            )}

            {category === 'editor' && (
              <>
                <Section title="Editor">
                  <Field label="Editor font size" hint="Monaco editor font size in px (10–24)">
                    <input type="number" min="10" max="24" className="input"
                      value={String(form.editorFontSize ?? '13')} onChange={(e) => update('editorFontSize', e.target.value)} />
                  </Field>
                  <Field label="Tab size" hint="Spaces per indentation level">
                    <div className="flex gap-2">
                      {['2', '4', '8'].map((s) => (
                        <button key={s} onClick={() => update('tabSize', s)}
                          className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-all ${
                            (form.tabSize ?? '2') === s ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
                          }`}>{s}</button>
                      ))}
                    </div>
                  </Field>
                  <Toggle label="Word wrap" hint="Wrap long lines in the editor" checked={form.wordWrap !== 'false'} onChange={(v) => update('wordWrap', v)} />
                  <Toggle label="Format on save" hint="Auto-format files when saved (where a formatter is available)" checked={form.formatOnSave === 'true'} onChange={(v) => update('formatOnSave', v)} />
                  <Toggle label="Auto save" hint="Automatically save edited files after a short delay" checked={form.autoSave === 'true'} onChange={(v) => update('autoSave', v)} />
                  <Field label="Streaming speed" hint="How fast assistant text is revealed">
                    <div className="flex gap-2">
                      {(['slow', 'normal', 'instant'] as const).map((s) => (
                        <button key={s} onClick={() => update('streamingSpeed', s)}
                          className={`flex-1 px-3 py-2 rounded-lg border text-sm capitalize transition-all ${
                            (form.streamingSpeed ?? 'normal') === s ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
                          }`}>{s}</button>
                      ))}
                    </div>
                  </Field>
                </Section>

                <Section title="Terminal">
                  <Field label="Terminal font size" hint="Integrated terminal font size in px (10–20)">
                    <input type="number" min="10" max="20" className="input"
                      value={String(form.terminalFontSize ?? '13')} onChange={(e) => update('terminalFontSize', e.target.value)} />
                  </Field>
                </Section>

                <Section title="Panels">
                  <Toggle
                    label="Reveal Changes panel after each diff"
                    hint="When on, the right panel pops open every time the agent edits a file. Off by default so it doesn't interrupt you mid-run."
                    checked={form.revealRightPanelOnDiff === 'true'}
                    onChange={(v) => update('revealRightPanelOnDiff', v)}
                  />
                </Section>

                <Section title="Notifications">
                  <Toggle
                    label="Desktop notifications"
                    hint="Get an OS notification when a run finishes, fails, or needs your approval — only while Bubbly is in the background."
                    checked={form.desktopNotifications !== 'false'}
                    onChange={(v) => update('desktopNotifications', v)}
                  />
                  <Toggle
                    label="Notify on failed commands"
                    hint="Also notify when an individual command the agent ran exits non-zero. Noisy: the agent usually recovers on its own."
                    checked={form.notifyOnCommandFailure === 'true'}
                    onChange={(v) => update('notifyOnCommandFailure', v)}
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void notifyDesktop({
                        title: 'Bubbly notifications are on',
                        body: 'This is what you’ll see when a run finishes while you’re in another app.',
                        force: true,
                      })}
                      className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-muted hover:border-border-bright hover:text-text transition-colors"
                    >
                      Send a test notification
                    </button>
                    <span className="text-xs text-text-dim">
                      {isDesktop()
                        ? 'Delivered through Windows notifications.'
                        : 'In the browser this uses web notifications — your browser may ask for permission.'}
                    </span>
                  </div>
                </Section>
              </>
            )}

            {category === 'connections' && <ConnectionsSettings />}
            {category === 'mcp' && <McpSettings value={String(form.mcpServers ?? '[]')} onChange={(v) => update('mcpServers', v)} />}
            {category === 'skills' && <SkillsSettings value={String(form.skills ?? '[]')} onChange={(v) => update('skills', v)} />}

            {category === 'safety' && (
              <>
              <Section title="Safety & Approvals">
                <Toggle
                  label="Require approval for file writes"
                  hint="Agent will ask before writing or deleting files"
                  checked={form.requireApprovalForWrites === 'true'}
                  onChange={(v) => update('requireApprovalForWrites', v)}
                />
                <Toggle
                  label="Require approval for shell commands"
                  hint="Agent will ask before running any shell command"
                  checked={form.requireApprovalForShell === 'true'}
                  onChange={(v) => update('requireApprovalForShell', v)}
                />
              </Section>

              <Section title="Computer Control (advanced)">
                <div className="mb-3 flex items-start gap-2 p-3 rounded-lg bg-warning-bg border border-amber-agent/30">
                  <AlertCircle size={15} className="text-amber-agent shrink-0 mt-0.5" />
                  <p className="text-xs text-text-muted leading-relaxed">
                    When enabled, a capable model can control your real <strong className="text-text">mouse, keyboard and screen</strong> (via PyAutoGUI)
                    to operate a browser or app. Every action that changes anything still requires your approval, and slamming the
                    mouse into a screen corner aborts instantly. Requires Python 3 with <code className="font-mono">pyautogui</code> installed.
                    Leave this off unless you specifically need it. <strong className="text-text">Prefer Browser Control below for web tasks.</strong>
                  </p>
                </div>
                <Toggle
                  label="Allow computer control"
                  hint="Let the agent drive the mouse/keyboard/screen (off by default)"
                  checked={form.computerControlEnabled === 'true'}
                  onChange={(v) => update('computerControlEnabled', v)}
                />
              </Section>

              <Section title="Browser Control">
                <div className="mb-3 flex items-start gap-2 p-3 rounded-lg bg-info-bg border border-blue-agent/30">
                  <AlertCircle size={15} className="text-blue-agent shrink-0 mt-0.5" />
                  <p className="text-xs text-text-muted leading-relaxed">
                    Gives the agent its <strong className="text-text">own dedicated browser window</strong> to navigate and operate — it never
                    touches your mouse or screen. The window is visible so you can watch it work, with a Bubbly cursor showing where it acts.
                    Safer than computer control (it's sandboxed to its own browser). Requires Playwright:
                    {' '}<code className="font-mono">npm i playwright</code> then <code className="font-mono">npx playwright install chromium</code>.
                  </p>
                </div>
                <Toggle
                  label="Allow browser control"
                  hint="Let the agent drive its own watchable browser (off by default)"
                  checked={form.browserControlEnabled === 'true'}
                  onChange={(v) => update('browserControlEnabled', v)}
                />
              </Section>
              </>
            )}

            {saved && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-agent/10 border border-green-agent/20">
                <Check size={16} className="text-green-agent shrink-0" />
                <p className="text-sm text-green-agent font-medium">Settings saved successfully!</p>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-agent/10 border border-red-agent/20">
                <AlertCircle size={16} className="text-red-agent shrink-0 mt-0.5" />
                <p className="text-sm text-red-agent">{error}</p>
              </div>
            )}

            {showSaveBar && (
              <button onClick={handleSave} disabled={loading} className="btn-primary flex items-center gap-2 w-full justify-center py-2.5">
                {loading ? 'Validating and saving…' : 'Save Settings'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-text-dim uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/**
 * Live "what will actually be used" readout for the context window.
 *
 * The agent resolves each model's real window at run time (model max, clamped
 * by the memory ceiling, floored by the configured value). Without this, the
 * settings page kept showing the configured number while runs used a different
 * one — and saving would persist the stale value. This resolves against the
 * CURRENT form state, so the number here is always the number that counts.
 */
function EffectiveContext({ resolved, loading, model }: { resolved: ResolvedContext | null; loading: boolean; model: string }) {
  if (!model) return null;

  const fmt = (n: number) => n.toLocaleString();
  const failed = resolved && !resolved.ok;

  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-text-dim uppercase tracking-wider">Effective context window</span>
        {loading && <span className="text-[11px] text-text-dim">resolving…</span>}
      </div>

      {failed ? (
        <p className="text-xs text-amber-agent mt-1.5">
          {resolved?.error ?? 'Could not resolve'} — the agent will fall back to your configured value.
        </p>
      ) : resolved?.ok ? (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold text-text tabular-nums">{fmt(resolved.numCtx ?? 0)}</span>
            <span className="text-xs text-text-dim">tokens</span>
            {resolved.cloud && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent-bright">cloud · uncapped</span>
            )}
          </div>
          <p className="text-xs text-text-dim mt-1.5 leading-relaxed">
            {resolved.source === 'model-max' && 'Detected from the model\'s own maximum.'}
            {resolved.source === 'configured' && 'Using your configured value.'}
            {resolved.source === 'default' && 'Using the built-in default.'}
            {resolved.modelMax ? ` Model max ${fmt(resolved.modelMax)}.` : ' Model max could not be probed.'}
            {resolved.ceiling != null ? ` Ceiling ${fmt(resolved.ceiling)}.` : ''}
          </p>
          {resolved.cappedByCeiling && (
            <p className="text-xs text-amber-agent mt-1.5">
              This model supports {fmt(resolved.modelMax ?? 0)} tokens but is capped at your ceiling. Raise the ceiling to use more.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-text-dim mt-1.5">Select a model to see its resolved window.</p>
      )}
    </div>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-text mb-1.5">{label}</label>
      {children}
      {error && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <AlertCircle size={12} className="text-red-agent shrink-0" />
          <p className="text-xs text-red-agent">{error}</p>
        </div>
      )}
      {!error && hint && <p className="text-xs text-text-dim mt-1">{hint}</p>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text">{label}</p>
        {hint && <p className="text-xs text-text-dim mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 inline-flex items-center h-6 w-11 rounded-full border transition-colors ${
          checked ? 'bg-accent border-accent' : 'bg-surface-3 border-border hover:border-border-bright'
        }`}
      >
        {/* Geometry stated, not inferred: 44px track, 1px border each side,
            16px knob, 3px inset at both ends → 22px of travel. */}
        <span className={`absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full shadow-md transition-[left,background-color] duration-150 ${
          checked ? 'left-[calc(100%-1.1rem)] bg-white' : 'left-[3px] bg-text-dim'
        }`} />
      </button>
    </div>
  );
}

// Re-exported so MCP/Skills sub-panels can reuse the same primitives.
export { Section, Field, Toggle };
