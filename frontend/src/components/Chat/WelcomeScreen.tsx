import React, { useEffect, useMemo, useState } from 'react';
import { fetchUsageStats, type UsageStats } from '../../hooks/useApi';
import { useStore } from '../../store';
import { pickSuggestions, timeGreeting, type PromptSuggestion } from '../../utils/promptSuggestions';
import { BubblyMark } from '../Shared/BubblyMark';
import { Search, Bug, Zap, Wrench, ClipboardList, Plus, ChevronDown } from '../Shared/icons';

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
  if (h == null) return '—';
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

const CHIP_TINT: Record<PromptSuggestion['kind'], string> = {
  build: 'text-green-agent',
  explore: 'text-blue-agent',
  fix: 'text-red-agent',
  test: 'text-violet-agent',
  refactor: 'text-orange-agent',
  plan: 'text-accent-bright',
};

/**
 * Activity, as a compact card in the corner.
 *
 * WHY IT MOVED AND SHRANK
 *
 * This used to be a full-width dashboard occupying everything above the
 * composer — six stat tiles and a ten-week heatmap, on the screen you see every
 * time you start a thread. That is a lot of furniture in front of the one thing
 * the screen is for, which is typing the first message. Nobody opens Bubbly to
 * read their own statistics.
 *
 * So it is a card in the top-right, collapsed to three numbers, expanding on
 * click for the rest. Present for whoever wants it, out of the way for everyone
 * else, and the greeting and the composer get the middle of the screen back.
 */
function ActivityCard() {
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
    { label: 'threads', value: stats ? String(stats.sessions) : '—' },
    { label: 'messages', value: stats ? formatCompact(stats.messages) : '—' },
    // The token count is a plain number. It used to be annotated with "×The
    // Hobbit", which is a joke that lands once and then sits on the screen
    // forever being neither informative nor funny.
    { label: 'tokens', value: stats ? formatCompact(stats.totalTokens) : '—' },
  ];

  const detail: Array<{ label: string; value: string }> = [
    { label: 'Current streak', value: stats ? `${stats.currentStreak} days` : '—' },
    { label: 'Longest streak', value: stats ? `${stats.longestStreak} days` : '—' },
    { label: 'Active days', value: stats ? String(stats.activeDays) : '—' },
    { label: 'Peak hour', value: stats ? formatHour(stats.peakHour) : '—' },
  ];

  return (
    <div className="w-[260px] card bg-surface-1 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-surface-2 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex-1 grid grid-cols-3 gap-1 text-left">
          {headline.map((t) => (
            <div key={t.label}>
              <div className="text-[15px] font-semibold text-text tabular-nums leading-none">
                {loading ? '···' : t.value}
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
        <div className="border-t border-border px-3 py-2.5 space-y-2.5">
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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Activity, top-right and out of the way. */}
      <div className="shrink-0 flex justify-end pl-4 pr-14 pt-3">
        <ActivityCard />
      </div>

      {/* The middle belongs to the greeting. */}
      <div className="flex-1 min-h-0 flex flex-col justify-end">
        <div className="mx-auto w-full max-w-3xl px-4 pb-3">
          <div className="flex items-center gap-2.5 mb-3">
            <BubblyMark size={26} animation="breathe" />
            <p className="text-[13px] text-text-dim">
              {hello}{greetingName ? `, ${greetingName}` : ''}
            </p>
          </div>

          <h2 className="text-[26px] leading-tight font-semibold text-text mb-4">
            What are we working on today?
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {suggestions.map((s) => {
              const Icon = CHIP_ICON[s.kind];
              return (
                <button
                  key={s.label}
                  onClick={() => setChatDraft(s.prompt)}
                  className="group inline-flex items-center gap-2 rounded-lg border border-border bg-surface-1
                             hover:bg-surface-2 hover:border-border-bright px-3 py-2 text-[13px]
                             text-text-muted hover:text-text transition-colors"
                  title={s.prompt}
                >
                  <Icon size={14} className={`${CHIP_TINT[s.kind]} shrink-0`} />
                  <span>{s.label}</span>
                </button>
              );
            })}

            <button
              onClick={() => setSeed((s) => s + 1)}
              className="text-[12px] text-text-dim hover:text-text px-2 py-2 transition-colors"
              title="Show different suggestions"
            >
              more ideas
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
