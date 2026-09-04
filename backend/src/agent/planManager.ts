/**
 * The working plan, owned by the SERVER rather than by the model.
 *
 * TWO FAILURES THIS EXISTS TO FIX
 *
 * 1. RE-SENDING THE PLAN TO MARK ONE STEP.
 *    `update_plan` took a full list of steps and replaced whatever was there.
 *    So the only way for a model to tick step 3 was to retype all eight steps
 *    with step 3 changed — and models are not reliable transcriptionists. A word
 *    would drift ("Add the sync queue" → "Add sync queue"), and because the plan
 *    was identified by the text of its steps, the drifted version was a DIFFERENT
 *    plan. The UI then showed two plans, the old one frozen at 2/8 and a new one
 *    at 3/8, and the user watched their progress apparently restart. Worse, any
 *    step the model failed to retype was silently deleted.
 *
 * 2. ABANDONING THE PLAN.
 *    Nothing ever showed the model its own plan again. Twenty tool calls later
 *    the plan was far outside the model's working attention, so it simply
 *    stopped updating it — and a plan that stops being updated is worse than no
 *    plan, because the UI keeps presenting stale progress as current.
 *
 * THE FIX, IN TWO HALVES
 *
 *  - Steps have STABLE IDS assigned here, and the tool accepts targeted
 *    operations (`set_status`, `add_steps`, `remove_steps`) so ticking a box is
 *    one small call that cannot lose anything.
 *  - When a full `steps` list IS sent, it is MERGED, not replaced: incoming
 *    steps are matched to existing ones by id and then by normalized title, so
 *    re-typing the plan updates it in place instead of forking it. Dropped
 *    unfinished steps are reported back to the model rather than deleted
 *    quietly.
 *  - The current plan is rendered into the live state block on EVERY model call
 *    (see runtimeState), so it can never drift out of attention.
 */

import { getSessionPlan, saveSessionPlan } from '../session/manager';
import { logger } from '../utils/logger';

export type PlanStatus = 'todo' | 'in_progress' | 'done' | 'blocked';

export interface ManagedPlanStep {
  /** Stable across every update. This is what makes a targeted tick possible. */
  id: string;
  title: string;
  status: PlanStatus;
  /** Optional one-line note: why it is blocked, what was decided, what is left. */
  note?: string;
  /** When the step first appeared, so the UI can show a stable order. */
  createdAt: number;
  updatedAt: number;
}

export interface PlanUpdateOutcome {
  steps: ManagedPlanStep[];
  /** Notes for the MODEL: what merged, what was dropped, what to do differently. */
  notes: string[];
  /** True when this call created a genuinely new plan rather than updating one. */
  replaced: boolean;
  /**
   * True when the previous plan was SEALED and this is a fresh one.
   *
   * The client uses the absence of shared step ids to decide whether a
   * `plan_updated` event is progress on the current plan or a new plan below
   * it, so a sealed plan must hand back steps whose ids overlap nothing.
   */
  freshPlan: boolean;
}

/**
 * Titles are compared loosely on purpose.
 *
 * The whole problem is that a model retypes a step slightly differently. Case,
 * punctuation, articles, trailing ellipses and the gerund/imperative swap
 * ("Adding the queue" vs "Add the queue") are all noise. Matching through that
 * noise is what turns a re-typed plan into an UPDATE instead of a fork.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_~"'’]/g, '')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\b(\w+)ing\b/g, '$1')       // "adding" ~ "add"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Word-overlap similarity, 0..1. Used only after exact-normalized matching. */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/** Close enough to be the same step said differently. */
const SIMILARITY_THRESHOLD = 0.7;

