/**
 * Workflows — the slash commands, made to mean something.
 *
 * WHAT THEY WERE
 *
 * A slash command prepended a string. `/bugfix` turned "the login is broken"
 * into "Debug and fix: the login is broken" — three words the model would have
 * inferred anyway, at the cost of a menu, a keyboard handler and a promise the
 * feature could not keep. It was a shortcut for typing, presented as a mode.
 *
 * WHAT A WORKFLOW IS
 *
 * A prompt PROGRAM. It states the phases the work has to go through, the
 * evidence required to leave each one, what is out of scope, and what "done"
 * looks like concretely enough to check. That is the part a model genuinely
 * benefits from being told, because it is the part it will otherwise skip under
 * pressure: reproducing the bug before fixing it, reading the requirement before
 * implementing it, running the tests before claiming they pass.
 *
 * The measure of a workflow is whether the run is different without it. If a
 * workflow's text could be deleted with no change in behaviour, it should be.
 *
 * DESIGN RULES
 *
 *  - A workflow SEEDS a plan rather than dictating every step. The agent still
 *    decides how; the workflow decides what must be true before it stops.
 *  - Phases are gated by EVIDENCE, not by assertion. "Confirm the tests pass"
 *    means run them and read the output, and the workflow says so.
 *  - Scope is stated negatively as well as positively. Most bad agent runs are
 *    scope failures, not capability failures.
 *  - Every workflow ends by saying what to report, so the answer is a summary of
 *    what happened rather than a restatement of the request.
 */

import type { ThreadType } from '../types';

export interface WorkflowParam {
  name: string;
  label: string;
  /** Shown as the input's placeholder. */
  placeholder?: string;
  required?: boolean;
  /** A fixed set of choices renders as a segmented control instead of a field. */
  options?: string[];
  default?: string;
  kind?: 'text' | 'number' | 'duration';
  hint?: string;
}

export interface WorkflowContext {
  /** Files the user currently has open, if any. */
  openFiles?: string[];
  workspacePath?: string;
}

export interface WorkflowBuildResult {
  /** The message actually sent to the agent. */
  prompt: string;
  /** Thread type this workflow wants, if it has an opinion. */
  threadType?: ThreadType;
  /** A starting plan, seeded so the plan widget is populated from step one. */
  plan?: string[];
  /** Set for workflows that run repeatedly rather than once. */
  loop?: { goal: string; maxIterations: number; maxMinutes: number; stopWhen?: string };
}

export interface Workflow {
  id: string;
  /** What the user types, without the slash. */
  command: string;
  name: string;
  description: string;
  /** Grouping in the picker. */
  group: 'build' | 'fix' | 'understand' | 'quality' | 'ship' | 'run';
  /** Lucide icon name, resolved on the client. */
  icon: string;
  params: WorkflowParam[];
  build: (args: Record<string, string>, ctx: WorkflowContext) => WorkflowBuildResult;
}

/** The shared closing instruction — how to report, in every workflow. */
const REPORT = `
## Reporting
When you finish, say in a few sentences: what you changed, what you verified and how, and anything you deliberately did not do. If something is still broken or uncertain, say so plainly — an honest "the X case still fails and here is why" is worth far more than a confident summary that does not match the code.`;

/** The shared scope discipline. Most bad runs are scope failures. */
const SCOPE = `
## Scope
Do what was asked and stop. Do not reformat files you were not working in, do not upgrade dependencies, do not "while I'm here" a second problem into the same change. If you find something else worth doing, note it in your report instead of doing it.`;

function fileContext(ctx: WorkflowContext): string {
  if (!ctx.openFiles || ctx.openFiles.length === 0) return '';
  return `\n\nFiles currently open in the editor (likely relevant): ${ctx.openFiles.slice(0, 8).join(', ')}`;
}

