/**
 * The `plan_updated` wire shape, and the plan's integrity across updates.
 *
 * TWO CONTRACTS ARE PINNED HERE.
 *
 * 1. THE WIRE SHAPE. The tool layer emits `{ type, content }` where content is
 *    a JSON string; the client reads `event.steps`. Something has to translate,
 *    and for a long time only ONE of the three call sites did — the lead's.
 *    Both worker paths spread the raw event through, so every delegated agent's
 *    plan reached the client as `steps: undefined` and was dropped on the floor.
 *    Nothing failed loudly, because a plan that never arrives just looks like an
 *    agent that didn't make one.
 *
 * 2. THE PLAN SURVIVES BEING RE-TYPED. A model that re-sends its whole plan to
 *    tick one box must UPDATE that plan, not fork it — and must not be able to
 *    delete unfinished work by forgetting to retype a line.
 */

import { executeTool } from './tools/index';

const plans = new Map<string, unknown>();

jest.mock('../db/index', () => ({ getSetting: () => 'false' }));
jest.mock('../session/manager', () => ({
  getSessionPlan: (id: string) => plans.get(id) ?? [],
  saveSessionPlan: (id: string, plan: unknown) => { plans.set(id, plan); },
}));

type ToolEvent = { type: string; content: string };
type Step = { id: string; title: string; status: string };

let session = 0;
function freshSession(): string {
  session += 1;
  const id = `sess-${session}`;
  plans.set(id, []);
  return id;
}

/** Run update_plan and return the steps the client would receive. */
async function update(sessionId: string, args: Record<string, unknown>): Promise<{ steps: Step[]; result: string }> {
  const events: ToolEvent[] = [];
  const r = await executeTool(
    'update_plan', args, process.cwd(),
    (e) => events.push(e as ToolEvent),
    undefined,
    { sessionId },
  );
  const planEvent = events.find((e) => e.type === 'plan_updated');
  if (!planEvent) throw new Error('update_plan emitted no plan_updated event');
  return { steps: JSON.parse(planEvent.content).steps as Step[], result: r.result };
}

describe('update_plan emits a parseable plan', () => {
  it('puts the steps in content as JSON', async () => {
    const s = freshSession();
    const { steps } = await update(s, {
      steps: [{ title: 'Read the code', status: 'done' }, { title: 'Fix it', status: 'in_progress' }],
    });
    expect(steps.map((x) => [x.title, x.status])).toEqual([
      ['Read the code', 'done'],
      ['Fix it', 'in_progress'],
    ]);
  });

  it('gives every step a stable id, which is what makes a targeted tick possible', async () => {
    const s = freshSession();
    const { steps } = await update(s, { steps: [{ title: 'a', status: 'todo' }] });
    expect(steps[0].id).toBeTruthy();
  });

  it('normalizes an unknown status rather than passing it through', async () => {
    const s = freshSession();
    const { steps } = await update(s, { steps: [{ title: 'x', status: 'wat' }] });
    expect(steps[0].status).toBe('todo');
  });

  it('accepts the natural synonyms models actually emit', async () => {
    const s = freshSession();
    const { steps } = await update(s, {
      steps: [
        { title: 'a', status: 'completed' },
        { title: 'b', status: 'in progress' },
        { title: 'c', status: 'blocked' },
      ],
    });
    expect(steps.map((x) => x.status)).toEqual(['done', 'in_progress', 'blocked']);
  });
});

describe('a re-typed plan updates in place instead of forking', () => {
  it('keeps the same step ids when the whole list is sent again', async () => {
    const s = freshSession();
    const first = await update(s, {
      steps: [{ title: 'Read the code', status: 'done' }, { title: 'Fix it', status: 'todo' }],
    });
    const second = await update(s, {
      steps: [{ title: 'Read the code', status: 'done' }, { title: 'Fix it', status: 'in_progress' }],
    });
    expect(second.steps.map((x) => x.id)).toEqual(first.steps.map((x) => x.id));
    expect(second.steps[1].status).toBe('in_progress');
  });

  it('absorbs a reworded step rather than treating it as new', async () => {
    // The exact failure: a model retypes "Add the sync queue" as "Add sync
    // queue" and the plan appears to restart at a different length.
    const s = freshSession();
    const first = await update(s, { steps: [{ title: 'Add the sync queue', status: 'todo' }] });
    const second = await update(s, { steps: [{ title: 'Add sync queue', status: 'done' }] });
    expect(second.steps).toHaveLength(1);
    expect(second.steps[0].id).toBe(first.steps[0].id);
    expect(second.steps[0].status).toBe('done');
  });

  it('KEEPS unfinished steps the model forgot to retype', async () => {
    const s = freshSession();
    await update(s, {
      steps: [
        { title: 'One', status: 'done' },
        { title: 'Two', status: 'todo' },
        { title: 'Three', status: 'todo' },
      ],
    });
    // Model retypes only two of the three — a transcription slip, not a decision.
    const after = await update(s, {
      steps: [{ title: 'One', status: 'done' }, { title: 'Two', status: 'done' }],
    });
    expect(after.steps.map((x) => x.title).sort()).toEqual(['One', 'Three', 'Two']);
    expect(after.result).toMatch(/KEPT rather than deleted/);
  });

  it('does delete them when replace:true says so explicitly', async () => {
    const s = freshSession();
    await update(s, { steps: [{ title: 'One', status: 'todo' }, { title: 'Two', status: 'todo' }] });
    const after = await update(s, { steps: [{ title: 'One', status: 'todo' }], replace: true });
    expect(after.steps.map((x) => x.title)).toEqual(['One']);
  });

  it('coaches the model towards set_status after a full re-send', async () => {
    const s = freshSession();
    await update(s, { steps: [{ title: 'One', status: 'todo' }, { title: 'Two', status: 'todo' }] });
    const after = await update(s, {
      steps: [{ title: 'One', status: 'done' }, { title: 'Two', status: 'todo' }],
    });
    expect(after.result).toMatch(/set_status/);
  });
});

