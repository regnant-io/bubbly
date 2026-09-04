/**
 * Skills — conditional expertise, injected only when it is relevant.
 *
 * A skill is a named bundle of instructions plus the triggers that decide when
 * it applies. The base system prompt stays lean — everything in it is paid for
 * on every model call and competes for attention — while the agent still gets a
 * specialist's checklist at the moment it is about to do that specialist's work.
 *
 * TWO SOURCES, ONE LIST
 *
 *   BUILT-IN skills ship with Bubbly (see builtinSkills.ts). They can be
 *   switched off but never deleted: they are part of the product, and a user who
 *   disables one should be able to restore it without retyping it.
 *   USER skills are authored in Settings and stored as JSON in the `skills`
 *   setting. A user skill sharing an id with a built-in replaces it.
 *
 * MATCHING IS ON WORD BOUNDARIES, NOT SUBSTRINGS
 *
 * This is the difference between a skill system and a system that always
 * injects everything. A substring match for "api" fires on "rapid", "css" on
 * "success", "go" on "going", "ts" on "its" — so within a few skills every
 * message matches every skill, and the mechanism collapses back into a bloated
 * base prompt that is worse than having no skills at all. Word boundaries,
 * phrase matching for multi-word triggers, file-extension hints and a hard cap
 * on how many can be active at once are what keep activation honest.
 */

import { getSetting } from '../db/index';
import { logger } from '../utils/logger';
import { BUILTIN_SKILLS, BUILTIN_SKILL_IDS, type BuiltinSkill, type SkillCategory } from './builtinSkills';

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  keywords: string[];
  enabled: boolean;
  /** Built-ins can be disabled but not deleted, and are grouped in Settings. */
  builtin?: boolean;
  category?: SkillCategory;
  /** File extensions that also activate this skill. */
  fileHints?: string[];
  /** Active regardless of triggers. */
  alwaysOn?: boolean;
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

/** Coerce a keywords value (array, or comma/newline-delimited string) → string[]. */
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
      fileHints: normalizeKeywords(cfg.fileHints ?? cfg.file_hints),
    });
  }
  return out;
}

/**
 * Which built-ins the user has switched off.
 *
 * Stored as the DISABLED set rather than the enabled one, deliberately: skills
 * added in a later release are then on by default, which is what someone who
 * never opened this screen expects. Storing the enabled set would silently
 * withhold every new skill from every existing user, and they would never know
 * to go looking.
 */
export function disabledBuiltinIds(): Set<string> {
  try {
    const raw = getSetting('disabledBuiltinSkills') || '[]';
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function builtinToSkill(b: BuiltinSkill, disabled: Set<string>): Skill {
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    instructions: b.instructions,
    keywords: b.triggers,
    enabled: !disabled.has(b.id),
    builtin: true,
    category: b.category,
    fileHints: b.fileHints,
    alwaysOn: b.alwaysOn,
  };
}

/**
 * Every skill Bubbly knows about — built-ins first, then the user's own.
 *
 * A user skill sharing an id with a built-in REPLACES it. That is the escape
 * hatch for someone who mostly likes a shipped skill but wants one line
 * different: they copy it, change it, and keep the same trigger behaviour
 * without ending up with two nearly-identical skills both firing.
 */
export function allSkills(): Skill[] {
  const disabled = disabledBuiltinIds();
  const user = parseSkills();
  const overridden = new Set(user.map((s) => s.id));
  const builtins = BUILTIN_SKILLS
    .filter((b) => !overridden.has(b.id))
    .map((b) => builtinToSkill(b, disabled));
  return [...builtins, ...user];
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does a trigger fire on this text?
 *
 * A single word must match as a WORD, so "rapid" does not activate the API
 * skill. A multi-word trigger ("race condition") is matched as a phrase with
 * flexible separators, because people write "race-condition" and
 * "race  condition" too and mean the same thing.
 *
 * Deliberately not using `\b`: it treats an underscore as a word character, so
 * `\bapi\b` would fail to fire on `api_key`, which is exactly the kind of near
 * miss that makes a trigger system feel arbitrary.
 */
export function triggerMatches(trigger: string, text: string): boolean {
  const t = trigger.trim().toLowerCase();
  if (!t) return false;

  const pattern = /\s/.test(t)
    ? t.split(/\s+/).map(escapeRegExp).join('[\\s_-]+')
    : escapeRegExp(t);

  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, 'i').test(text);
}

/** File extensions mentioned anywhere in the text, without the dot. */
export function extensionsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w./\\-]+\.([a-z0-9]{1,6})(?![a-z0-9])/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * How many skills may be active at once.
 *
 * Without a cap, "refactor the API tests and fix the docker build" activates
 * seven or eight skills and adds several thousand tokens of checklist that
 * drowns out the actual request. Ranking and taking the strongest keeps the
 * specific matches and drops the incidental ones.
 */
