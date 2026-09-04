import React, { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { saveSettings, fetchOllamaModels, fetchOllamaStatus } from '../../hooks/useApi';
import { isDesktop } from '../../hooks/useDesktop';
import {
  Sparkles, FileCode, Terminal as TerminalIcon, Bot, RotateCcw, FolderOpen,
  CheckCircle, Loader2, RefreshCw, ChevronRight, ArrowLeft,
} from '../Shared/icons';
import { AnimatePresence, motion } from 'framer-motion';

type Provider = 'claude' | 'ollama' | 'gemini' | 'openrouter';
type StepId = 'welcome' | 'provider' | 'workspace' | 'tour' | 'done';
const STEPS: StepId[] = ['welcome', 'provider', 'workspace', 'tour', 'done'];
const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome', provider: 'Model', workspace: 'Project', tour: 'Tour', done: 'Ready',
};

/**
 * First-run onboarding. A guided, enterprise-style setup that gets a new user
 * from a blank install to a working agent: connect a model provider, choose a
 * workspace, and learn the core capabilities. It blocks the UI until completed
 * or skipped, and persists completion so it only appears once.
 */
export function Onboarding() {
  const { settings, setSettings, setWorkspacePath, setOnboardingComplete, setActivePanel } = useStore();
  const [step, setStep] = useState<StepId>('welcome');
  const [saving, setSaving] = useState(false);
  /** +1 advancing, -1 going back — drives the slide direction. */
  const [direction, setDirection] = useState(1);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Collected configuration.
  const [provider, setProvider] = useState<Provider>((settings?.defaultProvider as Provider) || 'claude');
  const [anthropicApiKey, setAnthropicApiKey] = useState(String(settings?.anthropicApiKey ?? ''));
  const [geminiApiKey, setGeminiApiKey] = useState(String(settings?.geminiApiKey ?? ''));
  const [openrouterApiKey, setOpenRouterApiKey] = useState(String(settings?.openrouterApiKey ?? ''));
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(String(settings?.ollamaBaseUrl ?? 'http://localhost:11434'));
  const [ollamaModel, setOllamaModel] = useState(String(settings?.ollamaModel ?? ''));
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaState, setOllamaState] = useState<'idle' | 'checking' | 'online' | 'offline'>('idle');
  const [workspacePath, setWsPath] = useState(String(settings?.workspacePath ?? ''));

  const idx = STEPS.indexOf(step);

  const checkOllama = async () => {
    setOllamaState('checking');
    try {
      // Test the URL the user TYPED (it isn't saved until they finish setup).
      const url = ollamaBaseUrl.trim() || undefined;
      const status = await fetchOllamaStatus(url).catch(() => null);
      const online = status?.running ?? status?.online ?? status?.ok ?? false;
      if (!online) { setOllamaState('offline'); return; }
      setOllamaState('online');
      const res = await fetchOllamaModels(url).catch(() => null);
      const models: string[] = res?.models ?? res ?? [];
      if (Array.isArray(models) && models.length > 0) {
        setOllamaModels(models);
        if (!ollamaModel) setOllamaModel(models[0]);
      }
    } catch {
      setOllamaState('offline');
    }
  };

  useEffect(() => {
    if (step === 'provider' && provider === 'ollama' && ollamaState === 'idle') checkOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, provider]);

  // Whether the current step lets the user advance.
  const canAdvance = (): boolean => {
    if (step === 'provider') {
      if (provider === 'claude') return anthropicApiKey.trim().length > 0;
      if (provider === 'gemini') return geminiApiKey.trim().length > 0;
      if (provider === 'openrouter') return openrouterApiKey.trim().length > 0;
      if (provider === 'ollama') return ollamaBaseUrl.trim().length > 0 && ollamaModel.trim().length > 0;
    }
    if (step === 'workspace') return workspacePath.trim().length > 0;
    return true;
  };

  const pickFolder = async () => {
    const folder = await window.bubblyDesktop?.pickFolder();
    if (folder) setWsPath(folder);
  };

  const finish = async (skipped = false) => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Record<string, string> = { defaultProvider: provider };
      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();
      if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();
      if (openrouterApiKey.trim()) payload.openrouterApiKey = openrouterApiKey.trim();
      if (ollamaBaseUrl.trim()) payload.ollamaBaseUrl = ollamaBaseUrl.trim();
      if (ollamaModel.trim()) payload.ollamaModel = ollamaModel.trim();
      if (workspacePath.trim()) payload.workspacePath = workspacePath.trim();

      if (!skipped) {
        // A failed save used to be swallowed: the `finally` completed onboarding
        // regardless, dropping the user into the app with no provider configured
        // and no idea why nothing worked. Surface it and stay put instead.
        const updated = await saveSettings(payload);
        if (updated && typeof updated === 'object') setSettings(updated as any);
        if (workspacePath.trim()) setWorkspacePath(workspacePath.trim());
      }
      setOnboardingComplete(true);
      setActivePanel('chat');
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? `Could not save your settings: ${err.message}. Check that the Bubbly backend is running, then try again.`
          : 'Could not save your settings. Check that the Bubbly backend is running, then try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (step === 'done') { finish(); return; }
    setDirection(1);
    setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)]);
  };
  const back = () => {
    setDirection(-1);
    setStep(STEPS[Math.max(idx - 1, 0)]);
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-surface-0 animate-fade-in">
      {/* Header: brand + a NAMED stepper. Anonymous dots tell you how far along
          you are but not what is coming; labels make the whole setup legible at
          a glance, and the current one is the only thing highlighted. */}
      <div className="flex items-center gap-3 px-6 sm:px-10 pt-6 shrink-0">
        <img src="/bubble.svg" alt="Bubbly" className="w-6 h-6" />
        <span className="text-sm font-semibold text-text">Bubbly</span>
        <div className="hidden sm:flex items-center gap-1 ml-4">
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <span className={`h-px w-4 transition-colors duration-300 ${i <= idx ? 'bg-accent/50' : 'bg-border'}`} />}
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors duration-300 ${
                  i === idx ? 'bg-accent/15 text-accent-bright font-medium'
                  : i < idx ? 'text-text-dim'
                  : 'text-text-dim/40'
                }`}
              >
                {STEP_LABELS[s]}
              </span>
            </React.Fragment>
          ))}
        </div>
        {/* Compact progress for narrow windows, where labels won't fit. */}
        <div className="flex sm:hidden items-center gap-1.5 ml-4">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1 rounded-full transition-all duration-300 ${i <= idx ? 'bg-accent w-6' : 'bg-surface-3 w-3'}`} />
          ))}
        </div>
        <button onClick={() => finish(true)} className="ml-auto text-xs text-text-dim hover:text-text transition-colors">Skip setup</button>
      </div>

      {/* Content: fills the screen; the step itself is centered in a readable
          column. Steps slide in the direction of travel so going Back feels
          like going back, not like a different screen appearing. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-6 py-8">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={{ opacity: 0, x: direction * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -24 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              {step === 'welcome' && <WelcomeStep />}
              {step === 'provider' && (
                <ProviderStep
                  provider={provider} setProvider={setProvider}
                  anthropicApiKey={anthropicApiKey} setAnthropicApiKey={setAnthropicApiKey}
                  geminiApiKey={geminiApiKey} setGeminiApiKey={setGeminiApiKey}
                  openrouterApiKey={openrouterApiKey} setOpenRouterApiKey={setOpenRouterApiKey}
                  ollamaBaseUrl={ollamaBaseUrl} setOllamaBaseUrl={setOllamaBaseUrl}
                  ollamaModel={ollamaModel} setOllamaModel={setOllamaModel}
                  ollamaModels={ollamaModels} ollamaState={ollamaState} onCheckOllama={checkOllama}
                />
              )}
              {step === 'workspace' && (
                <WorkspaceStep workspacePath={workspacePath} setWsPath={setWsPath} onPick={pickFolder} />
              )}
              {step === 'tour' && <TourStep />}
              {step === 'done' && <DoneStep provider={provider} workspacePath={workspacePath} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Footer: full-width bar, actions constrained to the same column */}
      <div className="border-t border-border bg-surface-1 shrink-0">
        <AnimatePresence>
          {saveError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="max-w-xl mx-auto w-full px-6 pt-3">
                <p className="text-xs text-red-agent bg-error-bg border border-red-agent/30 rounded-lg px-3 py-2">{saveError}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="max-w-xl mx-auto w-full flex items-center justify-between gap-2 px-6 py-4">
          <button onClick={back} disabled={idx === 0 || saving} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-text-dim hover:text-text disabled:opacity-30">
            <ArrowLeft size={15} /> Back
          </button>
          <button
            onClick={next}
            disabled={!canAdvance() || saving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-accent/20 text-accent-bright hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : null}
            {saving ? 'Saving…' : step === 'done' ? 'Start building' : 'Continue'}
            {step !== 'done' && !saving && <ChevronRight size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mb-4">
        <img src="/bubble.svg" alt="" className="w-8 h-8" />
      </div>
      <h2 className="text-xl font-semibold text-text">Bubbly</h2>
      <p className="mt-2 text-sm text-text-muted leading-relaxed">
        A coding agent that runs on your machine. Your code stays local, and it asks
        before it runs anything destructive. Three things to set up — about a minute.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2 text-left">
        <MiniFeature icon={<Sparkles size={14} />} title="Vibe mode" desc="Chat-driven building" />
        <MiniFeature icon={<FileCode size={14} />} title="Editor mode" desc="Full IDE with AI on the right" />
        <MiniFeature icon={<Bot size={14} />} title="Parallel agents" desc="Up to 4 working at once" />
        <MiniFeature icon={<RotateCcw size={14} />} title="Per-prompt revert" desc="Undo any prompt safely" />
      </div>
    </div>
  );
}

