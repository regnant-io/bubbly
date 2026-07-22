import React, { useMemo, useState } from 'react';
import { Puzzle, Plus, Trash2, Check, BookOpen } from '../Shared/icons';
import { saveSettings } from '../../hooks/useApi';

export interface Skill {
  id: string;
  name: string;
  /** Short description of when to use this skill. */
  description: string;
  /** The instructions/knowledge injected when the skill is active. */
  instructions: string;
  /** Comma-free trigger keywords that hint when the skill is relevant. */
  keywords: string[];
  enabled: boolean;
}

interface SkillsSettingsProps {
  value: string; // JSON string of Skill[]
  onChange: (json: string) => void;
}

function parse(value: string): Skill[] {
  try {
    const arr = JSON.parse(value || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function nanoid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Skills — Claude-style reusable capabilities. Each skill is a named bundle of
 * instructions plus trigger keywords. When a user's message matches a skill's
 * keywords (or it's always-on), the backend injects its instructions into the
 * agent's system prompt. Stored as a JSON array in the `skills` setting.
 */
export function SkillsSettings({ value, onChange }: SkillsSettingsProps) {
  const skills = useMemo(() => parse(value), [value]);
  const [saved, setSaved] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const commit = async (next: Skill[]) => {
    const json = JSON.stringify(next);
    onChange(json);
    try {
      await saveSettings({ skills: json });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
  };

  const addSkill = () => {
    const id = nanoid();
    commit([...skills, { id, name: 'New skill', description: '', instructions: '', keywords: [], enabled: true }]);
    setExpandedId(id);
  };

  const updateSkill = (id: string, patch: Partial<Skill>) => commit(skills.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const removeSkill = (id: string) => commit(skills.filter((s) => s.id !== id));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold text-text-dim uppercase tracking-wider mb-1.5 flex items-center gap-2">
          <Puzzle size={13} /> Skills
        </h3>
        <p className="text-xs text-text-dim leading-relaxed">
          Reusable instruction bundles the agent can draw on. Add keywords so a skill activates automatically when
          relevant, or leave keywords empty to always include it.
        </p>
      </div>

      {skills.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <BookOpen size={22} className="text-text-dim mx-auto mb-2" />
          <p className="text-sm text-text-muted">No skills yet</p>
          <p className="text-xs text-text-dim mt-1">Teach Bubbly a reusable capability or workflow.</p>
        </div>
      )}

      <div className="space-y-3">
        {skills.map((s) => {
          const expanded = expandedId === s.id;
          return (
            <div key={s.id} className="rounded-xl border border-border bg-surface-1 p-3.5 space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  className="text-text-dim hover:text-text shrink-0 w-4 text-center text-xs"
                  title={expanded ? 'Collapse' : 'Expand'}
                >
                  {expanded ? '▾' : '▸'}
                </button>
                <input
                  value={s.name}
                  onChange={(e) => updateSkill(s.id, { name: e.target.value })}
                  className="input flex-1 font-medium"
                  placeholder="Skill name"
                />
                <button
                  onClick={() => updateSkill(s.id, { enabled: !s.enabled })}
                  className={`shrink-0 px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                    s.enabled ? 'border-green-agent/40 text-green-agent bg-green-agent/10' : 'border-border text-text-dim'
                  }`}
                >
                  {s.enabled ? 'On' : 'Off'}
                </button>
                <button onClick={() => removeSkill(s.id)} className="shrink-0 p-1.5 rounded-lg text-text-dim hover:text-red-agent hover:bg-surface-3" title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>

              {expanded && (
                <div className="space-y-2.5 pl-6">
                  <input
                    value={s.description}
                    onChange={(e) => updateSkill(s.id, { description: e.target.value })}
                    className="input text-sm"
                    placeholder="When should this skill be used?"
                  />
                  <input
                    value={s.keywords.join(', ')}
                    onChange={(e) => updateSkill(s.id, { keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
                    className="input font-mono text-xs"
                    placeholder="trigger keywords (comma-separated; empty = always on)"
                  />
                  <textarea
                    value={s.instructions}
                    onChange={(e) => updateSkill(s.id, { instructions: e.target.value })}
                    className="input text-sm font-mono min-h-[120px] resize-y"
                    placeholder="Instructions / knowledge to inject when this skill is active…"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={addSkill} className="btn-ghost w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-border rounded-xl">
        <Plus size={14} /> Add skill
      </button>

      {saved && (
        <div className="flex items-center gap-2 text-xs text-green-agent">
          <Check size={13} /> Saved
        </div>
      )}
    </div>
  );
}
