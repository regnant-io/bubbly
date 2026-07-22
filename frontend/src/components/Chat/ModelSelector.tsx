import React, { useEffect, useRef, useState } from 'react';
import { useModels, type ModelOption } from '../../hooks/useModels';
import { Cpu, Sparkles, HardDrive, ChevronDown, Check, RefreshCw } from '../Shared/icons';
import type { Provider } from '../../types';

function providerIcon(p: Provider, size = 13) {
  if (p === 'claude') return <Cpu size={size} className="text-orange-400" />;
  if (p === 'gemini') return <Sparkles size={size} className="text-blue-400" />;
  return <HardDrive size={size} className="text-emerald-400" />;
}

/**
 * Compact model picker that lives inside the chat input. Lets the user switch
 * the active provider+model without opening Settings. The choice is persisted
 * (see useModels.selectModel) so the next message uses it.
 */
export function ModelSelector() {
  const { provider, activeModel, activeModelSupportsVision, options, loading, refresh, selectModel } = useModels();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Group options by provider for a tidy menu.
  const groups: Record<Provider, ModelOption[]> = { claude: [], gemini: [], ollama: [] };
  for (const o of options) groups[o.provider].push(o);

  const label = activeModel || 'Select model';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); if (!open) refresh(); }}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-text-dim hover:text-text hover:bg-surface-3 transition-colors max-w-[200px]"
        title={activeModelSupportsVision ? 'Switch model' : 'Switch model — this model has no vision support (can\'t read screenshots/images)'}
      >
        {providerIcon(provider)}
        <span className="truncate">{label}</span>
        {!activeModelSupportsVision && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-surface-3 text-text-dim shrink-0" title="No image/vision support">
            no vision
          </span>
        )}
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-72 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface-1 shadow-xl py-1">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">Model</span>
            <button
              onClick={(e) => { e.stopPropagation(); refresh(); }}
              className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text"
              title="Refresh model list"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {options.length === 0 && (
            <div className="px-3 py-3 text-xs text-text-dim">
              No models available. Add an API key or connect Ollama in Settings.
            </div>
          )}

          {(['claude', 'gemini', 'ollama'] as Provider[]).map((p) =>
            groups[p].length > 0 ? (
              <div key={p} className="py-0.5">
                <div className="flex items-center gap-1.5 px-3 py-1">
                  {providerIcon(p, 11)}
                  <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">{p}</span>
                </div>
                {groups[p].map((o) => {
                  const isActive = provider === o.provider && activeModel === o.id;
                  return (
                    <button
                      key={`${o.provider}:${o.id}`}
                      onClick={() => { selectModel(o); setOpen(false); }}
                      className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-xs text-left hover:bg-surface-3 transition-colors ${
                        isActive ? 'text-accent-bright' : 'text-text-muted'
                      }`}
                    >
                      <span className="truncate flex-1">{o.label}</span>
                      {isActive && <Check size={12} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
