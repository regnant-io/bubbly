import React from 'react';
import {
  Puzzle, Plus, Trash2, Check, BookOpen, ChevronRight, Search, Loader2, X,
} from '../Shared/icons';

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  keywords: string[];
  enabled: boolean;
}

interface CatalogueSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  builtin: boolean;
  alwaysOn: boolean;
  triggers: string[];
  fileHints: string[];
  instructionsLength: number;
}

interface SkillsSettingsProps {
  /** JSON string of the user's own Skill[]. */
  value: string;
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
 * Skills — conditional expertise, grouped by what it is for.
 *
 * WHY THIS IS A CATEGORISED, COLLAPSED LIST
 *
 * Bubbly ships nearly fifty skills. As a flat list of fifty toggles that is
 * unusable: nobody reads it, so nobody knows what is in it, so the feature might
 * as well not exist. Grouped into ten named categories with a one-line blurb
 * each, it becomes something you can skim in fifteen seconds and understand —
 * "there is a Data group, it has migrations and caching in it" — which is the
 * whole point of shipping them.
 *
 * Built-ins can be switched off and never deleted. A shipped skill is part of
 * the product; someone who turns one off should be able to turn it back on
 * without retyping several hundred words they no longer have.
 */
export function SkillsSettings({ value, onChange }: SkillsSettingsProps) {
  const userSkills = React.useMemo(() => parse(value), [value]);
  const [catalogue, setCatalogue] = React.useState<CatalogueSkill[]>([]);
  const [categories, setCategories] = React.useState<Record<string, { label: string; blurb: string }>>({});
  const [loading, setLoading] = React.useState(true);
  const [openCategories, setOpenCategories] = React.useState<Set<string>>(new Set());
  const [expandedSkill, setExpandedSkill] = React.useState<string | null>(null);
  const [instructions, setInstructions] = React.useState<Record<string, string>>({});
  const [query, setQuery] = React.useState('');
  const [editingUser, setEditingUser] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/settings/skills');
      const data = await res.json();
      setCatalogue(data.skills ?? []);
      setCategories(data.categories ?? {});
    } catch {
      setCatalogue([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const toggleBuiltin = async (id: string, enabled: boolean) => {
    // Optimistic: the toggle should feel instant, and a failed write is
    // recoverable by reloading rather than by having lied about the state.
    setCatalogue((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      await fetch(`/api/settings/skills/${encodeURIComponent(id)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      void load();
    }
  };

  const showInstructions = async (id: string) => {
    setExpandedSkill((cur) => (cur === id ? null : id));
    if (instructions[id]) return;
    try {
      const res = await fetch(`/api/settings/skills/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.skill?.instructions) {
        setInstructions((prev) => ({ ...prev, [id]: data.skill.instructions }));
      }
    } catch { /* the body is a nicety; the toggle still works */ }
  };

  const builtins = catalogue.filter((s) => s.builtin);
  const q = query.trim().toLowerCase();
  const matches = (s: CatalogueSkill) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.triggers.some((t) => t.toLowerCase().includes(q));

  const byCategory = React.useMemo(() => {
    const map = new Map<string, CatalogueSkill[]>();
    for (const s of builtins) {
      if (!matches(s)) continue;
      const list = map.get(s.category);
      if (list) list.push(s); else map.set(s.category, [s]);
    }
    return map;
  }, [builtins, q]);

  const enabledCount = builtins.filter((s) => s.enabled).length;

  // --- User skill editing ---------------------------------------------------

  const updateUser = (id: string, patch: Partial<Skill>) => {
    onChange(JSON.stringify(userSkills.map((s) => (s.id === id ? { ...s, ...patch } : s)), null, 2));
  };
  const addUser = () => {
    const skill: Skill = {
      id: nanoid(), name: 'New skill', description: '', instructions: '', keywords: [], enabled: true,
    };
    onChange(JSON.stringify([...userSkills, skill], null, 2));
    setEditingUser(skill.id);
  };
  const removeUser = (id: string) => {
    onChange(JSON.stringify(userSkills.filter((s) => s.id !== id), null, 2));
    if (editingUser === id) setEditingUser(null);
  };

  return (
    <div className="space-y-5">
      {/* Intro */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Puzzle size={15} className="text-accent-bright" />
          <h3 className="text-sm font-semibold text-text">Skills</h3>
          <span className="ml-auto text-[11px] text-text-dim tabular-nums">
            {enabledCount} of {builtins.length} on
          </span>
        </div>
        <p className="text-[11px] text-text-dim leading-relaxed">
          Each skill is a specialist's checklist that is added to the prompt only when it is relevant —
          matched on the words in your message and the file types in play. That keeps the base prompt small
          while still giving the agent real depth when it needs it. At most eight apply at once, strongest match first.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills and triggers…"
          className="input w-full text-xs pl-8 pr-7"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-6 flex justify-center"><Loader2 size={16} className="animate-spin text-text-dim" /></div>
      ) : (
        <div className="space-y-2">
          {[...byCategory.entries()].map(([categoryId, skills]) => {
            const meta = categories[categoryId] ?? { label: categoryId, blurb: '' };
            // A search result opens every group it matched: hiding matches
            // behind a collapsed header makes the search look broken.
            const isOpen = openCategories.has(categoryId) || !!q;
            const on = skills.filter((s) => s.enabled).length;

            return (
              <div key={categoryId} className="card bg-surface-2 overflow-hidden">
                <button
                  onClick={() => setOpenCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
                    return next;
                  })}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-3 transition-colors"
                >
                  <ChevronRight
                    size={13}
                    className={`mt-0.5 shrink-0 text-text-dim transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text">{meta.label}</span>
                      <span className="text-[10px] text-text-dim tabular-nums">
                        {on}/{skills.length}
                      </span>
                    </div>
                    {meta.blurb && <p className="text-[10px] text-text-dim leading-snug mt-0.5">{meta.blurb}</p>}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border divide-y divide-border">
                    {skills.map((s) => (
                      <div key={s.id} className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => toggleBuiltin(s.id, !s.enabled)}
                            role="switch"
                            aria-checked={s.enabled}
                            aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                            className={`mt-0.5 shrink-0 w-7 h-4 rounded-full transition-colors relative ${
                              s.enabled ? 'bg-accent' : 'bg-surface-4'
                            }`}
                          >
                            <span
                              className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-surface-1 transition-[left] duration-150 ${
                                s.enabled ? 'left-[calc(100%-0.875rem)]' : 'left-0.5'
                              }`}
                            />
                          </button>

                          <button onClick={() => showInstructions(s.id)} className="min-w-0 flex-1 text-left">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`text-xs ${s.enabled ? 'text-text' : 'text-text-dim'}`}>{s.name}</span>
                              {s.alwaysOn && (
                                <span className="text-[9px] uppercase tracking-wide text-accent-bright border border-accent/40 rounded px-1">
                                  always
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-text-dim leading-snug mt-0.5">{s.description}</p>

                            {expandedSkill === s.id && (
                              <div className="mt-2 space-y-2">
                                {s.triggers.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {s.triggers.map((t) => (
                                      <span key={t} className="text-[9px] font-mono bg-surface-3 text-text-dim rounded px-1 py-px">
                                        {t}
                                      </span>
                                    ))}
                                    {s.fileHints.map((f) => (
                                      <span key={f} className="text-[9px] font-mono bg-accent/10 text-accent-bright rounded px-1 py-px">
                                        .{f}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <pre className="text-[10px] leading-relaxed text-text-muted whitespace-pre-wrap bg-surface-1 rounded-lg p-2 max-h-56 overflow-y-auto">
                                  {instructions[s.id] ?? 'Loading…'}
                                </pre>
                              </div>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {byCategory.size === 0 && q && (
            <p className="text-xs text-text-dim py-3 text-center">No skill matches “{query}”.</p>
          )}
        </div>
      )}

      {/* --- User skills ------------------------------------------------- */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <BookOpen size={14} className="text-text-dim" />
          <h3 className="text-sm font-semibold text-text">Your skills</h3>
          <button onClick={addUser} className="ml-auto flex items-center gap-1 text-[11px] text-accent-bright hover:underline">
            <Plus size={12} /> Add
          </button>
        </div>
        <p className="text-[11px] text-text-dim leading-relaxed mb-2">
          Teach Bubbly something specific to you or your team. Give a skill the same id as a built-in to replace it.
        </p>

        {userSkills.length === 0 && (
          <p className="text-xs text-text-dim py-2">None yet.</p>
        )}

        <div className="space-y-1">
          {userSkills.map((s) => (
            <div key={s.id} className="card bg-surface-2 px-3 py-2">
              <div className="flex items-start gap-2">
                <button
                  onClick={() => updateUser(s.id, { enabled: !s.enabled })}
                  role="switch"
                  aria-checked={s.enabled}
                  className={`mt-0.5 shrink-0 w-7 h-4 rounded-full transition-colors relative ${s.enabled ? 'bg-accent' : 'bg-surface-4'}`}
                >
                  <span className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-surface-1 transition-[left] duration-150 ${s.enabled ? 'left-[calc(100%-0.875rem)]' : 'left-0.5'}`} />
                </button>
                <button
                  onClick={() => setEditingUser((cur) => (cur === s.id ? null : s.id))}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="text-xs text-text">{s.name || 'Untitled'}</span>
                  <p className="text-[10px] text-text-dim leading-snug">{s.description || 'No description'}</p>
                </button>
                <button
                  onClick={() => removeUser(s.id)}
                  className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-red-agent transition-colors"
                  title="Delete"
                >
                  <Trash2 size={11} />
                </button>
              </div>

              {editingUser === s.id && (
                <div className="mt-2 space-y-2">
                  <input
                    className="input w-full text-xs"
                    value={s.name}
                    onChange={(e) => updateUser(s.id, { name: e.target.value })}
                    placeholder="Name"
                  />
                  <input
                    className="input w-full text-xs"
                    value={s.description}
                    onChange={(e) => updateUser(s.id, { description: e.target.value })}
                    placeholder="When does this apply?"
                  />
                  <input
                    className="input w-full text-xs font-mono"
                    value={s.keywords.join(', ')}
                    onChange={(e) => updateUser(s.id, {
                      keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
                    })}
                    placeholder="Triggers, comma separated. Leave empty for always-on."
                  />
                  <textarea
                    className="input w-full text-xs font-mono min-h-[120px]"
                    value={s.instructions}
                    onChange={(e) => updateUser(s.id, { instructions: e.target.value })}
                    placeholder="The instructions to inject when this skill applies."
                  />
                  <p className="text-[10px] text-text-dim flex items-center gap-1">
                    <Check size={10} /> Saved with the rest of your settings.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
