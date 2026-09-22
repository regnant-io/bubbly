import React, { useEffect, useMemo, useState } from 'react';
import { fetchUsageStats, type UsageStats } from '../../hooks/useApi';
import { useStore } from '../../store';
import { pickSuggestions, timeGreeting, type PromptSuggestion } from '../../utils/promptSuggestions';
import { Search, Bug, Zap, Wrench, ClipboardList, Plus, ChevronDown, ArrowUpRight } from '../Shared/icons';
import { BubblyMark } from '../Shared/BubblyMark';

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** Tint intensity for a heatmap cell, like a contribution graph. */
function heatClass(count: number, max: number): string {
  if (count === 0) return 'bg-surface-3';
  const ratio = count / Math.max(max, 1);
  if (ratio > 0.75) return 'bg-accent';
  if (ratio > 0.5) return 'bg-accent/70';
  if (ratio > 0.25) return 'bg-accent/45';
  return 'bg-accent/25';
}

function formatHour(h: number | null): string {
  if (h == null) return 'N/A';
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}

const CHIP_ICON: Record<PromptSuggestion['kind'], typeof Search> = {
  build: Plus,
  explore: Search,
  fix: Bug,
  test: Zap,
  refactor: Wrench,
  plan: ClipboardList,
};

/** Real usage totals, with optional detail and a ten-week activity heatmap. */
export function ActivityCard() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchUsageStats()
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Nothing to show and nothing loading: render nothing rather than an empty
  // card that says "—" three times.
  if (!loading && !stats) return null;

  const maxHeat = Math.max(1, ...(stats?.heatmap.map((h) => h.count) ?? [0]));
  const cells = (stats?.heatmap ?? Array.from({ length: 70 }, () => ({ date: '', count: 0 }))).slice(-70);

  const headline: Array<{ label: string; value: string }> = [
    { label: 'threads', value: stats ? String(stats.sessions) : 'N/A' },
    { label: 'messages', value: stats ? formatCompact(stats.messages) : 'N/A' },
    // The token count is a plain number. It used to be annotated with "×The
    // Hobbit", which is a joke that lands once and then sits on the screen
    // forever being neither informative nor funny.
    { label: 'tokens', value: stats ? formatCompact(stats.totalTokens) : 'N/A' },
  ];

  const detail: Array<{ label: string; value: string }> = [
    { label: 'Current streak', value: stats ? `${stats.currentStreak} days` : 'N/A' },
    { label: 'Longest streak', value: stats ? `${stats.longestStreak} days` : 'N/A' },
    { label: 'Active days', value: stats ? String(stats.activeDays) : 'N/A' },
    { label: 'Peak hour', value: stats ? formatHour(stats.peakHour) : 'N/A' },
  ];

  return (
    <div className="activity-summary" onKeyDown={(e) => { if (e.key === "Escape") setExpanded(false); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false); }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-surface-2 transition-colors"
        aria-expanded={expanded}
        aria-label="Usage analytics"
      >
        <div className="flex-1 grid grid-cols-3 gap-1 text-left">
          {headline.map((t) => (
            <div key={t.label}>
              {/*
                A placeholder the SIZE of the number it stands in for, not an
                ellipsis. "···" is narrower than "12.4K", so every stat visibly
                jumped sideways the moment the fetch landed — a three-column row
                snapping into place is exactly the kind of small wrongness that
                makes a UI feel unfinished without anyone being able to say why.
              */}
              <div className="h-[15px] flex items-center">
                {loading
                  ? <div className="skeleton" style={{ width: 34, height: 10, borderRadius: 999 }} />
                  : <span className="text-[15px] font-semibold text-text tabular-nums leading-none">{t.value}</span>}
              </div>
              <div className="text-[9px] uppercase tracking-wide text-text-dim mt-0.5">{t.label}</div>
            </div>
          ))}
        </div>
        <ChevronDown
          size={12}
          className={`shrink-0 text-text-dim transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="analytics-popover border border-border px-3 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-2">
            {detail.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] text-text-dim truncate">{d.label}</span>
                <span className="text-[11px] text-text-muted tabular-nums shrink-0">{d.value}</span>
              </div>
            ))}
          </div>

          {stats?.favoriteModel && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-text-dim">Most used</span>
              <span className="text-[11px] text-text-muted truncate">{stats.favoriteModel}</span>
            </div>
          )}

          <div>
            <div className="text-[9px] uppercase tracking-wide text-text-dim mb-1">Last 10 weeks</div>
            <div className="grid grid-flow-col grid-rows-7 gap-[3px] justify-start">
              {cells.map((d, i) => (
                <div
                  key={d.date || i}
                  title={d.date ? `${d.date}: ${d.count} event(s)` : undefined}
                  className={`w-[7px] h-[7px] rounded-[2px] ${loading ? 'bg-surface-3' : heatClass(d.count, maxHeat)}`}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The screen you see before the first message.
 *
 * ONE STABLE GREETING, NOT A ROTATING ONE
 *
 * The greeting and the prompt suggestions used to rotate on a timer, which
 * meant the text under the cursor changed while someone was reading it — and,
 * worse, the greeting changed every time the component re-rendered during a
 * prompt cycle, so it flickered between phrasings while the user typed. Both
 * are now computed ONCE per mount. Refreshing the suggestions is a button,
 * because a person who wants a different idea can ask for one.
 */
export function WelcomeScreen({ greetingName }: { greetingName?: string }) {
  const setChatDraft = useStore((s) => s.setChatDraft);

  // Computed once, deliberately: see the note above. `useState` with an
  // initialiser rather than `useMemo`, because useMemo is a performance hint
  // React is allowed to discard, and this needs to be a guarantee.
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [hello] = useState(() => timeGreeting());
  const suggestions = useMemo(() => pickSuggestions(seed, 4), [seed]);

  const workspacePath = useStore(s => s.workspacePath);
  const setActivePanel = useStore(s => s.setActivePanel);
  const project = workspacePath?.split(/[\\/]/).filter(Boolean).pop();
  const HINT: Record<PromptSuggestion['kind'], string> = {
    build: 'Create something new',
    fix: 'Find a path forward',
    explore: 'Understand the codebase',
    test: 'Ship with confidence',
    plan: 'Turn intent into a plan',
    refactor: 'Improve the foundations',
  };
  return (
    <div className="welcome-screen">
      <div className="welcome-content motion-rise">
        <div className="welcome-mark"><BubblyMark size={26} /></div>
        <p className="welcome-greeting">{hello}{greetingName ? `, ${greetingName}` : ''}</p>
        {project ? (
          <h1>What should we build in <span>{project}</span>?</h1>
        ) : (
          <>
            <h1>Pick a project to get started.</h1>
            <button className="welcome-connect" onClick={() => setActivePanel('workspace')}>
              <Plus size={14} /> Choose a workspace
            </button>
          </>
        )}
        <div className="suggestion-heading">
          <span>Try one of these</span>
          <button onClick={() => setSeed(s => s + 1)}>Shuffle</button>
        </div>
        <div key={seed} className="suggestion-grid motion-stagger">
          {suggestions.map(s => {
            const Icon = CHIP_ICON[s.kind];
            return (
              <button key={s.label} onClick={() => setChatDraft(s.prompt)} className="suggestion-item" title={s.prompt}>
                <Icon size={16} />
                <span><strong>{s.label}</strong><small>{HINT[s.kind]}</small></span>
                <ArrowUpRight size={14} className="suggestion-arrow" />
              </button>
            );
          })}
        </div>

        {/* Usage belongs to the home state, not every conversation header. */}
        <ActivityCard />
      </div>
    </div>
  );
}
