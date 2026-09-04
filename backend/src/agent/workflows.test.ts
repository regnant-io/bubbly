/**
 * Workflows and the loop runner.
 *
 * The interesting assertions here are about JUDGEMENT, not plumbing: a loop
 * that never stops, or one that stops the first time the agent writes the word
 * "done", are both useless in the same way — the user cannot predict what it
 * will do. Those decision points are what these tests pin.
 */

import { WORKFLOWS, buildWorkflowPrompt, findWorkflow, workflowCatalogue } from './workflows';
import { looksComplete, looksBlocked } from './loopRunner';

jest.mock('../db/index', () => ({ getSetting: () => 'false' }));

describe('the workflow catalogue', () => {
  it('has no duplicate commands', () => {
    const commands = WORKFLOWS.map((w) => w.command);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('gives every workflow a description and a group', () => {
    for (const w of WORKFLOWS) {
      expect(w.description.length).toBeGreaterThan(10);
      expect(w.group).toBeTruthy();
      expect(w.name.length).toBeGreaterThan(1);
    }
  });

  it('serialises without the build function, which cannot cross the wire', () => {
    const catalogue = workflowCatalogue();
    expect(catalogue.length).toBe(WORKFLOWS.length);
    expect(JSON.stringify(catalogue)).not.toContain('function');
    for (const w of catalogue) expect((w as Record<string, unknown>).build).toBeUndefined();
  });

  it('finds a workflow with or without the slash', () => {
    expect(findWorkflow('/fix')?.id).toBe('fix');
    expect(findWorkflow('fix')?.id).toBe('fix');
    expect(findWorkflow('FIX')?.id).toBe('fix');
  });

  it('returns undefined for an unknown command rather than guessing', () => {
    expect(findWorkflow('/definitely-not-a-command')).toBeUndefined();
  });
});

describe('workflows produce a real prompt, not a prefix', () => {
  it('expands /fix into a staged instruction with the reproduction step first', () => {
    const built = buildWorkflowPrompt('fix', { bug: 'login redirects to /' })!;
    expect(built.prompt).toContain('login redirects to /');
    // The whole value of the workflow is this ordering.
    expect(built.prompt.indexOf('Reproduce it')).toBeLessThan(built.prompt.indexOf('Find the actual cause'));
    expect(built.prompt.indexOf('Find the actual cause')).toBeLessThan(built.prompt.indexOf('Prove it'));
    // It must be substantially more than the user's words.
    expect(built.prompt.length).toBeGreaterThan(600);
  });

  it('seeds a plan so the plan widget is not empty for the first five tool calls', () => {
    const built = buildWorkflowPrompt('fix', { bug: 'x' })!;
    expect(built.plan?.length).toBeGreaterThan(2);
  });

  it('applies defaults for arguments the caller omitted', () => {
    // The CLI can invoke a workflow with only its required argument.
    const built = buildWorkflowPrompt('implement', { what: 'a queue' })!;
    expect(built.prompt).toContain('Write tests alongside the code');
  });

  it('honours an explicitly different choice', () => {
    const built = buildWorkflowPrompt('implement', { what: 'a queue', tests: 'no tests' })!;
    expect(built.prompt).toContain('Tests were not requested');
    expect(built.prompt).not.toContain('Write tests alongside the code');
  });

  it('carries the open files in as context when the request names nothing', () => {
    const built = buildWorkflowPrompt('fix', { bug: 'this is broken' }, { openFiles: ['src/App.tsx'] })!;
    expect(built.prompt).toContain('src/App.tsx');
  });

  it('lets a workflow choose the thread type', () => {
    expect(buildWorkflowPrompt('plan', { goal: 'x' })?.threadType).toBe('spec_session');
  });

  it('returns null for an unknown command so the caller can send the raw text', () => {
    expect(buildWorkflowPrompt('nope', {})).toBeNull();
  });

  it('states scope negatively as well as positively', () => {
    // Most bad agent runs are scope failures, so the workflows say so out loud.
    const built = buildWorkflowPrompt('implement', { what: 'a queue' })!;
    expect(built.prompt).toMatch(/Do not reformat files you were not working in/);
  });
});

describe('/loop budgets', () => {
  it('carries both an iteration and a time budget', () => {
    const built = buildWorkflowPrompt('loop', { goal: 'make tests pass', iterations: '5', minutes: '30' })!;
    expect(built.loop).toEqual(expect.objectContaining({ maxIterations: 5, maxMinutes: 30 }));
  });

  it('clamps absurd budgets rather than accepting them', () => {
    const huge = buildWorkflowPrompt('loop', { goal: 'x', iterations: '99999', minutes: '99999' })!;
    expect(huge.loop!.maxIterations).toBeLessThanOrEqual(100);
    expect(huge.loop!.maxMinutes).toBeLessThanOrEqual(600);
  });

  it('falls back to sane defaults for a missing budget', () => {
    const built = buildWorkflowPrompt('loop', { goal: 'x' })!;
    expect(built.loop!.maxIterations).toBeGreaterThan(0);
    expect(built.loop!.maxMinutes).toBeGreaterThan(0);
  });

  it('includes the stop condition in the prompt when one is given', () => {
    const built = buildWorkflowPrompt('loop', { goal: 'x', stopWhen: 'npm test exits 0' })!;
    expect(built.prompt).toContain('npm test exits 0');
  });

  it('tells the agent it may stop early, which is what stops invented work', () => {
    const built = buildWorkflowPrompt('loop', { goal: 'x' })!;
    expect(built.prompt).toMatch(/Finishing early is the good outcome/);
  });
});

describe('loop completion detection', () => {
  it.each([
    'The goal is met — all tests pass.',
    'All tests now passing, stopping here.',
    'Nothing left to do.',
    'The loop can stop.',
  ])('recognises a genuine completion: %s', (text) => {
    expect(looksComplete(text)).toBe(true);
  });

  it.each([
    "I'm done reading the file, now let me check the tests.",
    'Done with step one of four.',
    'That is done; next I will refactor the handler.',
    'I finished reading and found the problem.',
  ])('does NOT stop on an incidental "done": %s', (text) => {
    // A loose match here ends the loop the first time the agent narrates
    // finishing a step, which looks exactly like the loop giving up.
    expect(looksComplete(text)).toBe(false);
  });

  it.each([
    'I am blocked on a decision from you about the schema.',
    'Cannot proceed without database credentials.',
    'Waiting for you to confirm which API to use.',
  ])('recognises being blocked: %s', (text) => {
    expect(looksBlocked(text)).toBe(true);
  });

  it('does not treat ordinary progress as blocked', () => {
    expect(looksBlocked('I updated the handler and ran the tests.')).toBe(false);
  });
});