const MAX_ACTIVE_SKILLS = 8;

export interface SkillSelection {
  skill: Skill;
  score: number;
}

/** Rank the skills that apply, strongest first. */
export function rankSkills(
  userMessage: string,
  opts: { skills?: Skill[]; contextFiles?: string[] } = {},
): SkillSelection[] {
  const skills = opts.skills ?? allSkills();
  const haystack = [userMessage, ...(opts.contextFiles ?? [])].join('\n');
  const extensions = extensionsIn(haystack);
  const scored: SkillSelection[] = [];

  for (const s of skills) {
    if (!s.enabled) continue;
    if (!s.instructions.trim()) continue;

    if (s.alwaysOn) { scored.push({ skill: s, score: 1000 }); continue; }

    let score = 0;
    for (const k of s.keywords ?? []) {
      if (triggerMatches(k, haystack)) {
        // A longer trigger is a more specific one: "race condition" firing is
        // much stronger evidence of relevance than "test" firing.
        score += 10 + k.length;
      }
    }
    for (const ext of s.fileHints ?? []) {
      if (extensions.has(ext.toLowerCase())) score += 8;
    }

    // A USER skill with no triggers at all is always-on by the convention that
    // predates `alwaysOn`, and that is still what people who wrote one expect.
    if (!s.builtin && (!s.keywords || s.keywords.length === 0)) score = 1000;

    if (score > 0) scored.push({ skill: s, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Which skills apply to this message.
 *
 * `contextFiles` carries facts the message itself does not state — most
 * importantly the files currently in play, which is how "fix this" activates
 * the React skill when the open file is a .tsx.
 */
export function selectSkills(
  userMessage: string,
  opts: { skills?: Skill[]; contextFiles?: string[]; limit?: number } = {},
): Skill[] {
  return rankSkills(userMessage, opts)
    .slice(0, opts.limit ?? MAX_ACTIVE_SKILLS)
    .map((x) => x.skill);
}

/**
 * Build the system-prompt section for the active skills. Returns '' when none
 * apply, so callers can append unconditionally.
 */
export function buildSkillsPromptSection(
  userMessage: string,
  opts: { contextFiles?: string[] } = {},
): string {
  const active = selectSkills(userMessage, { contextFiles: opts.contextFiles });
  if (active.length === 0) return '';

  logger.info('Activating skills', { count: active.length, names: active.map((s) => s.name) });

  const blocks = active.map((s) => {
    const header = s.description ? `### ${s.name} — ${s.description}` : `### ${s.name}`;
    return `${header}\n${s.instructions.trim()}`;
  });

  return (
    '\n\n## Applicable skills\n' +
    'These apply to what you are about to do. They are specific guidance, not general advice — ' +
    'follow them unless this codebase clearly does something else on purpose.\n\n' +
    `${blocks.join('\n\n')}\n`
  );
}

/** Every skill with its enabled state, for the Settings page. */
export function skillsForSettings(): Skill[] {
  return allSkills();
}

/** Turn a built-in on or off. Returns the new disabled set, for persistence. */
export function toggleBuiltinSkill(id: string, enabled: boolean, current = disabledBuiltinIds()): string[] {
  if (!BUILTIN_SKILL_IDS.has(id)) return [...current];
  const next = new Set(current);
  if (enabled) next.delete(id); else next.add(id);
  return [...next];
}
