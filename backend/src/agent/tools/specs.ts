/**
 * Specs — three markdown files in a folder, and nothing else.
 *
 * A spec is a directory under `<workspace>/.bubbly/specs/<name>/` containing
 * `requirements.md`, `design.md` and `tasks.md`. That is the whole format.
 * There is no database, no spec.json, and — deliberately — no spec tools.
 *
 * WHY THE TOOLS ARE GONE
 *
 * Specs used to be authored through ten dedicated tools: create_spec,
 * set_spec_design, add_spec_task, add_sub_tasks, update_task_status,
 * get_next_task, approve_spec_phase and friends. Every one of them was a
 * round-trip the model had to get exactly right — the correct spec_id, the
 * correct task_id, the correct phase, in the correct order — and each was a
 * fresh opportunity to fail in a way that had no relationship to the actual
 * engineering. `get_next_task` in particular was a constant source of stalls:
 * it could return a task the model had already done, refuse to advance because
 * something was still marked in_progress, or hand back a task id the model then
 * mistyped into update_task_status.
 *
 * The replacement is the thing every model is already excellent at: reading and
 * editing a markdown file. To start a task, the agent reads `tasks.md` and
 * changes that task's `- [ ]` to `- [~]`. To finish it, `- [~]` becomes `- [x]`.
 * Picking the next task is reading a list and choosing the first unchecked
 * line — no tool, no id round-trip, no state machine that can disagree with
 * what is on disk. The file IS the state, so it is visible in the editor,
 * diffable in git, hand-editable by the user, and impossible to desynchronise
 * from the UI.
 *
 * This module therefore has exactly one job: READ that directory and present it
 * as a `Spec` for the UI. It never writes a spec — the agent does that with the
 * ordinary filesystem tools.
 */

import fs from 'fs';
import path from 'path';
import type { Spec, SpecTask, SpecProperty, SpecSubTask, SpecPhase } from '../../types';
import { logger } from '../../utils/logger';
import { getProjectDataPath } from '../projectData';

/**
 * Where a project's specs live: INSIDE the project, at `.bubbly/specs/`.
 *
 * Every other piece of Bubbly's per-project state (checkpoints, artifacts, the
 * run config) is redirected out to `~/.bubbly/projects/<slug>/` so a clean-slate
 * scaffold like `npm create vite@latest .` isn't blocked by a stray folder.
 * Specs are the deliberate exception: they are documents ABOUT the project,
 * written for humans to read and review, so they belong in the repo where they
 * can be browsed, diffed and committed alongside the code they describe.
 */
export function getSpecsDir(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), '.bubbly', 'specs');
}

/** The pre-move location, kept only so existing specs can be brought home. */
function legacySpecsDir(workspacePath: string): string {
  return getProjectDataPath(workspacePath, 'specs');
}

/** Attempted at most once per workspace per process. */
const migratedWorkspaces = new Set<string>();

/**
 * Bring specs written under the old external location back into the project.
 *
 * Best-effort and non-destructive: an external spec whose id already exists
 * in-project is left alone rather than overwriting work.
 */