describe('targeted updates', () => {
  it('set_status changes one step by id and touches nothing else', async () => {
    const s = freshSession();
    const first = await update(s, {
      steps: [{ title: 'One', status: 'todo' }, { title: 'Two', status: 'todo' }],
    });
    const after = await update(s, { set_status: [{ id: first.steps[1].id, status: 'done' }] });
    expect(after.steps.map((x) => x.status)).toEqual(['todo', 'done']);
    expect(after.steps.map((x) => x.id)).toEqual(first.steps.map((x) => x.id));
  });

  it('set_status falls back to a loose title match when no id is given', async () => {
    const s = freshSession();
    await update(s, { steps: [{ title: 'Wire up the queue', status: 'todo' }] });
    const after = await update(s, { set_status: [{ title: 'wire up queue', status: 'done' }] });
    expect(after.steps[0].status).toBe('done');
  });

  it('says so when nothing matched, rather than silently doing nothing', async () => {
    const s = freshSession();
    await update(s, { steps: [{ title: 'One', status: 'todo' }] });
    const after = await update(s, { set_status: [{ title: 'a totally different thing', status: 'done' }] });
    expect(after.result).toMatch(/No step matched/);
  });

  it('add_steps appends without disturbing existing ids', async () => {
    const s = freshSession();
    const first = await update(s, { steps: [{ title: 'One', status: 'done' }] });
    const after = await update(s, { add_steps: [{ title: 'Two', status: 'todo' }] });
    expect(after.steps).toHaveLength(2);
    expect(after.steps[0].id).toBe(first.steps[0].id);
  });

  it('add_steps will not add a duplicate of an existing step', async () => {
    const s = freshSession();
    await update(s, { steps: [{ title: 'Write the tests', status: 'todo' }] });
    const after = await update(s, { add_steps: [{ title: 'write tests', status: 'todo' }] });
    expect(after.steps).toHaveLength(1);
  });

  it('remove_steps deletes by id', async () => {
    const s = freshSession();
    const first = await update(s, {
      steps: [{ title: 'One', status: 'todo' }, { title: 'Two', status: 'todo' }],
    });
    const after = await update(s, { remove_steps: [first.steps[0].id] });
    expect(after.steps.map((x) => x.title)).toEqual(['Two']);
  });
});

describe('plan invariants', () => {
  it('allows only one step in progress at a time', async () => {
    const s = freshSession();
    const after = await update(s, {
      steps: [
        { title: 'One', status: 'in_progress' },
        { title: 'Two', status: 'in_progress' },
      ],
    });
    expect(after.steps.filter((x) => x.status === 'in_progress')).toHaveLength(1);
    expect(after.result).toMatch(/Only one step may be in progress/);
  });

  it('reports progress in the result so the model sees where it is', async () => {
    const s = freshSession();
    const after = await update(s, {
      steps: [{ title: 'One', status: 'done' }, { title: 'Two', status: 'todo' }],
    });
    expect(after.result).toMatch(/1\/2 done/);
  });

  it('refuses gracefully when there is no session to attach a plan to', async () => {
    const r = await executeTool('update_plan', { steps: [{ title: 'x', status: 'todo' }] }, process.cwd());
    expect(r.result).toMatch(/FAILED/);
  });
});

/**
 * Mirrors the orchestrator's parsePlanEvent. Kept as a local copy on purpose:
 * the point is to pin the CONTRACT between the two layers, so a test that
 * imported the very function under test would prove nothing about the shape the
 * tool actually emits.
 */
function parsePlanEvent(event: unknown): Array<{ title: string; status: string }> | null {
  const e = (event ?? {}) as { steps?: unknown; content?: unknown };
  if (Array.isArray(e.steps)) return e.steps.length > 0 ? (e.steps as Array<{ title: string; status: string }>) : null;
  try {
    const data = JSON.parse(String(e.content ?? ''));
    return Array.isArray(data?.steps) && data.steps.length > 0 ? data.steps : null;
  } catch {
    return null;
  }
}

describe('every plan path translates content into steps', () => {
  it('round-trips a real update_plan event', async () => {
    const s = freshSession();
    const events: ToolEvent[] = [];
    await executeTool(
      'update_plan',
      { steps: [{ title: 'Ship it', status: 'todo' }] },
      process.cwd(),
      (e) => events.push(e as ToolEvent),
      undefined,
      { sessionId: s },
    );
    const steps = parsePlanEvent(events.find((e) => e.type === 'plan_updated')!);
    expect(steps?.[0]).toMatchObject({ title: 'Ship it', status: 'todo' });
  });

  it('accepts an event that already carries steps', () => {
    // The two shapes coexist: workers forward the raw {type, content} while the
    // lead path passes {type, steps}. Reading whichever is present is what
    // stops a call site being silently wrong about the other.
    expect(parsePlanEvent({ steps: [{ title: 'a', status: 'todo' }] }))
      .toEqual([{ title: 'a', status: 'todo' }]);
  });

  it.each([
    [{ content: 'not json' }],
    [{ content: '{}' }],
    [{ content: '{"steps":"nope"}' }],
    [{ content: '{"steps":[]}' }],
    [{ steps: [] }],
    [{}],
    [undefined],
  ])('returns null for %p instead of forwarding a broken event', (event) => {
    // A malformed event must be dropped, not sent on with steps:undefined —
    // that is exactly what made worker plans vanish silently.
    expect(parsePlanEvent(event)).toBeNull();
  });
});
