import React from 'react';

/**
 * The header every sidebar panel wears.
 *
 * Each panel used to build its own: different heights, different type sizes,
 * some uppercase and some not, action buttons in different corners at different
 * sizes. Switching panels therefore shifted the content down by a few pixels
 * and moved the buttons, which reads as the app being slightly broken even
 * though every individual panel looked fine on its own.
 *
 * One component, one height, one type treatment — actions always right-aligned,
 * an optional count next to the title where a count is meaningful.
 */
export function PanelHeader({
  title,
  count,
  subtitle,
  actions,
}: {
  title: string;
  /** Shown next to the title in normal case — "Explorer · 128". */
  count?: number | string;
  /** Optional second line, e.g. the path a panel is scoped to. */
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex items-center gap-2 px-3 h-9">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted truncate">
          {title}
          {count !== undefined && count !== '' && (
            <span className="ml-1.5 font-normal normal-case tracking-normal text-text-dim tabular-nums">
              {count}
            </span>
          )}
        </span>
        <div className="flex-1" />
        {actions && <div className="flex items-center gap-0.5 shrink-0">{actions}</div>}
      </div>
      {subtitle && (
        <div className="px-3 pb-1.5 -mt-1 text-[10px] text-text-dim truncate" title={subtitle}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

/** An icon button sized to sit in a PanelHeader's action row. */
export function PanelHeaderButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-md transition-colors disabled:opacity-30 ${
        active ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'
      }`}
    >
      {icon}
    </button>
  );
}
