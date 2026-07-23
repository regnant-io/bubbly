import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Spec, SpecTask, SpecProperty, SpecSubTask, SpecPhase } from '../../types';
import { logger } from '../../utils/logger';
import { getProjectDataPath } from '../projectData';

export function getSpecsDir(workspacePath: string): string {
  return getProjectDataPath(workspacePath, 'specs');
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
 * Turn a spec title into a clean, readable directory/id slug — e.g.
 * "Glassmorphic To-do List" → "glassmorphic-todo-list". This replaces the old
 * `${type}-${Date.now()}` ids (which produced ugly names like
 * "feature-1718999999999"). Falls back to the type when a title has no usable
 * characters (e.g. all symbols).
 */
export function slugifyTitle(title: string, type: string): string {
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
  return slug || type || 'spec';
}

/**
 * Pick a unique spec id (directory name) from the title. If the base slug is
 * already taken on disk, append -2, -3, … so specs keep human-readable names
 * without collisions.
 */
function uniqueSpecId(workspacePath: string, title: string, type: string): string {
  const base = slugifyTitle(title, type);
  const dir = getSpecsDir(workspacePath);
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

/**
 * Convert a free-text requirement into an EARS-style testable property.
 * EARS = Easy Approach to Requirements Syntax. We keep it light: if the author
 * already wrote a "shall/when/if" statement we preserve it; otherwise we wrap it
 * into a normalized "THE SYSTEM SHALL ..." form so every property is checkable.
 */
export function toEarsProperty(requirement: string, index: number): SpecProperty {
  const raw = requirement.trim();
  const lower = raw.toLowerCase();
  const body = raw.replace(/\.$/, '');
  let kind: SpecProperty['kind'] = 'functional';

  // Decide whether the requirement is ALREADY a well-formed statement (has its
  // own subject and/or a modal verb), in which case we must NOT prepend
  // "THE SYSTEM SHALL" — doing so produces broken grammar like
  // "THE SYSTEM SHALL Language ... should model ...".
  //
  // A requirement is treated as self-contained if it:
  //   - contains a modal/EARS keyword (shall/should/must/will/when/while/if/
  //     where), OR
  //   - already starts with an explicit subject phrase ("the system ...",
  //     "the simulator ...", or any Capitalized-word followed by a lowercase
  //     word — i.e. a noun phrase that already has its own verb).
  const hasModal = /\b(shall|should|must|will|when |while |if |where )\b/.test(lower);
  const startsWithSubject =
    /^the\s+\w+/i.test(raw) || /^[A-Z][a-z]+\s+[a-z]+/.test(raw);

  let statement: string;
  if (hasModal) {
    // Already an EARS-style statement — keep it verbatim (just normalize the
    // period below). Optionally normalize a leading "should" to "shall" tone is
    // avoided to preserve the author's wording.
    statement = `${body}.`;
  } else if (startsWithSubject) {
    // Has a subject but no modal (e.g. "Output data includes ..."). Insert
    // "shall" after the subject's first verb is risky; instead, phrase it as a
    // requirement on that subject without the generic "THE SYSTEM" prefix.
    statement = `${body}.`;
  } else {
    // Bare imperative / capability phrase (e.g. "support OAuth login").
    statement = `THE SYSTEM SHALL ${body}.`;
  }

  if (/\b(never|not|only|at most|at least|must not|always)\b/.test(lower)) {
    kind = 'constraint';
  }
  if (/\b(invariant|consistent|maintain|preserve)\b/.test(lower)) {
    kind = 'invariant';
  }
  if (/\b(empty|invalid|error|edge|boundary|null|missing|fail)\b/.test(lower)) {
    kind = 'edge_case';
  }

  return {
    id: `prop-${(index + 1).toString().padStart(2, '0')}`,
    statement,
    kind,
    acceptance: `Verifiable: ${body}.`,
  };
}

/**
 * Coerce a requirements input of unknown shape into a clean string[].
 * Models pass this field inconsistently: a real array, a single string, a
 * newline/semicolon-delimited blob, null/undefined, or an array of objects.
 * This must never throw — a bad requirements value should still create a spec.
 */
export function normalizeRequirements(input: unknown): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const v = o.statement ?? o.requirement ?? o.text ?? o.description ?? o.title;
          return typeof v === 'string' ? v.trim() : JSON.stringify(item);
        }
        return String(item).trim();
      })
      .filter((s) => s.length > 0);
  }
  if (typeof input === 'string') {
    // Split a delimited blob into separate requirements; fall back to one item.
    const parts = input
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*[-*\d.)\]]+\s*/, '').trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : [input.trim()].filter((s) => s.length > 0);
  }
  const s = String(input).trim();
  return s ? [s] : [];
}

