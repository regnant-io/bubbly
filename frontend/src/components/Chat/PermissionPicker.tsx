import React from 'react';
import { useStore } from '../../store';
import { saveSettings } from '../../hooks/useApi';
import { ShieldCheck, ChevronDown, Check } from '../Shared/icons';

/**
 * How much the agent may do without asking, set from the composer.
 *
 * WHY THIS IS NOT ONLY IN SETTINGS
 *
 * The right answer changes constantly and it changes at the moment you are
 * about to type. "Read the code and tell me what you think" wants no approvals
 * at all; "clean up the migrations directory" wants every write confirmed. If
 * the control lives four clicks away in a settings page, nobody moves it — they
 * pick one setting on the first day and then either sit through approvals they
 * do not want or grant permissions they would not have granted.
 *
 * Three profiles rather than two switches, because "should I be asked about
 * writes" and "should I be asked about shell commands" are not the questions
 * people actually have. The question is how much they trust this particular
 * task, and that has a small number of sensible answers.
 */

export type PermissionProfile = 'guarded' | 'balanced' | 'autonomous';

interface ProfileSpec {
  id: PermissionProfile;
  label: string;
  blurb: string;
  detail: string;
  requireApprovalForWrites: boolean;
  requireApprovalForShell: boolean;
}

const PROFILES: ProfileSpec[] = [
  {
    id: 'guarded',
    label: 'Guarded',
    blurb: 'Ask before changing anything',
    detail: 'Every file write and every command waits for you. Right for unfamiliar code, production repositories, or anything you would not want undone.',
    requireApprovalForWrites: true,
    requireApprovalForShell: true,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Ask before running commands',
    detail: 'File edits go ahead — they are visible in Changes and revertible per prompt. Shell commands still wait, because a command can reach outside the workspace.',
    requireApprovalForWrites: false,
    requireApprovalForShell: true,
  },
  {
    id: 'autonomous',
    label: 'Autonomous',
    blurb: 'Work without interrupting',
    detail: 'Nothing waits for you. The right choice for a long unattended run — and only in a workspace where the worst case is acceptable, since destructive commands are still blocked but a bad one can still be run.',
    requireApprovalForWrites: false,
    requireApprovalForShell: false,
  },
];

/** Which profile the current settings correspond to. */
export function profileFromSettings(writes: boolean, shell: boolean): PermissionProfile {
  if (writes && shell) return 'guarded';
  if (!writes && !shell) return 'autonomous';
  // Anything else — including the odd "ask about writes but not commands" — is
  // closest to balanced, and picking a name is better than showing "custom",
  // which tells the reader nothing and offers no way back.
  return 'balanced';
}

export function PermissionPicker() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const writes = String(settings?.requireApprovalForWrites ?? 'true') === 'true';
  const shell = String(settings?.requireApprovalForShell ?? 'true') === 'true';
  const current = profileFromSettings(writes, shell);
  const spec = PROFILES.find((p) => p.id === current) ?? PROFILES[0];

  const choose = async (profile: ProfileSpec) => {
    setOpen(false);
    if (profile.id === current) return;
    setSaving(true);

    // Optimistic, then persisted. A permission control that lags behind the
    // click is a control people click twice, and the second click puts it back.
    const next = {
      requireApprovalForWrites: String(profile.requireApprovalForWrites),
      requireApprovalForShell: String(profile.requireApprovalForShell),
    };
    setSettings({ ...(settings ?? {}), ...next } as never);

    try {
      await saveSettings(next as never);
    } catch {
      // Put it back rather than leaving the UI claiming a permission level the
      // backend does not have.
      setSettings({
        ...(settings ?? {}),
        requireApprovalForWrites: String(writes),
        requireApprovalForShell: String(shell),
      } as never);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={saving}
        title={`Permissions: ${spec.label} — ${spec.blurb}`}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors ${
          current === 'autonomous'
            ? 'text-amber-agent hover:bg-surface-3'
            : 'text-text-dim hover:text-text hover:bg-surface-3'
        }`}
      >
        <ShieldCheck size={12} className="shrink-0" />
        <span>{spec.label}</span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 right-0 z-50 w-[320px] card bg-surface-1 shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[11px] font-medium text-text">What may the agent do without asking?</p>
          </div>

          {PROFILES.map((p) => {
            const selected = p.id === current;
            return (
              <button
                key={p.id}
                onClick={() => choose(p)}
                className={`w-full text-left px-3 py-2 transition-colors ${
                  selected ? 'bg-accent/10' : 'hover:bg-surface-3'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${selected ? 'text-accent-bright' : 'text-text'}`}>
                    {p.label}
                  </span>
                  <span className="text-[10px] text-text-dim">{p.blurb}</span>
                  {selected && <Check size={12} className="ml-auto text-accent-bright shrink-0" />}
                </div>
                <p className="mt-0.5 text-[10px] text-text-dim leading-snug">{p.detail}</p>
              </button>
            );
          })}

          <div className="px-3 py-1.5 border-t border-border">
            <p className="text-[10px] text-text-dim leading-snug">
              Genuinely destructive commands are refused at every level, and every prompt takes a checkpoint you can revert to.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