export const WORKFLOWS: Workflow[] = [
  // ===================== BUILD =====================
  {
    id: 'implement',
    command: 'implement',
    name: 'Implement',
    description: 'Build a feature properly: understand, plan, build, verify.',
    group: 'build',
    icon: 'Code2',
    params: [
      { name: 'what', label: 'What to build', placeholder: 'a rate limiter on the login endpoint', required: true },
      { name: 'tests', label: 'Tests', options: ['write tests', 'no tests'], default: 'write tests' },
    ],
    build: (args, ctx) => ({
      plan: ['Understand the existing code', 'Design the change', 'Implement it', 'Verify it works'],
      prompt: `# Implement: ${args.what}

Work through this in four phases. Do not skip ahead — each phase exists because starting the next one without it is how implementations end up not fitting the codebase.

## 1. Understand what exists
Find the code this touches. Use get_repo_map, find_symbol, find_references and read the actual files — not what they are probably called. Identify:
- where this belongs (which module, which layer, following which existing pattern)
- what it will interact with, and what might break
- whether something like it already exists that should be extended rather than duplicated

State briefly what you found before moving on. If the request turns out to conflict with what is there, say so now rather than building something that does not fit.

## 2. Decide the approach
Say what you are going to do and why, in a few sentences. Name the alternative you rejected if there was a real one. If a decision here is genuinely the user's to make — a visible behaviour, a data shape that is hard to change later — use ask_user and wait.

## 3. Build it
Follow the conventions of the files you are editing. Handle the error cases, not just the happy path. ${args.tests === 'write tests' ? 'Write tests alongside the code, covering the edge cases as well as the main path.' : 'Tests were not requested, so do not add them — but say in your report what you would test.'}

## 4. Verify
Run whatever this project actually has: typecheck, tests, lint, a build. If it has none, exercise the change some other way — start it, call it, look at it — and say what you did. "It should work" is not verification.
${SCOPE}${REPORT}${fileContext(ctx)}`,
    }),
  },
  {
    id: 'scaffold',
    command: 'scaffold',
    name: 'Scaffold',
    description: 'Start a new project or module and get it running end to end.',
    group: 'build',
    icon: 'FolderPlus',
    params: [
      { name: 'what', label: 'What to create', placeholder: 'a Vite + React + TypeScript app called dashboard', required: true },
    ],
    build: (args) => ({
      plan: ['Choose the scaffolder', 'Create the project', 'Install dependencies', 'Run it and confirm'],
      prompt: `# Scaffold: ${args.what}

## Use the official tooling
Prefer the ecosystem's own scaffolder (\`npm create vite\`, \`cargo new\`, \`django-admin startproject\`) over hand-assembling files. Pass the flags that answer its questions non-interactively — an interactive prompt in this shell has no keyboard and will hang until it is killed.

## Verify each step before the next
1. Run the scaffolder. Read its output; do not assume it succeeded.
2. Install dependencies, then CHECK the install actually landed before writing code against it. A half-finished install produces "module not found" errors that look like your mistake.
3. Start it and confirm it runs — the dev server responds, the binary executes, the tests pass on the empty project.
4. Only then make any changes that were asked for.

## Do not
Do not invent a project structure the framework does not use. Do not add libraries beyond what was asked for. Do not skip step 3 — a project that has never run is a project where five things are broken at once and you cannot tell which.
${REPORT}`,
    }),
  },

  // ===================== FIX =====================
  {
    id: 'fix',
    command: 'fix',
    name: 'Fix a bug',
    description: 'Reproduce, diagnose, fix, and prove it is fixed.',
    group: 'fix',
    icon: 'Bug',
    params: [
      { name: 'bug', label: 'What is wrong', placeholder: 'login redirects to / instead of the dashboard', required: true },
      { name: 'repro', label: 'How to reproduce', placeholder: 'optional — steps, a command, or a failing test' },
    ],
    build: (args, ctx) => ({
      plan: ['Reproduce it', 'Find the cause', 'Fix the cause', 'Prove it is fixed'],
      prompt: `# Fix: ${args.bug}
${args.repro ? `\nReported reproduction: ${args.repro}\n` : ''}
Debugging is a search, and guessing is the slowest way to search. Work in this order.

## 1. Reproduce it
Find the smallest command, test or sequence that shows the bug, and RUN IT. A bug you cannot trigger on demand is a bug you cannot confirm you fixed — and roughly a third of reported bugs turn out to be something else once reproduced.

If you genuinely cannot reproduce it, say so and say what you tried, rather than fixing what you assume is wrong.

## 2. Find the actual cause
Read the real error and the real stack, not the summary. Form ONE hypothesis and test it. Change one thing at a time; revert what did not help before trying the next thing.

When the code "obviously cannot" produce the observed behaviour, one of your assumptions is wrong — usually about which code is running. Check that before theorising further.

## 3. Fix the cause, not the symptom
A null check that hides why the value was null is not a fix. If the real fix is large or risky, say so and describe both options rather than silently choosing the small wrong one.

## 4. Prove it
Run the reproduction from step 1 and show it now passes. Then check you have not broken the neighbours — run the surrounding tests. Add a regression test that would have caught this, and confirm it FAILS against the old behaviour if you can.
${SCOPE}${REPORT}${fileContext(ctx)}`,
    }),
  },
  {
    id: 'triage',
    command: 'triage',
    name: 'Triage',
    description: 'Work out what is wrong and how serious it is, without fixing it yet.',
    group: 'fix',
    icon: 'Search',
    params: [
      { name: 'symptom', label: 'Symptom', placeholder: 'the deploy job fails intermittently', required: true },
    ],
    build: (args) => ({
      plan: ['Gather evidence', 'Narrow the cause', 'Assess impact', 'Recommend'],
      prompt: `# Triage: ${args.symptom}

DIAGNOSE ONLY. Do not change any code in this run — the point is to understand the problem well enough to decide what to do about it, and a premature fix destroys the evidence.

## Gather evidence
Logs, error messages, recent commits in the affected area, the configuration, what changed recently. Quote what you actually found rather than summarising it away.

## Narrow it
Say what you can rule OUT and how. A cause you have eliminated is worth as much as one you suspect.

## Assess
- How serious is it: who is affected, how often, is data at risk, is it getting worse?
- How confident are you in the diagnosis, and what would raise that confidence?

## Recommend
Give the smallest safe fix and, if different, the correct fix. Say which you would do and why. If more information is needed, say exactly what would settle it.
${REPORT}`,
    }),
  },

  // ===================== UNDERSTAND =====================
  {
    id: 'explain',
    command: 'explain',
    name: 'Explain',
    description: 'Understand how something works, and be able to change it.',
    group: 'understand',
    icon: 'BookOpen',
    params: [
      { name: 'subject', label: 'What to explain', placeholder: 'how authentication works here', required: true },
      { name: 'depth', label: 'Depth', options: ['overview', 'thorough'], default: 'overview' },
    ],
    build: (args, ctx) => ({
      prompt: `# Explain: ${args.subject}

Read the code before explaining it. An explanation from the names of things is a guess presented with confidence, and it is worse than saying you do not know.

## How to investigate
Start from an ENTRY POINT — the route, the command, the exported function — and follow ONE real path all the way through. Breadth without a single complete depth is a list of file names. Use find_references to see how things are actually used; real call sites teach more than definitions.

## What to say
- The FLOW: what happens, in order, from trigger to outcome.
- The pieces and what each is responsible for.
- The two or three DECISIONS the design turns on, and what they cost.
- Where the surprises are: the non-obvious coupling, the thing that looks wrong but is deliberate, the part that will bite whoever changes it next.
${args.depth === 'thorough' ? '- The edge cases and error paths, and how state is managed across them.\n- What is NOT handled, and where the sharp edges are.' : ''}

Cite specific files and symbols so the reader can follow along. Do not change any code.`,
    }),
  },
  {
    id: 'onboard',
    command: 'onboard',
    name: 'Onboard',
    description: 'Get oriented in an unfamiliar codebase.',
    group: 'understand',
    icon: 'Map',
    params: [
      { name: 'focus', label: 'Focus (optional)', placeholder: 'the billing subsystem' },
    ],
    build: (args) => ({
      plan: ['Map the project', 'Trace one real path', 'Find the conventions', 'Summarise'],
      prompt: `# Get oriented${args.focus ? `: ${args.focus}` : ' in this codebase'}

Produce the briefing you would want on your first day.

## 1. Shape
What is this project, what does it do, and what is it built with? get_repo_map, the README, package manifests, the directory layout. Identify the entry points.

## 2. One real path
Trace a single meaningful flow end to end — a request, a command, a build. This is what turns a list of directories into an understanding.

## 3. Conventions
How does this codebase do things: error handling, testing, state, naming, module boundaries? What would a change here be expected to look like? Note where the codebase is inconsistent with itself, because that is where a newcomer gets it wrong.

## 4. How to work on it
The commands that matter: install, run, test, lint, build. VERIFY they exist by reading the manifest — do not invent a \`npm test\` that is not there.

Finish with the five things someone needs to know before touching this code. Do not change anything.`,
    }),
  },

  // ===================== QUALITY =====================
  {
    id: 'review',
    command: 'review',
    name: 'Review',
    description: 'Review changes for correctness first, style last.',
    group: 'quality',
    icon: 'ShieldCheck',
    params: [
      { name: 'target', label: 'What to review', placeholder: 'uncommitted changes, a file, or a PR number', default: 'uncommitted changes' },
    ],
    build: (args) => ({
      plan: ['Read the change', 'Check correctness', 'Check safety', 'Report'],
      prompt: `# Review: ${args.target || 'uncommitted changes'}

Read the actual diff first (\`repo\` with action "diff", or the files in question). Review in this order, because a comment about naming on code that is wrong is wasted effort.

## 1. Correctness
Does it do what it claims? Walk the edge cases explicitly: empty, null, error path, concurrent, the second call, the very large input. Trace at least one non-obvious path by hand.

## 2. Safety
Injection, authorisation, secrets, data loss, anything irreversible. Anything that touches money, permissions or user data gets read twice.

## 3. Fit
Does it match the codebase? Does it duplicate something that already exists? Will it break a caller — check with find_references.

## 4. Clarity
Will the next reader understand it? Are the names honest about what the things do?

## Reporting rules
- Say what is wrong, why it matters, and what to do instead.
- Distinguish a BUG from a PREFERENCE and label which you are stating.
- Do NOT invent problems to look thorough. "This looks correct; here is the one thing I would change" is a complete and useful review.
- Do not change the code unless asked. Report.`,
    }),
  },
  {
    id: 'test',
    command: 'test',
    name: 'Add tests',
    description: 'Write tests that would actually catch a regression.',
    group: 'quality',
    icon: 'CheckCircle',
    params: [
      { name: 'target', label: 'What to test', placeholder: 'src/auth/session.ts', required: true },
    ],
    build: (args) => ({
      plan: ['Read the code', 'List the cases', 'Write the tests', 'Prove they fail on broken code'],
      prompt: `# Add tests for: ${args.target}

## 1. Read it and match the house style
Read the code under test AND an existing test file. Use the same runner, the same layout, the same assertion style. A test file that looks foreign is a test file nobody maintains.

## 2. Decide what is worth testing
Test behaviour through the public interface. Cover:
- the main path, once
- the EDGES, where the bugs are: empty, one, many, null, wrong type, very large, unicode, boundary values
- the error paths, including what the caller sees
- anything subtle: parsing, state transitions, ordering, concurrency, dates

Do not test what the framework guarantees, or a getter, or a constant. Coverage of trivial code is coverage theatre.

## 3. Write them
One reason to fail per test. Name each test after the CASE ("rejects an expired token"), not the function. No real time, no real network, no shared state between tests, no dependence on order.

## 4. PROVE THEY WORK
Run them and watch them pass. Then break the implementation deliberately and confirm the tests FAIL. A surprising number of new tests pass against a broken implementation — a test that has never failed has not been shown to test anything. Restore the code afterwards.
${REPORT}`,
    }),
  },
  {
    id: 'refactor',
    command: 'refactor',
    name: 'Refactor',
    description: 'Improve structure with behaviour held constant.',
    group: 'quality',
    icon: 'Wrench',
    params: [
      { name: 'target', label: 'What to refactor', placeholder: 'the payment module', required: true },
      { name: 'goal', label: 'Goal', placeholder: 'why — e.g. "so the retry logic is testable"' },
    ],
    build: (args) => ({
      plan: ['Establish a safety net', 'Refactor in steps', 'Verify behaviour is unchanged'],
      prompt: `# Refactor: ${args.target}
${args.goal ? `\nGoal: ${args.goal}\n` : ''}
BEHAVIOUR MUST NOT CHANGE. If you find a bug on the way, note it and leave it — fixing it in the same change makes the diff unreviewable and means neither part can be reverted alone.

## 1. Safety net first
Find the tests that cover this. If there are none, either write characterisation tests first or say clearly that you are refactoring without a net and what you did instead (typecheck, running it). Refactoring without a way to notice breakage is editing hopefully.

## 2. One transformation at a time
Extract, rename, move, inline — one at a time, verifying between each. Use rename_symbol for renames rather than search-and-replace, which will hit a comment, a string and an unrelated variable with the same name.

## 3. Verify
Run the tests and the typecheck. The behaviour must be identical; say how you know.

## Do not
Do not refactor code you were not asked to touch. Do not "improve" the API on the way. Duplication is not automatically a defect: two things that look alike but change for different reasons should stay apart.
${REPORT}`,
    }),
  },
  {
    id: 'perf',
    command: 'perf',
    name: 'Optimise',
    description: 'Make something faster, with numbers.',
    group: 'quality',
    icon: 'Zap',
    params: [
      { name: 'what', label: 'What is slow', placeholder: 'the search endpoint', required: true },
      { name: 'target', label: 'Target (optional)', placeholder: 'under 200ms' },
    ],
    build: (args) => ({
      plan: ['Measure the baseline', 'Find the real bottleneck', 'Fix the biggest thing', 'Measure again'],
      prompt: `# Optimise: ${args.what}
${args.target ? `\nTarget: ${args.target}\n` : ''}
## 1. MEASURE FIRST, and write the number down
No optimisation before a baseline. Time it, profile it, count the queries — whatever is appropriate. Optimising without a measurement is not engineering, and the bottleneck is routinely somewhere nobody suspected.

## 2. Find where the time actually goes
The usual real causes, in order: doing it more times than necessary (N+1, re-render, re-parse), doing it at the wrong time (blocking, serial when it could be parallel), moving too much data, and only then slow code.

## 3. Fix the biggest thing only
A 90% saving on 2% of the runtime is not worth the complexity it costs. Prefer an algorithmic fix to a micro-optimisation.

## 4. Measure again, the same way
Report before and after as numbers. "It feels faster" is not a result. If the change did not help, SAY SO and revert it — an unhelpful optimisation is pure added complexity.

Stop when it is fast enough, and say what the remaining bottleneck is.
${REPORT}`,
    }),
  },
  {
    id: 'audit',
    command: 'audit',
    name: 'Security audit',
    description: 'Look for the vulnerabilities that actually get exploited.',
    group: 'quality',
    icon: 'ShieldCheck',
    params: [
      { name: 'scope', label: 'Scope', placeholder: 'the whole project, or a directory', default: 'the whole project' },
    ],
    build: (args) => ({
      plan: ['Map the attack surface', 'Check each class', 'Verify findings', 'Report by severity'],
      prompt: `# Security audit: ${args.scope || 'the whole project'}

Find real, exploitable problems. A long list of theoretical findings is worse than three concrete ones, because it buries them.

## Map the attack surface
Where does untrusted input enter — HTTP handlers, CLI arguments, file uploads, webhooks, message consumers, environment? Follow each to where it is used.

## Check these, in order of how often they are actually exploited
1. Injection: SQL/command/path built by concatenating input.
2. Authorisation: an id from the request used without checking it belongs to the current user. This is the most common serious flaw in real applications.
3. Secrets: credentials in source, in logs, in error messages, in URLs, in client bundles.
4. Authentication: password hashing, session/cookie flags, token verification (including the algorithm), reset flows.
5. Output encoding: XSS via innerHTML/dangerouslySetInnerHTML/template injection.
6. Unbounded input: no size, length or depth limits.
7. Dependencies with known vulnerabilities.

## Verify before reporting
For each finding, show the actual code path that makes it exploitable. If you cannot, say it is a suspicion rather than a finding — a false positive costs the reader's trust in the whole report.

## Report
Order by severity: what is exploitable now, what needs another condition, what is hardening. For each: where it is, why it matters, and the concrete fix. Do not change code in this run unless asked.`,
    }),
  },

  // ===================== SHIP =====================
  {
    id: 'ship',
    command: 'ship',
    name: 'Ship',
    description: 'Verify, commit, push and open a pull request.',
    group: 'ship',
    icon: 'GitBranch',
    params: [
      { name: 'summary', label: 'What this change is', placeholder: 'add rate limiting to login', required: true },
      { name: 'pr', label: 'Pull request', options: ['open a PR', 'commit only'], default: 'open a PR' },
      { name: 'draft', label: 'PR state', options: ['ready', 'draft'], default: 'ready' },
    ],
    build: (args) => ({
      plan: ['Review the diff', 'Verify', 'Commit', args.pr === 'open a PR' ? 'Push and open a PR' : 'Push'],
      prompt: `# Ship: ${args.summary}

## 1. Look at what you are about to commit
\`repo\` action "status" and "diff". Read it. Check for: debug logging, commented-out code, a stray console.log, a hard-coded value, a secret, an unrelated formatting change. Anything that should not be in the commit, take out now.

## 2. Verify
Run the project's tests and typecheck. If they fail, STOP and fix them — do not commit a red tree and mention it in the description.

## 3. Commit
Stage deliberately and write a real message: an imperative subject line under ~72 characters, then a body saying WHY if it is not obvious. "Fix bug" is a wasted line. One logical change per commit.

## 4. ${args.pr === 'open a PR' ? 'Push and open a pull request' : 'Push'}
${args.pr === 'open a PR'
  ? `Make sure you are on a branch, not the default one — if you are on main/master, create a branch first. Push it, then open the pull request${args.draft === 'draft' ? ' AS A DRAFT' : ''} with a description that says what changed, why, how to verify it, and what you deliberately did not do. Call out anything the reviewer should look at hardest.`
  : 'Push the current branch. Do not open a pull request.'}

## Never
Never force-push a shared branch. Never commit a secret — if one has been committed, say so immediately, because the fix is to rotate it, not to remove it from history.
${REPORT}`,
    }),
  },
  {
    id: 'document',
    command: 'document',
    name: 'Document',
    description: 'Write documentation someone stuck can actually use.',
    group: 'ship',
    icon: 'FileText',
    params: [
      { name: 'subject', label: 'What to document', placeholder: 'the README, or the public API of src/queue', required: true },
    ],
    build: (args) => ({
      prompt: `# Document: ${args.subject}

Read the code first. Documentation written from names is documentation that is wrong in exactly the places it matters.

## What good looks like
- Answer the reader's questions in the order they ask them: what is this, how do I run it, how do I use it, how do I extend it.
- Document the WHY for anything non-obvious. The what is in the code; the reasoning exists nowhere else.
- Say what it does NOT do, and its limits. That is what stops someone using it wrongly.
- Prefer a short working example to a long description. People copy the example.

## Verify every command you write
Any command in the docs must actually work from a clean checkout. Run them. Untested instructions cost the reader's trust as well as their time — and they are the single most common defect in documentation.

Match the existing documentation's voice and structure. Do not add a section that duplicates one that exists.
${REPORT}`,
    }),
  },

  // ===================== RUN =====================
  {
    id: 'loop',
    command: 'loop',
    name: 'Loop',
    description: 'Work towards a goal repeatedly until it is met or the budget runs out.',
    group: 'run',
    icon: 'RefreshCw',
    params: [
      { name: 'goal', label: 'Goal', placeholder: 'make the whole test suite pass', required: true },
      { name: 'stopWhen', label: 'Stop when', placeholder: 'e.g. "npm test exits 0" — how you will know it is done', hint: 'A checkable condition, not a feeling.' },
      { name: 'iterations', label: 'Max rounds', kind: 'number', default: '10' },
      { name: 'minutes', label: 'Time budget', kind: 'duration', default: '60', hint: 'Minutes. The loop stops when either budget runs out.' },
    ],
    build: (args) => {
      const iterations = Math.min(Math.max(Number(args.iterations) || 10, 1), 100);
      const minutes = Math.min(Math.max(Number(args.minutes) || 60, 1), 600);
      return {
        loop: { goal: args.goal, maxIterations: iterations, maxMinutes: minutes, stopWhen: args.stopWhen },
        plan: ['Assess the current state', 'Do the next most valuable thing', 'Verify', 'Decide whether to continue'],
        prompt: `# Loop: ${args.goal}

You will be run repeatedly until this goal is met, ${iterations} rounds have passed, or ${minutes} minutes have elapsed — whichever comes first.
${args.stopWhen ? `\n**Done means:** ${args.stopWhen}\n` : ''}
## How to use a round well

**Start by checking where things actually are.** Do not trust your memory of the last round; run the check, read the file, look at the state. Between rounds the context may have been compacted, and acting on a remembered state that is no longer true is how a loop goes in circles.

**Do the next most valuable thing, and finish it.** One complete, verified step per round beats three half-finished ones — half-finished work does not survive a compaction, and finished work does, as facts on disk.

**Verify before you claim progress.** Run the check. If the round did not move the goal closer, say so; that is useful information and pretending otherwise wastes the next round.

**Never repeat a failed action unchanged.** If something failed twice, the third attempt fails too. Change the approach, or say clearly what is blocking you.

**Say where you are at the end of each round**: what you did, what the check says now, and what you will do next. That summary is what the next round starts from.

## Stopping
Stop early and say so when:
- the goal is MET — state the evidence
- you are blocked on something only the user can decide, or on missing access
- you are going in circles: two rounds with no measurable progress means the approach is wrong, and continuing burns budget for nothing

Do not pad the remaining rounds with cosmetic work once the goal is met. Finishing early is the good outcome.
${SCOPE}`,
      };
    },
  },
  {
    id: 'plan',
    command: 'plan',
    name: 'Plan',
    description: 'Think it through and produce a plan before writing any code.',
    group: 'run',
    icon: 'ListTree',
    params: [
      { name: 'goal', label: 'What to plan', placeholder: 'migrating sessions off cookies', required: true },
    ],
    build: (args) => ({
      threadType: 'spec_session',
      prompt: `# Plan: ${args.goal}

PLAN ONLY. Write no implementation code in this run.

## Ground it in this codebase
A plan that invents module names or re-specifies something that already exists is worse than no plan. Spend real tool calls learning what is there: get_repo_map, find_symbol, read the files this touches. State briefly what exists today and what has to change.

## The plan itself
- The steps, in an order where each one leaves the project WORKING. Not a wish list — a sequence.
- For each step: what changes, roughly how big it is, and how you would know it worked.
- The risks, and what you would do about each.
- What you are deliberately NOT doing, and why.
- The decisions that are the user's to make, stated as questions with your recommendation.

## Be honest about size
If this is a week of work, say so. A plan that makes a large change sound small is the most expensive kind of optimism.

Use update_plan so the steps appear as a live checklist, and deliver the reasoning as an artifact if it runs long.`,
    }),
  },
];

export function findWorkflow(command: string): Workflow | undefined {
  const c = command.replace(/^\//, '').toLowerCase();
  return WORKFLOWS.find((w) => w.command === c || w.id === c);
}

/** The catalogue, for the client's picker. `build` is not serialisable. */
export function workflowCatalogue(): Array<Omit<Workflow, 'build'>> {
  return WORKFLOWS.map(({ build: _build, ...rest }) => rest);
}

/**
 * Turn a slash command into the message the agent receives.
 *
 * Returns null for an unknown command so the caller can send the raw text
 * instead — a mistyped slash command should be a message, not an error.
 */
export function buildWorkflowPrompt(
  command: string,
  args: Record<string, string>,
  ctx: WorkflowContext = {},
): WorkflowBuildResult | null {
  const workflow = findWorkflow(command);
  if (!workflow) return null;

  // Apply defaults for anything the caller left out, so a workflow invoked from
  // the CLI with two of its four arguments still behaves as designed.
  const filled: Record<string, string> = {};
  for (const p of workflow.params) {
    filled[p.name] = args[p.name] ?? p.default ?? '';
  }
  return workflow.build(filled, ctx);
}
