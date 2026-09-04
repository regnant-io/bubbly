import { applyPlanUpdate, loadPlan } from './planManager';
import { createSession } from '../session/manager';

/**
 * THE BUG THESE PIN
 *
 * A thread outlives the task that started it. Ask for a second, unrelated piece
 * of work after the first is finished and the agent draws up a second plan —
 * which the merge treated as a revision of the first. The finished eight-step
 * plan grew a ninth and a tenth step, the counter read "8/11 done" for work
 * that had nothing to do with the first eight, and the Plans panel showed one
 * enormous plan whose top half belonged to a task that ended half an hour ago.
 *
 * The fix has to hold BOTH ways round: a genuinely new plan must fork, and a
 * retyped or restructured plan must still merge — because the anti-amnesia rule
 * (a model that forgets to retype a step has not asked to delete it) is the
 * thing that stops plans silently shrinking, and it is easy to break while
 * fixing this.
 */
describe('plan generations', () => {
  // A real session row: the plan is persisted with `UPDATE sessions SET plan`,
  // so an invented id writes nothing and every assertion below would pass
  // against an empty plan for the wrong reason.
  const session = () =>
    createSession({ workspacePath: process.cwd(), provider: 'ollama', model: 'test-model' }).id;

  it('seals a finished plan and starts a new one when the next plan shares nothing with it', () => {
    const id = session();
    applyPlanUpdate(id, {
      steps: [
        { title: 'Add the login form', status: 'done' },
        { title: 'Wire the session cookie', status: 'done' },
      ],
    });
    const first = loadPlan(id);
    expect(first).toHaveLength(2);

    const outcome = applyPlanUpdate(id, {
      steps: [
        { title: 'Write the deployment script', status: 'in_progress' },
        { title: 'Add a health check', status: 'todo' },
      ],
    });

    expect(outcome.freshPlan).toBe(true);
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps.map((s) => s.title)).toEqual([
      'Write the deployment script',
      'Add a health check',
    ]);
    // The ids must not overlap: that is precisely what tells the client this is
    // a plan BELOW the previous one rather than more steps inside it.
    const oldIds = new Set(first.map((s) => s.id));
    expect(outcome.steps.some((s) => oldIds.has(s.id))).toBe(false);
    expect(outcome.notes.join(' ')).toMatch(/NEW plan/i);
  });

  it('does NOT fork when the previous plan still has unfinished work', () => {
    const id = session();
    applyPlanUpdate(id, {
      steps: [
        { title: 'Add the login form', status: 'done' },
        { title: 'Wire the session cookie', status: 'todo' },
      ],
    });

    // A completely different list, but the old plan is not finished — so this
    // is a restructure, and the unfinished step must survive it.
    const outcome = applyPlanUpdate(id, {
      steps: [{ title: 'Write the deployment script', status: 'in_progress' }],
    });

    expect(outcome.freshPlan).toBe(false);
    expect(outcome.steps.map((s) => s.title)).toContain('Wire the session cookie');
    expect(outcome.notes.join(' ')).toMatch(/KEPT/);
  });

  it('forks on request even when the previous plan is unfinished', () => {
    const id = session();
    applyPlanUpdate(id, { steps: [{ title: 'Half-done thing', status: 'in_progress' }] });

    const outcome = applyPlanUpdate(id, {
      newPlan: true,
      steps: [{ title: 'Something else entirely', status: 'todo' }],
    });

    expect(outcome.freshPlan).toBe(true);
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0].title).toBe('Something else entirely');
  });

  it('still merges a retyped plan rather than forking it', () => {
    const id = session();
    const first = applyPlanUpdate(id, {
      steps: [
        { title: 'Add the login form', status: 'done' },
        { title: 'Wire the session cookie', status: 'todo' },
      ],
    });

    // The same plan, retyped with one word different and one box ticked — the
    // exact thing that used to make the progress display appear to restart.
    const second = applyPlanUpdate(id, {
      steps: [
        { title: 'Adding the login form', status: 'done' },
        { title: 'Wire session cookie', status: 'done' },
      ],
    });

    expect(second.freshPlan).toBe(false);
    expect(second.steps).toHaveLength(2);
    expect(second.steps.map((s) => s.id).sort()).toEqual(first.steps.map((s) => s.id).sort());
    expect(second.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('keeps at most one step in progress in a freshly forked plan', () => {
    const id = session();
    applyPlanUpdate(id, { steps: [{ title: 'Old work', status: 'done' }] });

    const outcome = applyPlanUpdate(id, {
      steps: [
        { title: 'First new thing', status: 'in_progress' },
        { title: 'Second new thing', status: 'in_progress' },
      ],
    });

    expect(outcome.freshPlan).toBe(true);
    expect(outcome.steps.filter((s) => s.status === 'in_progress')).toHaveLength(1);
    expect(outcome.steps[1].status).toBe('in_progress');
  });
});
