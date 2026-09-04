import React from 'react';
import { useStore } from '../../store';
import { PALETTES, type Palette } from '../../styles/palettes';
import { Check } from '../Shared/icons';

/**
 * Choose a palette by looking at it.
 *
 * A list of theme NAMES is close to useless — "Moss" and "Mint" tell you
 * nothing, and the only way to decide is to apply each one and undo. So each
 * option renders a miniature of the actual interface, drawn from that palette's
 * real tokens: page behind a card, a line of text, a muted line, and the accent.
 * If a palette looks wrong here it will look wrong in the app, because it is the
 * same four colours doing the same four jobs.
 *
 * The swatch is drawn in the mode CURRENTLY RESOLVED, so what you preview is
 * what you will get right now rather than a light-mode idealisation of a theme
 * you are about to use in the dark.
 */

function Swatch({ palette, mode }: { palette: Palette; mode: 'light' | 'dark' }) {
  const c = palette[mode];
  return (
    <div
      className="h-14 rounded-lg overflow-hidden border shrink-0"
      style={{ backgroundColor: c.page, borderColor: c.border }}
      aria-hidden
    >
      <div className="h-full p-1.5 flex gap-1.5">
        {/* A card, as the app draws them */}
        <div
          className="flex-1 rounded-md px-1.5 py-1 flex flex-col justify-center gap-1"
          style={{ backgroundColor: c.card, border: `1px solid ${c.border}` }}
        >
          <div className="h-1.5 rounded-full w-4/5" style={{ backgroundColor: c.text }} />
          <div className="h-1.5 rounded-full w-3/5" style={{ backgroundColor: c.textMuted }} />
          <div className="h-1.5 rounded-full w-2/5" style={{ backgroundColor: c.textDim }} />
        </div>
        {/* The accent column: primary, secondary, and a recessed control */}
        <div className="w-6 flex flex-col gap-1">
          <div className="flex-1 rounded" style={{ backgroundColor: c.primary }} />
          <div className="flex-1 rounded" style={{ backgroundColor: c.secondary }} />
          <div className="flex-1 rounded" style={{ backgroundColor: c.recessed, border: `1px solid ${c.border}` }} />
        </div>
      </div>
    </div>
  );
}

export function ThemePicker() {
  const palette = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const resolvedTheme = useStore((s) => s.resolvedTheme);

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {PALETTES.map((p) => {
        const selected = p.id === palette;
        return (
          <button
            key={p.id}
            onClick={() => setPalette(p.id)}
            aria-pressed={selected}
            className={`group text-left rounded-xl border p-2 transition-all ${
              selected
                ? 'border-accent ring-1 ring-accent/40 bg-accent/5'
                : 'border-border hover:border-border-bright hover:bg-surface-2'
            }`}
          >
            <Swatch palette={p} mode={resolvedTheme} />
            <div className="mt-2 flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-sm font-medium ${selected ? 'text-accent-bright' : 'text-text'}`}>
                    {p.name}
                  </span>
                  {p.id === PALETTES[0].id && (
                    <span className="text-[9px] uppercase tracking-wide text-text-dim border border-border rounded px-1 py-px">
                      default
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-text-dim line-clamp-2">
                  {p.description}
                </p>
              </div>
              {selected && <Check size={14} className="text-accent-bright shrink-0 mt-0.5" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