function MiniFeature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-surface-2 border border-border">
      <span className="text-accent-bright mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-text">{title}</p>
        <p className="text-[11px] text-text-dim leading-snug">{desc}</p>
      </div>
    </div>
  );
}

interface ProviderStepProps {
  provider: Provider; setProvider: (p: Provider) => void;
  anthropicApiKey: string; setAnthropicApiKey: (v: string) => void;
  geminiApiKey: string; setGeminiApiKey: (v: string) => void;
  openrouterApiKey: string; setOpenRouterApiKey: (v: string) => void;
  ollamaBaseUrl: string; setOllamaBaseUrl: (v: string) => void;
  ollamaModel: string; setOllamaModel: (v: string) => void;
  ollamaModels: string[]; ollamaState: 'idle' | 'checking' | 'online' | 'offline'; onCheckOllama: () => void;
}

function ProviderStep(p: ProviderStepProps) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text">Connect a model</h2>
      <p className="mt-1 text-sm text-text-muted">Choose where Bubbly's intelligence comes from. You can change this later in Settings.</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {(['claude', 'openrouter', 'ollama', 'gemini'] as Provider[]).map((id) => (
          <button
            key={id}
            onClick={() => p.setProvider(id)}
            className={`px-3 py-2.5 rounded-xl border text-sm font-medium capitalize transition-all ${
              p.provider === id ? 'border-accent bg-accent/10 text-accent-bright' : 'border-border text-text-muted hover:border-border-bright'
            }`}
          >
            {id === 'ollama' ? 'Ollama (local)' : id}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {p.provider === 'claude' && (
          <Labeled label="Anthropic API key" hint="From console.anthropic.com">
            <input type="password" value={p.anthropicApiKey} onChange={(e) => p.setAnthropicApiKey(e.target.value)} placeholder="sk-ant-..." className="input font-mono w-full" />
          </Labeled>
        )}
        {p.provider === 'gemini' && (
          <Labeled label="Google Gemini API key" hint="From aistudio.google.com">
            <input type="password" value={p.geminiApiKey} onChange={(e) => p.setGeminiApiKey(e.target.value)} placeholder="AIza..." className="input font-mono w-full" />
          </Labeled>
        )}
        {p.provider === 'openrouter' && (
          <Labeled label="OpenRouter API key" hint="From openrouter.ai/keys">
            <input type="password" value={p.openrouterApiKey} onChange={(e) => p.setOpenRouterApiKey(e.target.value)} placeholder="sk-or-v1-..." className="input font-mono w-full" />
          </Labeled>
        )}
        {p.provider === 'ollama' && (
          <>
            <Labeled label="Ollama URL">
              <div className="flex gap-2">
                <input value={p.ollamaBaseUrl} onChange={(e) => p.setOllamaBaseUrl(e.target.value)} className="input font-mono flex-1" />
                <button onClick={p.onCheckOllama} className="btn-ghost shrink-0 flex items-center gap-1">
                  {p.ollamaState === 'checking' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check
                </button>
              </div>
            </Labeled>
            {p.ollamaState === 'offline' && <p className="text-xs text-amber-agent">Couldn't reach Ollama. Make sure it's running, then Check again.</p>}
            {p.ollamaState === 'online' && <p className="text-xs text-green-agent flex items-center gap-1"><CheckCircle size={12} /> Connected</p>}
            <Labeled label="Model">
              {p.ollamaModels.length > 0 ? (
                <select value={p.ollamaModel} onChange={(e) => p.setOllamaModel(e.target.value)} className="input w-full">
                  {p.ollamaModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input value={p.ollamaModel} onChange={(e) => p.setOllamaModel(e.target.value)} placeholder="llama3.1" className="input font-mono w-full" />
              )}
            </Labeled>
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceStep({ workspacePath, setWsPath, onPick }: { workspacePath: string; setWsPath: (v: string) => void; onPick: () => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text">Choose your workspace</h2>
      <p className="mt-1 text-sm text-text-muted">The project folder Bubbly will work in. It only ever touches files inside this folder.</p>
      <div className="mt-4 flex gap-2">
        <input
          value={workspacePath}
          onChange={(e) => setWsPath(e.target.value)}
          placeholder={isDesktop() ? 'C:\\Users\\you\\my-project' : '/home/user/my-project'}
          className="input font-mono text-xs flex-1"
        />
        {isDesktop() && (
          <button onClick={onPick} className="btn-ghost shrink-0 flex items-center gap-1.5"><FolderOpen size={14} /> Browse…</button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-text-dim">Tip: pick a real project so the agent has code to work with. You can switch workspaces any time.</p>
    </div>
  );
}

function TourStep() {
  const items = [
    { icon: <Sparkles size={15} />, title: 'Vibe vs Editor', desc: 'Switch layouts from the tabs at the top. Vibe is chat-first; Editor gives you a full code editor with the AI docked on the right.' },
    { icon: <FileCode size={15} />, title: 'Spec sessions', desc: 'For bigger work, the agent writes a spec (requirements → design → tasks) and executes it task-by-task, staying locked to that plan.' },
    { icon: <Bot size={15} />, title: 'Parallel agents', desc: 'Independent work runs as up to 4 agents at once, each in its own lane — they never touch the same files.' },
    { icon: <TerminalIcon size={15} />, title: 'Real terminal', desc: 'A true integrated terminal. Dev servers run in the background so they never hang the agent, and prompts that need input are flagged.' },
    { icon: <RotateCcw size={15} />, title: 'Per-prompt revert', desc: 'Every prompt is snapshotted. Hover any message to roll the workspace back to before it — and the chat clears to match.' },
  ];
  return (
    <div>
      <h2 className="text-lg font-semibold text-text">A quick tour</h2>
      <p className="mt-1 text-sm text-text-muted">The essentials, so nothing feels hidden.</p>
      <div className="mt-3 space-y-2">
        {items.map((it) => (
          <div key={it.title} className="flex items-start gap-3 p-3 rounded-lg bg-surface-2 border border-border">
            <span className="text-accent-bright mt-0.5 shrink-0">{it.icon}</span>
            <div>
              <p className="text-sm font-medium text-text">{it.title}</p>
              <p className="text-xs text-text-dim leading-snug mt-0.5">{it.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DoneStep({ provider, workspacePath }: { provider: Provider; workspacePath: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-green-agent/10 border border-green-agent/20 flex items-center justify-center mb-4">
        <CheckCircle size={28} className="text-green-agent" />
      </div>
      <h2 className="text-xl font-semibold text-text">You're all set</h2>
      <p className="mt-2 text-sm text-text-muted leading-relaxed">
        Connected to <span className="text-text font-medium capitalize">{provider}</span>
        {workspacePath ? <> · working in <span className="text-text font-mono text-xs">{workspacePath.split(/[\\/]/).filter(Boolean).pop()}</span></> : null}.
        Describe what you want to build and Bubbly takes it from there.
      </p>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-muted mb-1">{label}{hint ? <span className="text-text-dim font-normal"> · {hint}</span> : null}</span>
      {children}
    </label>
  );
}