export function createSpec(
  workspacePath: string,
  params: {
    title: string;
    type: Spec['type'];
    requirements: unknown;
    properties?: SpecProperty[];
    notes?: string;
    /** When true, start the staged workflow at the requirements phase. */
    staged?: boolean;
    /** Optionally start staging at a specific phase (e.g. 'design' for a
     * user-chosen design-first flow). Defaults to 'requirements' when staged. */
    startPhase?: 'requirements' | 'design';
  }
): Spec {
  const specLogger = logger.child({ component: 'specs', operation: 'create' });

  // Coerce requirements into a clean string[] — models sometimes pass a single
  // string, a delimited blob, null, or objects. Never let this crash createSpec.
  const requirements = normalizeRequirements(params.requirements);

  specLogger.info('Creating spec', {
    title: params.title,
    type: params.type,
    requirementCount: requirements.length,
    staged: !!params.staged,
  });

  const id = uniqueSpecId(workspacePath, params.title, params.type);

  // Derive structured properties from requirements if not explicitly provided.
  const properties =
    params.properties && params.properties.length > 0
      ? params.properties
      : requirements.map((r, i) => toEarsProperty(r, i));

  const spec: Spec = {
    id,
    title: params.title,
    type: params.type,
    status: 'draft',
    // In staged mode we begin at requirements (or a caller-chosen startPhase,
    // e.g. 'design' for design-first) and gate each subsequent phase on user
    // approval. Non-staged (legacy) specs are immediately 'ready'.
    phase: params.staged ? (params.startPhase ?? 'requirements') : 'ready',
    requirements,
    properties,
    tasks: [],
    notes: params.notes,
    approvals: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const specDir = path.join(getSpecsDir(workspacePath), id);
  fs.mkdirSync(specDir, { recursive: true });

  writeSpecMarkdown(specDir, spec);
  fs.writeFileSync(path.join(specDir, 'spec.json'), JSON.stringify(spec, null, 2));

  if (params.notes) {
    fs.writeFileSync(path.join(specDir, 'notes.md'), `# Notes\n\n${params.notes}\n`);
  }

  specLogger.info('Spec created successfully', {
    specId: id,
    title: params.title,
    propertyCount: properties.length,
    specDir,
  });

  return spec;
}

/** Render requirements.md (EARS properties), design.md, and tasks.md. */
function writeSpecMarkdown(specDir: string, spec: Spec): void {
  const props = spec.properties && spec.properties.length > 0 ? spec.properties : [];
  const requirementsMd =
    `# ${spec.title}\n\n` +
    `**Type:** ${spec.type}  ·  **Status:** ${spec.status}` +
    (spec.phase ? `  ·  **Phase:** ${spec.phase}` : '') + `\n\n` +
    `## Acceptance Properties (EARS)\n\n` +
    (props.length > 0
      ? props
          .map((p) => `- **${p.id}** (${p.kind ?? 'functional'}): ${p.statement}${p.acceptance ? `\n  - _Acceptance:_ ${p.acceptance}` : ''}`)
          .join('\n')
      : spec.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')) +
    '\n';
  fs.writeFileSync(path.join(specDir, 'requirements.md'), requirementsMd);

  // design.md — only meaningful once the design phase has produced content,
  // but we always write the file so the three-document set is consistent.
  const designMd = spec.design && spec.design.trim().length > 0
    ? `# Design: ${spec.title}\n\n${spec.design.trim()}\n`
    : `# Design: ${spec.title}\n\n_Design not authored yet. It will be written after requirements are approved._\n`;
  fs.writeFileSync(path.join(specDir, 'design.md'), designMd);

  const tasksMd = renderTasksMarkdown(spec);
  fs.writeFileSync(path.join(specDir, 'tasks.md'), tasksMd);
}

/**
 * TASKS.MD IS THE SOURCE OF TRUTH FOR TASK STATE.
 *
 * Task progress is tracked by editing the checkbox marker in tasks.md rather
 * than by calling status tools. The agent just reads the file and rewrites one
 * character, which is far more reliable than a tool round-trip: the state is
 * visible, diffable, hand-editable, and survives anything that goes wrong with
 * a tool call.
 *
 * Three states, all valid GitHub-flavoured markdown checkboxes:
 *   - [ ]  todo
 *   - [~]  in progress
 *   - [x]  done
 *
 * The render/parse pair below must round-trip: whatever renderTasksMarkdown
 * writes, parseTasksMarkdown must read back identically. Task ids are written
 * explicitly as a bold prefix so `dependsOn` references stay stable across
 * edits.
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

export function renderTasksMarkdown(spec: Spec): string {
  const header =
    `# Tasks for: ${spec.title}\n\n` +
    `> Progress is tracked by the checkbox on each task.\n` +
    `> \`- [ ]\` not started · \`- [~]\` in progress · \`- [x]\` done.\n` +
    `> Edit the marker directly to update status — this file is the source of truth.\n\n`;

  if (spec.tasks.length === 0) {
    return header + `_No tasks yet. The agent will populate this._\n`;
  }
  const lines = spec.tasks.map((t) => {
    let line = `- [${STATUS_TO_MARKER[t.status] ?? ' '}] **${t.id}** ${t.title}`;
    if (t.targetFiles && t.targetFiles.length > 0) line += `\n  - Files: ${t.targetFiles.join(', ')}`;
    if (t.dependsOn && t.dependsOn.length > 0) line += `\n  - Depends on: ${t.dependsOn.join(', ')}`;
    if (t.satisfiesProperties && t.satisfiesProperties.length > 0) line += `\n  - Satisfies: ${t.satisfiesProperties.join(', ')}`;
    if (t.acceptance) line += `\n  - Done when: ${t.acceptance}`;
    // Nested sub-tasks render as an indented checklist.
    if (t.subTasks && t.subTasks.length > 0) {
      for (const st of t.subTasks) {
        line += `\n  - [${STATUS_TO_MARKER[st.status] ?? ' '}] ${st.title}` + (st.acceptance ? ` — _${st.acceptance}_` : '');
      }
    }
    return line;
  });
  return header + `${lines.join('\n')}\n`;
}

/**
 * Parse tasks.md back into structured tasks. Tolerant by design — a human or a
 * model editing this file by hand should not be able to break it:
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
      // A new top-level task.
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
      // An indented checkbox is a sub-task of the current task.
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

    // Indented metadata bullets.
    const meta = /^\s+[-*]\s+(Files|Depends on|Satisfies|Done when):\s*(.+)$/i.exec(raw);
    if (!meta) continue;
    const key = meta[1].toLowerCase();
    const value = meta[2].trim();
    const list = () => value.split(',').map((s) => s.trim()).filter(Boolean);
    if (key === 'files') current.targetFiles = list();
    else if (key === 'depends on') current.dependsOn = list();
    else if (key === 'satisfies') current.satisfiesProperties = list();
    else if (key === 'done when') current.acceptance = value;
  }

  return tasks;
}

export function readSpec(workspacePath: string, specId: string): Spec | null {
  logger.debug('Reading spec', { specId, workspacePath });

  if (!isSafeSpecId(specId)) {
    logger.warn('Rejected unsafe spec id', { specId });
    return null;
  }

  const specPath = path.join(getSpecsDir(workspacePath), specId, 'spec.json');
  if (!fs.existsSync(specPath)) {
    logger.debug('Spec not found', { specId, specPath });
    return null;
  }
  try {
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Spec;

    // The markdown documents are authoritative for their own content, so
    // overlay them onto the JSON metadata. spec.json is only a fallback for
    // specs written before the markdown-first workflow (and for the fields
    // that have no markdown home, like id/type/status/phase).
    const specDir = path.dirname(specPath);
    overlayMarkdown(specDir, spec);

    logger.debug('Spec read successfully', { specId, title: spec.title, tasks: spec.tasks?.length ?? 0 });
    return spec;
  } catch (error) {
    logger.error('Failed to parse spec JSON', { 
      specId, 
      specPath,
      error: error instanceof Error ? error.message : String(error) 
    });
    return null;
  }
}

/**
 * Pull requirement statements out of requirements.md.
 *
 * This exists because the design-first flow had NO way to persist requirements:
 * `create_spec` was the only writer, and by the time requirements were derived
 * (after the design) it had already been called — so specs authored design-first
 * ended up with an empty requirements list no matter what the agent did. Now the
 * agent just writes requirements.md and this reads it back.
 *
 * Deliberately simple: every top-level list item (bulleted or numbered) counts
 * as one requirement. Bold ids/labels and EARS "(kind)" prefixes are stripped so
 * the text reads cleanly in the UI. Headers, blockquotes and metadata lines are
 * skipped.
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
    if (/^_?Acceptance:/i.test(text)) continue;
    // "**P1** (functional): statement" → "statement"
    text = text.replace(/^\*\*(.+?)\*\*\s*/, '');
    text = text.replace(/^\((?:functional|non-functional|nfr|perf|security)\)\s*:?\s*/i, '');
    text = text.replace(/^:\s*/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Overlay the on-disk markdown documents onto a spec loaded from spec.json.
 *
 * tasks.md owns task state and design.md owns the design prose, so whatever is
 * on disk wins — that's what makes hand-editing (or the agent flipping a `[ ]`
 * to `[x]`) actually take effect. Falls back to the JSON values when a document
 * is missing or hasn't been authored yet, so older specs still load.
 */
function overlayMarkdown(specDir: string, spec: Spec): void {
  // --- tasks.md -> spec.tasks ---
  try {
    const tasksPath = path.join(specDir, 'tasks.md');
    if (fs.existsSync(tasksPath)) {
      const parsed = parseTasksMarkdown(fs.readFileSync(tasksPath, 'utf8'));
      // An empty parse means the file is still the "no tasks yet" placeholder;
      // don't let that wipe tasks that exist in JSON.
      if (parsed.length > 0) {
        // Carry over fields the markdown doesn't represent (e.g. agent,
        // verificationNote) by merging on task id.
        const byId = new Map((spec.tasks ?? []).map((t) => [t.id, t]));
        spec.tasks = parsed.map((t) => {
          const prev = byId.get(t.id);
          return prev ? { ...prev, ...t } : t;
        });
      }
    }
  } catch (error) {
    logger.warn('Could not parse tasks.md; falling back to spec.json tasks', {
      specDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- requirements.md -> spec.requirements ---
  try {
    const reqPath = path.join(specDir, 'requirements.md');
    if (fs.existsSync(reqPath)) {
      const parsed = parseRequirementsMarkdown(fs.readFileSync(reqPath, 'utf8'));
      // Don't let an unauthored placeholder wipe requirements held in JSON.
      if (parsed.length > 0) spec.requirements = parsed;
    }
  } catch (error) {
    logger.warn('Could not parse requirements.md; falling back to spec.json', {
      specDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- design.md -> spec.design ---
  try {
    const designPath = path.join(specDir, 'design.md');
    if (fs.existsSync(designPath)) {
      const raw = fs.readFileSync(designPath, 'utf8');
      // Strip the generated H1 and ignore the not-yet-authored placeholder.
      const body = raw.replace(/^#\s+Design:.*\n+/, '').trim();
      if (body && !/^_Design not authored yet\./.test(body)) {
        spec.design = body;
      }
    }
  } catch {
    /* keep the JSON design */
  }
}

export function listSpecs(workspacePath: string): Spec[] {
  logger.debug('Listing specs', { workspacePath });
  
  const specsDir = getSpecsDir(workspacePath);
  if (!fs.existsSync(specsDir)) {
    logger.debug('Specs directory does not exist', { specsDir });
    return [];
  }
  const dirs = fs.readdirSync(specsDir, { withFileTypes: true });
  const specs: Spec[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue; // skip stray files (.DS_Store, etc.)
    const spec = readSpec(workspacePath, d.name);
    if (spec) specs.push(spec);
  }
  
  logger.info('Specs listed', { workspacePath, specCount: specs.length });
  return specs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateSpec(workspacePath: string, specId: string, updates: Partial<Spec>): Spec | null {
  logger.info('Updating spec', { specId, updates: Object.keys(updates) });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot update spec: not found', { specId });
    return null;
  }
  const updated: Spec = { ...spec, ...updates, updatedAt: new Date().toISOString() };
  const specDir = path.join(getSpecsDir(workspacePath), specId);
  const specPath = path.join(specDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(updated, null, 2));

  // Re-render tasks.md / requirements.md / design.md when relevant fields change.
  if (updates.tasks) {
    fs.writeFileSync(path.join(specDir, 'tasks.md'), renderTasksMarkdown(updated));
    logger.debug('Updated tasks.md', { specId, taskCount: updated.tasks.length });
  }
  if (updates.properties || updates.requirements || updates.design || updates.phase || updates.status) {
    writeSpecMarkdown(specDir, updated);
  }

  logger.info('Spec updated successfully', { 
    specId, 
    title: updated.title,
    status: updated.status 
  });

  return updated;
}

export function addTaskToSpec(
  workspacePath: string,
  specId: string,
  taskTitle: string,
  meta?: {
    targetFiles?: string[];
    dependsOn?: string[];
    satisfiesProperties?: string[];
    acceptance?: string;
  }
): Spec | null {
  logger.info('Adding task to spec', { specId, taskTitle });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot add task: spec not found', { specId });
    return null;
  }
  const task: SpecTask = {
    id: `task-${uuidv4().slice(0, 8)}`,
    title: taskTitle,
    status: 'todo',
    targetFiles: meta?.targetFiles,
    dependsOn: meta?.dependsOn,
    satisfiesProperties: meta?.satisfiesProperties,
    acceptance: meta?.acceptance,
  };
  
  const updated = updateSpec(workspacePath, specId, { tasks: [...spec.tasks, task] });
  
  if (updated) {
    logger.info('Task added to spec successfully', { 
      specId, 
      taskId: task.id,
      taskTitle 
    });
  }
  
  return updated;
}

/**
 * Update the status of a specific task in a spec
 */
export function updateTaskStatus(
  workspacePath: string,
  specId: string,
  taskId: string,
  status: SpecTask['status']
): Spec | null {
  logger.info('Updating task status', { specId, taskId, status });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot update task: spec not found', { specId });
    return null;
  }
  
  const taskIndex = spec.tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    logger.warn('Cannot update task: task not found', { specId, taskId });
    return null;
  }
  
  const updatedTasks = [...spec.tasks];
  updatedTasks[taskIndex] = { ...updatedTasks[taskIndex], status };
  
  const updated = updateSpec(workspacePath, specId, { tasks: updatedTasks });
  
  if (updated) {
    logger.info('Task status updated successfully', { 
      specId, 
      taskId,
      status,
      taskTitle: updatedTasks[taskIndex].title
    });
  }
  
  return updated;
}

/**
 * Get the next task to execute from a spec (first task with status 'todo')
 */
export function getNextTask(workspacePath: string, specId: string): SpecTask | null {
  logger.debug('Getting next task', { specId });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot get next task: spec not found', { specId });
    return null;
  }
  
  const doneIds = new Set(spec.tasks.filter((t) => t.status === 'done').map((t) => t.id));

  // Prefer a todo task whose dependencies are all satisfied (topological order).
  const ready = spec.tasks.find(
    (t) => t.status === 'todo' && (!t.dependsOn || t.dependsOn.every((d) => doneIds.has(d)))
  );
  // Fall back to any todo task if dependency metadata is incomplete/cyclic.
  const nextTask = ready || spec.tasks.find((t) => t.status === 'todo') || null;
  
  if (nextTask) {
    logger.info('Next task found', { 
      specId, 
      taskId: nextTask.id,
      taskTitle: nextTask.title,
      gatedByDeps: !ready && !!nextTask.dependsOn?.length,
    });
  } else {
    logger.info('No more tasks to execute', { specId });
  }
  
  return nextTask || null;
}

/**
 * Check if all tasks in a spec are complete
 */
export function areAllTasksComplete(workspacePath: string, specId: string): boolean {
  logger.debug('Checking if all tasks complete', { specId });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot check tasks: spec not found', { specId });
    return false;
  }
  
  const allComplete = spec.tasks.length > 0 && spec.tasks.every(t => t.status === 'done');
  
  logger.debug('Task completion check result', { 
    specId, 
    allComplete,
    totalTasks: spec.tasks.length,
    completedTasks: spec.tasks.filter(t => t.status === 'done').length
  });
  
  return allComplete;
}

/**
 * Lock a spec to a session (store the session ID in the spec)
 * This is used for Spec Session threads to track which session is working on which spec
 */
export function lockSpecToSession(
  workspacePath: string,
  specId: string,
  sessionId: string
): Spec | null {
  logger.info('Locking spec to session', { specId, sessionId });
  
  const spec = readSpec(workspacePath, specId);
  if (!spec) {
    logger.warn('Cannot lock spec: spec not found', { specId });
    return null;
  }
  
  // Store the session ID in the spec's project ID field (repurposing it for session tracking)
  const updated = updateSpec(workspacePath, specId, { projectId: sessionId });
  
  if (updated) {
    logger.info('Spec locked to session successfully', { specId, sessionId });
  }
  
  return updated;
}

// --- Staged three-document workflow ----------------------------------------
// The spec is authored one document at a time, each gated by user approval:
//   requirements → design → tasks → ready
// The agent must read the prior document(s) before authoring the next, and may
// not advance a phase until the user approves the current one.

const PHASE_ORDER: SpecPhase[] = ['requirements', 'design', 'tasks', 'ready'];
type SpecPhaseLite = SpecPhase;

/** Write/replace the design document. Allowed only at the design phase (or
 * later). A spec created design-first (startPhase: 'design') is already in the
 * design phase, so this works for both orderings; the approve_spec_phase gates
 * still govern advancement. */
export function setSpecDesign(
  workspacePath: string,
  specId: string,
  design: string
): { ok: boolean; spec?: Spec; error?: string } {
  const spec = readSpec(workspacePath, specId);
  if (!spec) return { ok: false, error: `Spec ${specId} not found.` };

  const phase = spec.phase ?? 'ready';
  if (phase === 'requirements') {
    return {
      ok: false,
      error:
        'Requirements have not been approved yet. Present the requirements to the user and call approve_spec_phase("requirements") once they sign off, THEN author the design. (For a design-first spec, create it with startPhase "design".)',
    };
  }
  const updated = updateSpec(workspacePath, specId, { design, phase: 'design' });
  return updated ? { ok: true, spec: updated } : { ok: false, error: 'Failed to save design.' };
}

/**
 * Approve the current phase and advance to the next. This is the user's gate.
 * Returns the new phase so the agent knows what it may author next.
 */
export function approveSpecPhase(
  workspacePath: string,
  specId: string,
  phase: SpecPhaseLite
): { ok: boolean; spec?: Spec; nextPhase?: SpecPhaseLite; error?: string; alreadyAdvanced?: boolean } {
  const spec = readSpec(workspacePath, specId);
  if (!spec) return { ok: false, error: `Spec ${specId} not found.` };

  const currentPhase = spec.phase ?? 'ready';

  // If the spec has already moved past the phase being approved, this is a
  // redundant call (a common model stall). Report the TRUTH so the agent stops
  // re-approving and does the actual pending work instead.
  if (PHASE_ORDER.indexOf(currentPhase) > PHASE_ORDER.indexOf(phase)) {
    const pending = pendingActionFor(spec);
    return {
      ok: true,
      alreadyAdvanced: true,
      spec,
      nextPhase: currentPhase,
      error: `"${phase}" was already approved — the spec is now in the "${currentPhase}" phase. Do NOT approve again. ${pending}`,
    };
  }

  // Guard: can't approve tasks before any tasks exist.
  if (phase === 'tasks' && spec.tasks.length === 0) {
    return { ok: false, error: 'No tasks have been authored yet. Add tasks before approving the tasks phase.' };
  }
  if (phase === 'design' && (!spec.design || spec.design.trim().length === 0)) {
    return { ok: false, error: 'No design has been authored yet. Write the design with set_spec_design before approving the design phase.' };
  }

  const approvals = { ...(spec.approvals ?? {}) };
  if (phase === 'requirements') approvals.requirements = true;
  if (phase === 'design') approvals.design = true;
  if (phase === 'tasks') approvals.tasks = true;

  const idx = PHASE_ORDER.indexOf(phase);
  const nextPhase = PHASE_ORDER[Math.min(idx + 1, PHASE_ORDER.length - 1)];

  const updated = updateSpec(workspacePath, specId, {
    approvals,
    phase: nextPhase,
    // Once tasks are approved the spec is ready to execute.
    status: nextPhase === 'ready' ? 'in_progress' : spec.status,
  });
  return updated
    ? { ok: true, spec: updated, nextPhase }
    : { ok: false, error: 'Failed to record approval.' };
}

/** Describe the concrete next authoring action for a spec, given its phase. */
export function pendingActionFor(spec: Spec): string {
  const phase = spec.phase ?? 'ready';
  if (phase === 'design') {
    const hasDesign = !!spec.design && spec.design.trim().length > 0;
    return hasDesign
      ? 'The design is written; present it to the user for approval, then call approve_spec_phase(spec_id, "design").'
      : 'You must now WRITE the design — write the full design document directly in your reply as markdown. The app saves it to design.md automatically; do not call a tool for it.';
  }
  if (phase === 'tasks') {
    return spec.tasks.length === 0
      ? 'You must now CREATE tasks by calling add_spec_task (or create task_details), then present them and call approve_spec_phase(spec_id, "tasks").'
      : 'Tasks exist; present them for approval, then call approve_spec_phase(spec_id, "tasks").';
  }
  if (phase === 'requirements') {
    return 'Present the requirements for approval, then call approve_spec_phase(spec_id, "requirements").';
  }
  return 'The spec is ready — begin executing tasks in dependency order.';
}

/** Add ordered sub-tasks to an existing task. */
export function addSubTasks(
  workspacePath: string,
  specId: string,
  taskId: string,
  subTasks: Array<{ title: string; acceptance?: string }>
): Spec | null {
  const spec = readSpec(workspacePath, specId);
  if (!spec) return null;
  const idx = spec.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;

  const existing = spec.tasks[idx].subTasks ?? [];
  const additions: SpecSubTask[] = subTasks.map((s) => ({
    id: `sub-${uuidv4().slice(0, 8)}`,
    title: s.title,
    status: 'todo',
    acceptance: s.acceptance,
  }));
  const tasks = [...spec.tasks];
  tasks[idx] = { ...tasks[idx], subTasks: [...existing, ...additions] };
  return updateSpec(workspacePath, specId, { tasks });
}

/** Update a single sub-task's status (and roll the parent up if all done). */
export function updateSubTaskStatus(
  workspacePath: string,
  specId: string,
  taskId: string,
  subTaskId: string,
  status: SpecSubTask['status']
): Spec | null {
  const spec = readSpec(workspacePath, specId);
  if (!spec) return null;
  const tIdx = spec.tasks.findIndex((t) => t.id === taskId);
  if (tIdx === -1) return null;
  const subs = [...(spec.tasks[tIdx].subTasks ?? [])];
  const sIdx = subs.findIndex((s) => s.id === subTaskId);
  if (sIdx === -1) return null;
  subs[sIdx] = { ...subs[sIdx], status };

  const tasks = [...spec.tasks];
  tasks[tIdx] = { ...tasks[tIdx], subTasks: subs };
  return updateSpec(workspacePath, specId, { tasks });
}
