/**
 * Skills — Claude-style reusable capabilities.
 *
 * A skill is a named bundle of instructions plus optional trigger keywords.
 * Skills are stored as a JSON array in the `skills` setting. When building the
 * system prompt we include:
 *   - every always-on skill (no keywords), and
 *   - any skill whose keywords match the user's message.
 *
 * This keeps the base prompt lean while letting the user teach Bubbly durable
 * workflows/knowledge that activate only when relevant.
 */

import { getSetting } from '../db/index';
import { logger } from '../utils/logger';

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  keywords: string[];
  enabled: boolean;
}

export function parseSkills(): Skill[] {
  try {
    const raw = getSetting('skills') || '[]';
    return normalizeSkills(raw);
  } catch {
    return [];
  }
}

/** Slugify a name into a stable id. */
function slugifySkill(name: string): string {
  return (name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'skill';
}

/** Coerce a keywords value (array, or comma/newline/space-delimited string) → string[]. */
function normalizeKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((k) => String(k).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
  return [];
}

/**
 * Normalize a skills configuration of ANY common shape into Skill[]. Tolerates:
 *   - our native array form
 *   - an object keyed by skill name: { "Skill Name": { description, instructions } }
 *   - field-name variations: instructions | content | body | prompt | text
 *   - keywords as an array OR a delimited string; triggers as an alias
 *   - enabled:false OR disabled:true; missing id → slug from name
 * Never throws — a malformed entry is skipped, not fatal.
 */
export function normalizeSkills(raw: unknown): Skill[] {
  if (raw == null) return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try { value = JSON.parse(trimmed); } catch { return []; }
  }

  let entries: Array<{ key?: string; cfg: Record<string, unknown> }> = [];
  if (Array.isArray(value)) {
    entries = value.filter((v) => v && typeof v === 'object').map((v) => ({ cfg: v as Record<string, unknown> }));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v && typeof v === 'object') entries.push({ key, cfg: v as Record<string, unknown> });
    }
  }

  const out: Skill[] = [];
  const usedIds = new Set<string>();
  for (const { key, cfg } of entries) {
    const name = String(cfg.name ?? key ?? '').trim();
    if (!name) continue;
    const instructions = String(
      cfg.instructions ?? cfg.content ?? cfg.body ?? cfg.prompt ?? cfg.text ?? ''
    ).trim();
    let id = String(cfg.id ?? slugifySkill(name)) || slugifySkill(name);
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);
    const enabled = cfg.enabled === false ? false : cfg.disabled === true ? false : true;
    out.push({
      id,
      name,
      description: String(cfg.description ?? '').trim(),
      instructions,
      keywords: normalizeKeywords(cfg.keywords ?? cfg.triggers ?? cfg.tags),
      enabled,
    });
  }
  return out;
}

/**
 * Select which skills apply to a given user message. A skill applies if it's
 * enabled AND (has no keywords → always on, OR any keyword appears in the
 * message, case-insensitive).
 */
export function selectSkills(userMessage: string, skills = parseSkills()): Skill[] {
  const lower = userMessage.toLowerCase();
  return skills.filter((s) => {
    if (!s.enabled) return false;
    if (!s.instructions.trim()) return false;
    if (!s.keywords || s.keywords.length === 0) return true; // always-on
    return s.keywords.some((k) => k && lower.includes(k.toLowerCase()));
  });
}

/**
 * Build the system-prompt section for the active skills. Returns '' when none
 * apply, so callers can append unconditionally.
 */
export function buildSkillsPromptSection(userMessage: string): string {
  const active = selectSkills(userMessage);
  if (active.length === 0) return '';
  logger.info('Activating skills', { count: active.length, names: active.map((s) => s.name) });
  const blocks = active.map((s) => {
    const header = s.description ? `### ${s.name} — ${s.description}` : `### ${s.name}`;
    return `${header}\n${s.instructions.trim()}`;
  });
  return `\n\n## Active Skills\nThe user has enabled these reusable capabilities. Apply them when relevant:\n\n${blocks.join('\n\n')}\n`;
}