export function migrateSpecsIntoProject(workspacePath: string): void {
  const key = path.resolve(workspacePath);
  if (migratedWorkspaces.has(key)) return;
  migratedWorkspaces.add(key);

  let legacy: string;
  try { legacy = legacySpecsDir(workspacePath); } catch { return; }

  try {
    if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return;
    const target = getSpecsDir(workspacePath);
    fs.mkdirSync(target, { recursive: true });

    let moved = 0;
    for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = path.join(legacy, entry.name);
      const to = path.join(target, entry.name);
      if (fs.existsSync(to)) continue;             // never clobber
      try {
        fs.renameSync(from, to);
      } catch {
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
      }
      moved++;
    }
    if (moved > 0) {
      logger.info('Moved specs into the project', { workspacePath, count: moved, target });
    }
  } catch (err) {
    logger.warn('Could not migrate specs into the project', {
      workspacePath, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A spec id is used as a directory name. It must be a single, simple path
 * segment — never something that can traverse out of the specs directory
 * (e.g. "../../etc"). Models supply this id, so validate it before it ever
 * touches the filesystem.
 */
export function isSafeSpecId(specId: unknown): specId is string {
  return (
    typeof specId === 'string' &&
    specId.length > 0 &&
    specId.length <= 128 &&
    !specId.includes('/') &&
    !specId.includes('\\') &&
    !specId.includes('..') &&
    !specId.includes('\0') &&
    !path.isAbsolute(specId)
  );
}

/**
 * Turn a spec title into a clean, readable directory slug — e.g.
 * "Glassmorphic To-do List" → "glassmorphic-todo-list".
 */
export function slugifyTitle(title: string, fallback = 'spec'): string {
  const slug = (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')   // drop punctuation/symbols
    .trim()
    .replace(/[\s_]+/g, '-')    // spaces/underscores → hyphen
    .replace(/-+/g, '-')        // collapse repeats
    .replace(/^-|-$/g, '')      // trim hyphens
    .slice(0, 48)
    .replace(/-$/, '');
  return slug || fallback;
}

/** "user-auth-flow" → "User Auth Flow", for a spec with no readable H1. */
function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || slug;
}

// --- tasks.md ---------------------------------------------------------------

/**
 * TASKS.MD IS THE SOURCE OF TRUTH FOR TASK STATE.
 *
 * Progress is tracked by editing one character in a checkbox, which is far more
 * reliable than a tool round-trip: the state is visible, diffable,
 * hand-editable, and survives anything that goes wrong in a tool call.
 *
 *   - [ ]  todo
 *   - [~]  in progress
 *   - [x]  done
 */
const STATUS_TO_MARKER: Record<SpecTask['status'], string> = {
  todo: ' ',
  in_progress: '~',
  done: 'x',
};

function markerToStatus(marker: string): SpecTask['status'] {
  const m = marker.toLowerCase();
  if (m === 'x') return 'done';
  if (m === '~' || m === '-' || m === '/' || m === '>') return 'in_progress';
  return 'todo';
}

/**
 * Render a task list back to markdown.
 *
 * Nothing in the running system calls this any more — the agent writes tasks.md
 * itself. It is kept because it documents, executably, the exact shape
 * parseTasksMarkdown expects, and the round-trip test between the two is what
 * stops the parser drifting away from the format the prompt tells the agent to
 * write.
 */
export function renderTasksMarkdown(spec: Pick<Spec, 'title' | 'tasks'>): string {
  const header =
    `# Tasks: ${spec.title}\n\n` +
    `> Progress is tracked by the checkbox on each task.\n` +
    `> \`- [ ]\` not started · \`- [~]\` in progress · \`- [x]\` done.\n` +
    `> Edit the marker directly to update status — this file is the source of truth.\n\n`;

  if (spec.tasks.length === 0) {
    return header + `_No tasks yet._\n`;
  }
  const lines = spec.tasks.map((t) => {
    let line = `- [${STATUS_TO_MARKER[t.status] ?? ' '}] **${t.id}** ${t.title}`;
    if (t.targetFiles?.length) line += `\n  - Files: ${t.targetFiles.join(', ')}`;
    if (t.dependsOn?.length) line += `\n  - Depends on: ${t.dependsOn.join(', ')}`;
    if (t.satisfiesProperties?.length) line += `\n  - Satisfies: ${t.satisfiesProperties.join(', ')}`;
    if (t.acceptance) line += `\n  - Done when: ${t.acceptance}`;
    if (t.verifyWith) line += `\n  - Verify with: ${t.verifyWith}`;
    if (t.subTasks?.length) {
      for (const st of t.subTasks) {
        line += `\n  - [${STATUS_TO_MARKER[st.status] ?? ' '}] ${st.title}` + (st.acceptance ? ` — _${st.acceptance}_` : '');
      }
    }
    return line;
  });
  return header + `${lines.join('\n')}\n`;
}

/**
 * Parse tasks.md into structured tasks. Tolerant by design — a human or a model
 * editing this file by hand must not be able to break it:
 *   - any of [ ] / [~] / [-] / [x] is understood
 *   - the bold **id** prefix is optional (an id is synthesized when missing)
 *   - unknown indented bullets are ignored rather than treated as errors
 */
export function parseTasksMarkdown(md: string): SpecTask[] {
  const tasks: SpecTask[] = [];
  const lines = md.split(/\r?\n/);
  let current: SpecTask | null = null;
  let autoId = 0;

  for (const raw of lines) {
    // Skip the blockquote legend so its example markers aren't parsed as tasks.
    if (/^\s*>/.test(raw)) continue;

    const indent = raw.length - raw.replace(/^\s*/, '').length;
    const checkbox = /^\s*[-*]\s*\[([ xX~\-\/>])\]\s*(.*)$/.exec(raw);

    if (checkbox && indent === 0) {
      const status = markerToStatus(checkbox[1]);
      let rest = checkbox[2].trim();
      let id = '';
      const idMatch = /^\*\*(.+?)\*\*\s*(.*)$/.exec(rest);
      if (idMatch) {
        id = idMatch[1].trim();
        rest = idMatch[2].trim();
      }
      // Tolerate the older "(status)" suffix from previously rendered files.
      rest = rest.replace(/\s*\((todo|in_progress|done)\)\s*$/i, '').trim();
      if (!id) id = `T${++autoId}`;
      current = { id, title: rest, status };
      tasks.push(current);
      continue;
    }

    if (!current) continue;

    if (checkbox && indent > 0) {
      const status = markerToStatus(checkbox[1]);
      let title = checkbox[2].trim();
      let acceptance: string | undefined;
      const accMatch = /^(.*?)\s+—\s+_(.+?)_\s*$/.exec(title);
      if (accMatch) {
        title = accMatch[1].trim();
        acceptance = accMatch[2].trim();
      }
      const sub: SpecSubTask = { id: `${current.id}.${(current.subTasks?.length ?? 0) + 1}`, title, status };
      if (acceptance) sub.acceptance = acceptance;
      current.subTasks = [...(current.subTasks ?? []), sub];
      continue;
    }

    const meta = /^\s+[-*]\s+(Files|Depends on|Satisfies|Done when|Verify with|Requirements?)\s*:\s*(.+)$/i.exec(raw);
    if (!meta) continue;
    const key = meta[1].toLowerCase();
    const value = meta[2].trim();
    const list = () => value.split(',').map((s) => s.trim()).filter(Boolean);
    if (key === 'files') current.targetFiles = list();
    else if (key === 'depends on') current.dependsOn = list();
    else if (key === 'satisfies' || key === 'requirement' || key === 'requirements') current.satisfiesProperties = list();
    else if (key === 'done when') current.acceptance = value;
    else if (key === 'verify with') current.verifyWith = value;
  }

  return tasks;
}

// --- requirements.md --------------------------------------------------------

/**
 * Pull requirement statements out of requirements.md.
 *
 * Deliberately simple: every top-level list item (bulleted or numbered) counts
 * as one requirement. Bold ids/labels and EARS "(kind)" prefixes are stripped so
 * the text reads cleanly in the UI. Headers, blockquotes and indented detail
 * lines are skipped.
 */
export function parseRequirementsMarkdown(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*>/.test(raw)) continue;          // legend/quote
    if (/^\s*#/.test(raw)) continue;          // headers
    // Only top-level items; indented sub-bullets are detail (e.g. _Acceptance:_).
    const m = /^(?:[-*]|\d+\.)\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    let text = m[1].trim();
    if (/^_?(?:Acceptance|Verify|Test)\b/i.test(text)) continue;
    // "**R-1** (functional): statement" → "statement", but keep the id for the
    // property below by capturing it first.
    const idMatch = /^\*\*(.+?)\*\*\s*/.exec(text);
    if (idMatch) text = text.slice(idMatch[0].length);
    text = text.replace(/^\((?:functional|non-functional|nfr|perf|security|constraint|invariant|edge_case|edge case)\)\s*:?\s*/i, '');
    text = text.replace(/^:\s*/, '').trim();
    if (text) out.push(idMatch ? `${idMatch[1]}: ${text}` : text);
  }
  return out;
}

/**
 * Classify a requirement statement into a displayable acceptance property.
 *
 * Purely presentational now — the "EARS property" was once a stored contract the
 * verifier checked against; today it is a label in the Specs panel derived from
 * whatever the agent actually wrote. It never rewrites the author's sentence.
 */
export function toEarsProperty(requirement: string, index: number): SpecProperty {
  const raw = requirement.trim();
  const lower = raw.toLowerCase();

  // "R-1: the system shall …" keeps R-1 as the id rather than inventing prop-01.
  const idMatch = /^([A-Za-z][\w.-]{0,15})\s*:\s*(.+)$/.exec(raw);
  const id = idMatch ? idMatch[1] : `prop-${(index + 1).toString().padStart(2, '0')}`;
  const body = (idMatch ? idMatch[2] : raw).replace(/\.$/, '');

  let kind: SpecProperty['kind'] = 'functional';
  if (/\b(never|not|only|at most|at least|must not|always)\b/.test(lower)) kind = 'constraint';
  if (/\b(invariant|consistent|maintain|preserve)\b/.test(lower)) kind = 'invariant';
  if (/\b(empty|invalid|error|edge|boundary|null|missing|fail)\b/.test(lower)) kind = 'edge_case';

  return { id, statement: `${body}.`, kind };
}

// --- design.md --------------------------------------------------------------

/** The design body, minus its generated H1 and any not-yet-authored placeholder. */
function readDesign(specDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(specDir, 'design.md'), 'utf8');
    const body = raw.replace(/^#\s+.*\n+/, '').trim();
    if (!body || /^_?Design not authored yet/i.test(body)) return undefined;
    return body;
  } catch {
    return undefined;
  }
}

/** The first H1 in a markdown document, with any "Tasks:"/"Design:" prefix removed. */
function firstHeading(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md);
  if (!m) return null;
  return m[1].replace(/^(?:Tasks?|Design|Requirements)\s*(?:for)?\s*:\s*/i, '').trim() || null;
}

function readIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// --- Reading a spec ---------------------------------------------------------

const SPEC_TYPES = ['feature', 'bugfix', 'refactor', 'research'] as const;

/**
 * Load one spec from its directory. Everything is DERIVED from the markdown —
 * there is no stored status, phase or approval flag to fall out of sync with
 * what the files actually say.
 */
export function readSpec(workspacePath: string, specId: string): Spec | null {
  if (!isSafeSpecId(specId)) {
    logger.warn('Rejected unsafe spec id', { specId });
    return null;
  }
  migrateSpecsIntoProject(workspacePath);

  const specDir = path.join(getSpecsDir(workspacePath), specId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(specDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const requirementsMd = readIfExists(path.join(specDir, 'requirements.md'));
  const tasksMd = readIfExists(path.join(specDir, 'tasks.md'));
  const design = readDesign(specDir);

  // A directory with none of the three documents is not a spec.
  if (requirementsMd == null && tasksMd == null && design == null) return null;

  const requirements = requirementsMd ? parseRequirementsMarkdown(requirementsMd) : [];
  const tasks = tasksMd ? parseTasksMarkdown(tasksMd) : [];

  const title =
    (requirementsMd && firstHeading(requirementsMd)) ||
    (tasksMd && firstHeading(tasksMd)) ||
    firstHeading(design ?? '') ||
    prettifySlug(specId);

  // "**Type:** bugfix" anywhere in requirements.md, else the neutral default.
  const typeMatch = /\*\*Type:\*\*\s*(\w+)/i.exec(requirementsMd ?? '');
  const type = (SPEC_TYPES as readonly string[]).includes((typeMatch?.[1] ?? '').toLowerCase())
    ? (typeMatch![1].toLowerCase() as Spec['type'])
    : 'feature';

  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const startedCount = tasks.filter((t) => t.status !== 'todo').length;

  // Phase is a description of what exists, not a gate. The gates are the user's
  // approval in conversation — a tool could never enforce them honestly anyway,
  // since only the user knows whether they approved.
  const phase: SpecPhase =
    tasks.length > 0 ? 'ready'
    : design ? 'tasks'
    : requirements.length > 0 ? 'design'
    : 'requirements';

  const status: Spec['status'] =
    tasks.length > 0 && doneCount === tasks.length ? 'done'
    : startedCount > 0 ? 'in_progress'
    : 'draft';

  const createdAt = stat.birthtime?.toISOString?.() ?? stat.mtime.toISOString();

  return {
    id: specId,
    title,
    type,
    status,
    phase,
    requirements,
    properties: requirements.map((r, i) => toEarsProperty(r, i)),
    design,
    tasks,
    createdAt,
    updatedAt: stat.mtime.toISOString(),
  };
}

/** Every spec in the workspace, newest first. */
export function listSpecs(workspacePath: string): Spec[] {
  migrateSpecsIntoProject(workspacePath);

  const specsDir = getSpecsDir(workspacePath);
  if (!fs.existsSync(specsDir)) return [];

  const specs: Spec[] = [];
  for (const d of fs.readdirSync(specsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;             // skip stray files (.DS_Store, …)
    const spec = readSpec(workspacePath, d.name);
    if (spec) specs.push(spec);
  }
  return specs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The next task a spec owes: the first `- [~]` (resume what was started) and
 * otherwise the first `- [ ]` whose dependencies are all `- [x]`.
 *
 * This is NOT a tool. It exists so the backend can describe a spec's live state
 * in the turn briefing (see runtimeState) — the agent picks its own next task by
 * reading tasks.md, which is the whole point of the format.
 */
export function nextTaskOf(spec: Spec): SpecTask | null {
  const inProgress = spec.tasks.find((t) => t.status === 'in_progress');
  if (inProgress) return inProgress;
  const doneIds = new Set(spec.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return (
    spec.tasks.find((t) => t.status === 'todo' && (!t.dependsOn?.length || t.dependsOn.every((d) => doneIds.has(d)))) ??
    spec.tasks.find((t) => t.status === 'todo') ??
    null
  );
}
