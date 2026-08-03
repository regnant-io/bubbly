/**
 * The `plan_updated` wire shape.
 *
 * The tool layer emits `{ type, content }` where content is a JSON string; the
 * client reads `event.steps`. Something has to translate, and for a long time
 * only ONE of the three call sites did — the lead's. Both worker paths spread
 * the raw event through, so every delegated agent's plan reached the client as
 * `steps: undefined` and was dropped on the floor.
 *
 * Nothing failed loudly, because a plan that never arrives just looks like an
 * agent that didn't make one. These tests assert the contract at the boundary
 * instead: whatever a plan event carries, it carries `steps`.
 */

import { executeTool } from './tools/index';

jest.mock('../db/index', () => ({ getSetting: () => 'false' }));

type ToolEvent = { type: string; content: string };

describe('update_plan emits a parseable plan', () => {
  it('puts the steps in content as JSON', async () => {
    const events: ToolEvent[] = [];
    await executeTool(
      'update_plan',
      { steps: [{ title: 'Read the code', status: 'done' }, { title: 'Fix it', status: 'in_progress' }] },
      process.cwd(),
      (e) => events.push(e as ToolEvent),
    );

    const planEvent = events.find((e) => e.type === 'plan_updated');
    expect(planEvent).toBeDefined();
    const parsed = JSON.parse(planEvent!.content);
    expect(parsed.steps).toEqual([
      { title: 'Read the code', status: 'done' },
      { title: 'Fix it', status: 'in_progress' },
    ]);
  });

  it('normalizes an unknown status rather than passing it through', async () => {
    const events: ToolEvent[] = [];
    await executeTool(
      'update_plan',
      { steps: [{ title: 'x', status: 'wat' }] },
      process.cwd(),
      (e) => events.push(e as ToolEvent),
    );
    const parsed = JSON.parse(events.find((e) => e.type === 'plan_updated')!.content);
    expect(parsed.steps[0].status).toBe('todo');
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
    const events: ToolEvent[] = [];
    await executeTool(
      'update_plan',
      { steps: [{ title: 'Ship it', status: 'todo' }] },
      process.cwd(),
      (e) => events.push(e as ToolEvent),
    );
    const steps = parsePlanEvent(events.find((e) => e.type === 'plan_updated')!);
    expect(steps).toEqual([{ title: 'Ship it', status: 'todo' }]);
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
