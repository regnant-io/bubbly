import React, { useEffect, useMemo, useState } from 'react';
import { fetchUsageStats, type UsageStats } from '../../hooks/useApi';
import { useStore } from '../../store';
import { pickSuggestions, timeGreeting, type PromptSuggestion } from '../../utils/promptSuggestions';
import { Search, Bug, Zap, Wrench, ClipboardList, Plus } from '../Shared/icons';

const HOBBIT_TOKENS = 95_022; // ~The Hobbit's word count, used as a fun size comparison.

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** Tint intensity for a heatmap cell, like a GitHub contribution graph. */
function heatClass(count: number, max: number): string {
  if (count === 0) return 'bg-surface-3';
  const ratio = count / Math.max(max, 1);
  if (ratio > 0.75) return 'bg-accent';
  if (ratio > 0.5) return 'bg-accent/70';
  if (ratio > 0.25) return 'bg-accent/45';
  return 'bg-accent/25';
}

function formatHour(h: number | null): string {
  if (h == null) return '—';
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}

const CHIP_ICON: Record<PromptSuggestion['kind'], React.ComponentType<any>> = {
  build: Plus,
  explore: Search,
  fix: Bug,
  test: Zap,
  refactor: Wrench,
  plan: ClipboardList,
};

const CHIP_TINT: Record<PromptSuggestion['kind'], string> = {
  build: 'text-green-agent',
  explore: 'text-blue-agent',
  fix: 'text-red-agent',
  test: 'text-violet-agent',
  refactor: 'text-orange-agent',
  plan: 'text-accent-bright',
};

/**
 * Expanded activity dashboard — a calm, deliberate stat board rather than a
 * cramped corner card. Stat tiles up top, a contribution heatmap below.
 */
function ActivityBoard() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchUsageStats()
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const maxHeat = Math.max(1, ...(stats?.heatmap.map((h) => h.count) ?? [0]));
  // Trailing ~10 weeks, laid out as a GitHub-style grid (7 rows × N weeks).
  const cells = (stats?.heatmap ?? Array.from({ length: 70 }, () => ({ date: '', count: 0 }))).slice(-70);

  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: 'Sessions', value: stats ? String(stats.sessions) : '—' },
    { label: 'Messages', value: stats ? formatCompact(stats.messages) : '—' },
    { label: 'Tokens', value: stats ? formatCompact(stats.totalTokens) : '—', sub: stats && stats.totalTokens > 0 ? `${Math.max(1, Math.round(stats.totalTokens / HOBBIT_TOKENS))}× The Hobbit` : undefined },
    { label: 'Current streak', value: stats ? `${stats.currentStreak}d` : '—', sub: stats ? `best ${stats.longestStreak}d` : undefined },
    { label: 'Active days', value: stats ? String(stats.activeDays) : '—' },
    { label: 'Peak hour', value: stats ? formatHour(stats.peakHour) : '—', sub: stats?.favoriteModel ?? undefined },
  ];

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-text-dim">Your activity</h3>
        {stats?.favoriteModel && (
          <span className="text-[11px] text-text-dim">most-used · <span className="text-text-muted">{stats.favoriteModel}</span></span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-surface-1 px-3.5 py-3">
            <div className="text-[11px] text-text-dim">{t.label}</div>
            <div className="mt-1 text-xl font-semibold text-text tabular-nums leading-none">{loading ? '···' : t.value}</div>
            {t.sub && !loading && <div className="mt-1 text-[10px] text-text-dim truncate">{t.sub}</div>}
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-border bg-surface-1 px-3.5 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-text-dim">Last 10 weeks</span>
          <span className="text-[10px] text-text-dim flex items-center gap-1">
            less
            <span className="inline-flex gap-0.5">
              <span className="w-2 h-2 rounded-[3px] bg-surface-3" />
              <span className="w-2 h-2 rounded-[3px] bg-accent/25" />
              <span className="w-2 h-2 rounded-[3px] bg-accent/45" />
              <span className="w-2 h-2 rounded-[3px] bg-accent/70" />
              <span className="w-2 h-2 rounded-[3px] bg-accent" />
            </span>
            more
          </span>
        </div>
        <div className="grid grid-flow-col grid-rows-7 gap-1 justify-start">
          {cells.map((d, i) => (
            <div
              key={d.date || i}
              title={d.date ? `${d.date}: ${d.count} event(s)` : undefined}
              className={`w-2.5 h-2.5 rounded-[3px] ${loading ? 'bg-surface-3' : heatClass(d.count, maxHeat)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * New-session welcome. An activity board fills the space; the greeting and its
 * dynamic prompt chips sit bottom-left, directly above the composer, aligned to
 * the same column width as the input.
 */
export function WelcomeScreen({ greetingName }: { greetingName?: string }) {
  const setChatDraft = useStore((s) => s.setChatDraft);
  // Rotate the suggestion set gently so it feels alive without a timer storm.
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRotation((r) => r + 1), 12_000);
    return () => clearInterval(id);
  }, []);
  const suggestions = useMemo(() => pickSuggestions(rotation + 1, 4), [rotation]);
  const hello = useMemo(() => timeGreeting(), []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Activity board — fills the space above and scrolls on its own when the
          viewport is short, so it can never push the greeting off screen. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-4">
          <ActivityBoard />
        </div>
      </div>

      {/* Greeting + dynamic prompts — bottom-left, always pinned above the input */}
      <div className="shrink-0 mx-auto w-full max-w-3xl px-4 pt-2 pb-3">
        <p className="text-[13px] text-text-dim mb-1">{hello}{greetingName ? `, ${greetingName}` : ''}</p>
        <h2 className="text-[26px] leading-tight font-semibold text-text mb-4">
          What are we working on today?
        </h2>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => {
            const Icon = CHIP_ICON[s.kind];
            return (
              <button
                key={s.label}
                onClick={() => setChatDraft(s.prompt)}
                className="group inline-flex items-center gap-2 rounded-lg border border-border bg-surface-1 hover:bg-surface-2 hover:border-border-bright px-3 py-2 text-[13px] text-text-muted hover:text-text transition-colors"
                title={s.prompt}
              >
                <Icon size={14} className={`${CHIP_TINT[s.kind]} shrink-0`} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