let idCounter = 0;
function newStepId(): string {
  idCounter = (idCounter + 1) % 100000;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function coerceStatus(value: unknown): PlanStatus {
  const s = String(value ?? 'todo').toLowerCase();
  if (s === 'done' || s === 'complete' || s === 'completed' || s === 'finished') return 'done';
  if (s === 'in_progress' || s === 'in progress' || s === 'active' || s === 'doing' || s === 'running') return 'in_progress';
  if (s === 'blocked' || s === 'stuck' || s === 'waiting') return 'blocked';
  return 'todo';
}

/** Read a session's plan, upgrading older records that have no step ids. */
export function loadPlan(sessionId: string): ManagedPlanStep[] {
  try {
    const raw = getSessionPlan(sessionId) as unknown as Array<Partial<ManagedPlanStep> & { title?: string; status?: string }>;
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw
      .filter((s) => s && typeof s.title === 'string' && s.title.trim())
      .map((s) => ({
        id: typeof s.id === 'string' && s.id ? s.id : newStepId(),
        title: String(s.title).trim(),
        status: coerceStatus(s.status),
        note: typeof s.note === 'string' ? s.note : undefined,
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : now,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : now,
      }));
  } catch {
    return [];
  }
}

export function persistPlan(sessionId: string, steps: ManagedPlanStep[]): void {
  try {
    saveSessionPlan(sessionId, steps as never);
  } catch (err) {
    logger.warn('Could not persist the working plan', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface PlanUpdateInput {
  /** A full list of steps. MERGED into the existing plan, never blindly replacing it. */
  steps?: Array<{ id?: string; title?: string; status?: string; note?: string }>;
  /** Targeted status changes — the cheap, safe way to tick a box. */
  setStatus?: Array<{ id?: string; title?: string; status?: string; note?: string }>;
  /** Steps to append. */
  addSteps?: Array<{ title?: string; status?: string; note?: string }>;
  /** Step ids (or titles) to remove. */
  removeSteps?: string[];
  /**
   * Explicit permission to throw the old plan away. Without it, a `steps` list
   * that drops unfinished work keeps that work and says so.
   */
  replace?: boolean;
  /**
   * "This is a NEW plan for NEW work, not a revision of the old one."
   *
   * See startsNewPlan() for why this exists and why it is also inferred.
   */
  newPlan?: boolean;
}

/** Find the existing step an incoming one refers to. */
function matchStep(
  existing: ManagedPlanStep[],
  incoming: { id?: string; title?: string },
  claimed: Set<string>,
): ManagedPlanStep | null {
  if (incoming.id) {
    const byId = existing.find((s) => s.id === incoming.id && !claimed.has(s.id));
    if (byId) return byId;
  }
  const title = (incoming.title ?? '').trim();
  if (!title) return null;

  const norm = normalizeTitle(title);
  const exact = existing.find((s) => !claimed.has(s.id) && normalizeTitle(s.title) === norm);
  if (exact) return exact;

  // Fall back to the closest step above the similarity threshold. This is what
  // absorbs a genuinely reworded step instead of forking the plan.
  let best: ManagedPlanStep | null = null;
  let bestScore = SIMILARITY_THRESHOLD;
  for (const s of existing) {
    if (claimed.has(s.id)) continue;
    const score = titleSimilarity(s.title, title);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

/**
 * Apply an update to a session's plan and persist the result.
 *
 * Always returns the FULL new plan plus notes written for the model, because
 * the model's next decision depends on knowing exactly what its call did.
 */
/**
 * Is this `steps` list a NEW plan, or a revision of the one already there?
 *
 * THE BUG THIS EXISTS TO KILL
 *
 * The plan is stored per THREAD, and a thread outlives the task that started
 * it. Ask for a second, unrelated piece of work in the same conversation and
 * the agent draws up a second plan — which the merge treated as a revision of
 * the first. So the finished eight-step plan grew a ninth, tenth and eleventh
 * step, the progress count read "8/11 done" for work that had nothing to do
 * with the first eight, and the Plans panel showed one enormous plan whose top
 * half belonged to a task that ended half an hour ago.
 *
 * A new plan is recognisable: it matches NOTHING in the existing plan, and the
 * existing plan has no unfinished work left in it. Both halves matter. Matching
 * nothing on its own is what a genuine restructure looks like too — and a
 * restructure that abandons unfinished steps is exactly the case the
 * anti-amnesia rule exists to catch — so a plan with work still outstanding is
 * always treated as a revision unless the model says otherwise with newPlan.
 */
function startsNewPlan(
  existing: ManagedPlanStep[],
  matchedCount: number,
  input: PlanUpdateInput,
): boolean {
  if (input.newPlan === true) return existing.length > 0;
  if (existing.length === 0) return false;
  if (matchedCount > 0) return false;
  return existing.every((s) => s.status === 'done');
}

export function applyPlanUpdate(sessionId: string, input: PlanUpdateInput): PlanUpdateOutcome {
  const existing = loadPlan(sessionId);
  const now = Date.now();
  const notes: string[] = [];
  let replaced = false;
  let freshPlan = false;

  let next: ManagedPlanStep[] = existing.map((s) => ({ ...s }));

  // --- Targeted status changes --------------------------------------------
  if (input.setStatus && input.setStatus.length > 0) {
    const claimed = new Set<string>();
    const missed: string[] = [];
    for (const change of input.setStatus) {
      const target = matchStep(next, change, claimed);
      if (!target) { missed.push(change.title ?? change.id ?? '(unnamed)'); continue; }
      claimed.add(target.id);
      target.status = coerceStatus(change.status);
      if (change.note !== undefined) target.note = String(change.note) || undefined;
      target.updatedAt = now;
    }
    if (missed.length > 0) {
      notes.push(
        `No step matched: ${missed.join(', ')}. The plan's steps are listed below with their ids — ` +
        `use an id to be unambiguous, or add the step with add_steps if it is genuinely new.`,
      );
    }
  }

  // --- Additions -----------------------------------------------------------
  if (input.addSteps && input.addSteps.length > 0) {
    for (const add of input.addSteps) {
      const title = (add.title ?? '').trim();
      if (!title) continue;
      if (matchStep(next, { title }, new Set())) {
        notes.push(`"${title}" already exists in the plan, so it was not added twice.`);
        continue;
      }
      next.push({
        id: newStepId(), title, status: coerceStatus(add.status),
        note: add.note ? String(add.note) : undefined, createdAt: now, updatedAt: now,
      });
    }
  }

  // --- Removals ------------------------------------------------------------
  if (input.removeSteps && input.removeSteps.length > 0) {
    for (const ref of input.removeSteps) {
      const target = matchStep(next, { id: ref, title: ref }, new Set());
      if (target) next = next.filter((s) => s.id !== target.id);
    }
  }

  // --- A full list -----------------------------------------------------------
  if (input.steps && input.steps.length > 0) {
    // A dry pass first: how much of this list refers to steps that already
    // exist? That count is what separates "the plan changed" from "this is a
    // different plan entirely" — see startsNewPlan.
    const probeClaimed = new Set<string>();
    let matchedCount = 0;
    for (const incoming of input.steps) {
      const title = (incoming.title ?? '').trim();
      if (!title) continue;
      const m = matchStep(next, incoming, probeClaimed);
      if (m) { probeClaimed.add(m.id); matchedCount++; }
    }

    if (startsNewPlan(next, matchedCount, input)) {
      // SEAL the old plan and start a fresh one. Every step gets a brand-new
      // id, which is precisely what tells the client this is a plan BELOW the
      // previous one rather than more steps inside it.
      const sealed = next;
      const done = sealed.filter((s) => s.status === 'done').length;
      next = input.steps
        .filter((incoming) => (incoming.title ?? '').trim())
        .map((incoming) => ({
          id: newStepId(),
          title: String(incoming.title).trim(),
          status: coerceStatus(incoming.status),
          note: incoming.note ? String(incoming.note) : undefined,
          createdAt: now,
          updatedAt: now,
        }));
      freshPlan = true;
      replaced = true;
      notes.push(
        `This is a NEW plan. The previous one (${done}/${sealed.length} done) was finished and has been ` +
        `sealed rather than extended, so its steps are kept in the Plans panel as their own plan and the ` +
        `progress count below refers only to the ${next.length} step(s) you just laid out.`,
      );
      // Re-apply the single-in-progress invariant against the new list, then
      // persist and return — none of the merge logic below applies to a plan
      // that shares nothing with what came before.
      const freshActive = next.filter((s) => s.status === 'in_progress');
      if (freshActive.length > 1) {
        for (const s of freshActive.slice(0, -1)) s.status = 'todo';
        notes.push('Only one step may be in progress at a time; the earlier one(s) were set back to todo.');
      }
      persistPlan(sessionId, next);
      return { steps: next, notes, replaced, freshPlan };
    }

    const claimed = new Set<string>();
    const merged: ManagedPlanStep[] = [];
    let sawNew = false;

    for (const incoming of input.steps) {
      const title = (incoming.title ?? '').trim();
      if (!title) continue;
      const match = matchStep(next, incoming, claimed);
      if (match) {
        claimed.add(match.id);
        const status = coerceStatus(incoming.status);
        const changed = match.status !== status || match.title !== title;
        merged.push({
          ...match,
          // Keep the ORIGINAL wording when the retype is merely a rewording of
          // the same step; a plan whose steps keep subtly rephrasing themselves
          // reads as churn even when the work is progressing steadily.
          title: normalizeTitle(match.title) === normalizeTitle(title) ? match.title : title,
          status,
          note: incoming.note !== undefined ? String(incoming.note) || undefined : match.note,
          updatedAt: changed ? now : match.updatedAt,
        });
      } else {
        sawNew = true;
        merged.push({
          id: newStepId(), title, status: coerceStatus(incoming.status),
          note: incoming.note ? String(incoming.note) : undefined, createdAt: now, updatedAt: now,
        });
      }
    }

    // Steps that exist but were NOT in the incoming list.
    const dropped = next.filter((s) => !claimed.has(s.id));
    const droppedUnfinished = dropped.filter((s) => s.status !== 'done');

    if (input.replace) {
      replaced = droppedUnfinished.length > 0 || sawNew;
      next = merged;
      if (droppedUnfinished.length > 0) {
        notes.push(
          `Replaced the plan as instructed. ${droppedUnfinished.length} unfinished step(s) were removed: ` +
          `${droppedUnfinished.map((s) => s.title).join('; ')}.`,
        );
      }
    } else if (droppedUnfinished.length > 0) {
      // THE ANTI-AMNESIA RULE. A model retyping its plan to tick one box
      // routinely omits a step or two. Deleting unfinished work on the strength
      // of a transcription slip is how plans silently shrink until they are
      // finished — so the work is KEPT and the omission is reported.
      next = [...merged, ...droppedUnfinished];
      notes.push(
        `You left ${droppedUnfinished.length} unfinished step(s) out of the list, so they were KEPT rather than deleted: ` +
        `${droppedUnfinished.map((s) => `"${s.title}"`).join(', ')}. ` +
        `If you genuinely mean to abandon them, call update_plan again with replace:true, or remove_steps with their ids.`,
      );
    } else {
      next = merged.concat(dropped.filter((s) => s.status === 'done' && !merged.some((m) => m.id === s.id)));
    }

    // Tell the model about the cheaper call it could have made. This is coaching
    // that actually changes behaviour, because it arrives attached to the result
    // of the expensive call.
    if (!sawNew && dropped.length === 0 && existing.length > 0) {
      const changedCount = merged.filter((m) => {
        const before = existing.find((e) => e.id === m.id);
        return before && before.status !== m.status;
      }).length;
      if (changedCount > 0 && changedCount <= 2) {
        notes.push(
          `This was the same plan with ${changedCount} status change(s), so it updated the existing plan in place. ` +
          `Next time use set_status: [{ id: "…", status: "done" }] — it is one short call and cannot lose a step.`,
        );
      }
    }
  }

  // --- Invariants ----------------------------------------------------------
  // At most one step in progress. Two "in progress" steps is not a plan, it is
  // a model that forgot to close the previous one, and it makes the UI's "now
  // on X" headline pick arbitrarily.
  const active = next.filter((s) => s.status === 'in_progress');
  if (active.length > 1) {
    for (const s of active.slice(0, -1)) s.status = 'todo';
    notes.push(
      `Only one step may be in progress at a time; the earlier one(s) were set back to todo. ` +
      `Mark a step done before starting the next.`,
    );
  }

  persistPlan(sessionId, next);
  return { steps: next, notes, replaced, freshPlan };
}

/** The compact status glyph used in both the tool result and the state block. */
function glyph(status: PlanStatus): string {
  return status === 'done' ? 'x' : status === 'in_progress' ? '~' : status === 'blocked' ? '!' : ' ';
}

/** Render the plan for the model: ids included, because ids are the whole point. */
export function renderPlanForModel(steps: ManagedPlanStep[]): string {
  if (steps.length === 0) return 'The plan is empty.';
  return steps
    .map((s) => `- [${glyph(s.status)}] ${s.id}  ${s.title}${s.note ? `  — ${s.note}` : ''}`)
    .join('\n');
}

/** A one-line progress summary, e.g. "3/8 done · now: Wire the queue". */
export function summarizePlan(steps: ManagedPlanStep[]): string {
  if (steps.length === 0) return 'no plan';
  const done = steps.filter((s) => s.status === 'done').length;
  const active = steps.find((s) => s.status === 'in_progress');
  const blocked = steps.filter((s) => s.status === 'blocked');
  const parts = [`${done}/${steps.length} done`];
  if (active) parts.push(`now: ${active.title}`);
  if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
  return parts.join(' · ');
}

/**
 * The plan section of the live state block.
 *
 * This is the half of the fix that stops plans being ABANDONED: the model is
 * shown its own plan, with ids, on every single model call, so "I forgot there
 * was a plan" stops being possible.
 */
export function buildPlanStateSection(sessionId: string): string {
  const steps = loadPlan(sessionId);
  if (steps.length === 0) return '';

  const done = steps.filter((s) => s.status === 'done').length;
  const active = steps.find((s) => s.status === 'in_progress');
  const remaining = steps.filter((s) => s.status !== 'done');

  const lines = [
    `### Your working plan — ${summarizePlan(steps)}`,
    renderPlanForModel(steps),
  ];

  if (active) {
    lines.push(
      `You are on "${active.title}". When it is finished, mark it with ` +
      `update_plan(set_status: [{ id: "${active.id}", status: "done" }]) and start the next one in the SAME call ` +
      `by adding { id: "<next id>", status: "in_progress" }.`,
    );
  } else if (remaining.length > 0) {
    lines.push(
      `Nothing is marked in progress. Before your next action, mark what you are about to do: ` +
      `update_plan(set_status: [{ id: "${remaining[0].id}", status: "in_progress" }]).`,
    );
  } else if (done === steps.length) {
    lines.push('Every step is done. Say so and stop, or add new steps if the work has grown.');
  }

  lines.push(
    'Never re-send the whole plan to change one status — use set_status with the ids above. ' +
    'Re-typing the list risks losing a step, and it is what makes the progress display appear to restart.',
  );

  return lines.join('\n');
}
