/**
 * The skills Bubbly ships with.
 *
 * WHAT A SKILL IS FOR
 *
 * A system prompt has to be short, because everything in it is paid for on
 * every single model call and everything in it competes for the model's
 * attention. But a great deal of genuinely useful engineering knowledge is
 * CONDITIONAL — how to write a migration safely matters enormously when writing
 * a migration and not at all the rest of the time.
 *
 * A skill is that conditional knowledge, plus the triggers that decide when it
 * is relevant. The base prompt stays lean, and the agent gets a specialist's
 * checklist exactly when it is about to do that specialist's work.
 *
 * WHAT MAKES ONE WORTH SHIPPING
 *
 * Three tests, and a skill has to pass all of them:
 *
 *  1. IT MUST BE ACTIONABLE. "Write clean code" is not a skill, it is a
 *     sentiment. "Before changing a shared type, find every reader with
 *     find_references and fix the call sites in the same change" is a skill.
 *  2. IT MUST BE NON-OBVIOUS. A capable model already knows how to write a for
 *     loop. It does NOT reliably remember that a nullable column added to a
 *     10-million-row Postgres table needs a separate backfill, or that a React
 *     effect with a missing dependency is a stale-closure bug rather than a lint
 *     complaint.
 *  3. IT MUST FIRE AT THE RIGHT TIME. A skill that activates on every message is
 *     just an expensive addition to the base prompt, and one that never
 *     activates is dead weight. See TRIGGER DESIGN below.
 *
 * TRIGGER DESIGN
 *
 * Triggers are matched on WORD BOUNDARIES, not substrings — otherwise "api"
 * fires on "rapid", "css" on "success", and "go" on almost everything, which is
 * how a skill system degrades into permanently injecting all of its content.
 * Multi-word triggers are matched as phrases. `fileHints` fire on the file
 * EXTENSIONS in play, which catches the very common case of a request that
 * names no technology at all ("fix this", with a .tsx file open).
 *
 * Every skill here can be switched off and none can be deleted: they are part
 * of the product, and a user who turns one off should be able to turn it back
 * on without re-typing it.
 */

export type SkillCategory =
  | 'core'
  | 'languages'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'testing'
  | 'quality'
  | 'infrastructure'
  | 'security'
  | 'practice';

export interface BuiltinSkill {
  id: string;
  name: string;
  category: SkillCategory;
  /** One line, shown in Settings. Says when it applies. */
  description: string;
  /** Word/phrase triggers, matched on word boundaries, case-insensitively. */
  triggers: string[];
  /** File extensions that also activate it, without the dot. */
  fileHints?: string[];
  /** Always active, regardless of triggers. Use very sparingly. */
  alwaysOn?: boolean;
  instructions: string;
}

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, { label: string; blurb: string }> = {
  core: { label: 'Core engineering', blurb: 'How to work on a codebase at all — always or nearly always relevant.' },
  languages: { label: 'Languages', blurb: 'Per-language traps and idioms.' },
  frontend: { label: 'Frontend', blurb: 'UI frameworks, styling, accessibility, browser behaviour.' },
  backend: { label: 'Backend', blurb: 'APIs, services, async work, integrations.' },
  data: { label: 'Data', blurb: 'Databases, migrations, queries, caching.' },
  testing: { label: 'Testing', blurb: 'What to test, how, and when a test is lying to you.' },
  quality: { label: 'Code quality', blurb: 'Refactoring, review, readability, performance.' },
  infrastructure: { label: 'Infrastructure', blurb: 'Build, package, deploy, observe.' },
  security: { label: 'Security', blurb: 'Getting the dangerous parts right.' },
  practice: { label: 'Working practice', blurb: 'Commits, documentation, communication, process.' },
};

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  // ===================== CORE =====================
  {
    id: 'builtin.read-before-write',
    name: 'Read before you write',
    category: 'core',
    description: 'Ground every change in the code that exists, not in what a file is probably called.',
    alwaysOn: true,
    triggers: [],
    instructions: `Before changing anything you have not read this turn, read it. Not the file you assume exists — the file that does.

- Locate the real code with find_symbol / find_references / search before editing. A change written against a remembered API is a change to a function that does not exist.
- When you change a shared type, signature or exported constant, find its callers with find_references and fix them IN THE SAME CHANGE. A compile error you leave behind is worse than the bug you fixed.
- If a file is over ~600 lines, read the region you are changing plus its imports and exports, not the whole thing. Reading everything is not thoroughness, it is spending the context you will need later.
- After an edit that the project can check, run its typecheck or its tests. "It should work" is a hypothesis; the command is the experiment.`,
  },
  {
    id: 'builtin.follow-conventions',
    name: 'Match the codebase',
    category: 'core',
    description: 'New code should be indistinguishable from the code around it.',
    alwaysOn: true,
    triggers: [],
    instructions: `Write code that looks like it was already there.

- Copy the surrounding file's conventions: naming, error handling, import style, comment density, how it structures a module. Your preferences are irrelevant here; consistency is a feature.
- Use the libraries the project already depends on. Check package.json / requirements.txt / go.mod BEFORE reaching for anything new. Adding a dependency is a decision with a maintenance cost, and it is the user's to make.
- Match the existing test style — same runner, same file layout, same assertion library.
- If the codebase is internally inconsistent, follow whatever the file you are editing does, then say so rather than silently picking a side.`,
  },
  {
    id: 'builtin.error-handling',
    name: 'Errors people can act on',
    category: 'core',
    description: 'What to do when something can fail — and what the message has to say.',
    triggers: ['error', 'exception', 'try catch', 'error handling', 'throw', 'fail', 'failure', 'crash', 'stack trace'],
    instructions: `An error message is read exactly once, by someone who is stuck. Write it for them.

- Say what failed, what was being attempted, and what to do next. "Invalid input" fails all three; "Expected a port between 1 and 65535, got 0 — check the PORT environment variable" passes.
- Include the VALUE that caused the failure, and the identifier that locates it (path, id, url). Never include a secret, a token or a password.
- Never swallow an error into a bare \`catch {}\`. If it genuinely does not matter, say why in a comment; if it does, propagate it or handle it.
- Do not catch an error just to re-throw it with less information. Wrapping is fine; wrapping while dropping the cause is not.
- Fail fast at a boundary (input parsing, config load) rather than deep in the call stack where the context is gone.
- Distinguish EXPECTED failures (a missing file, a 404, a rejected login) — which are control flow — from BUGS. Only the second deserves a stack trace in the log.`,
  },
  {
    id: 'builtin.debugging',
    name: 'Systematic debugging',
    category: 'core',
    description: 'Finding the actual cause instead of changing things until the symptom moves.',
    triggers: ['debug', 'bug', 'not working', 'broken', 'why is', 'investigate', 'reproduce', 'regression', 'flaky', 'intermittent'],
    instructions: `Debugging is a search, and guessing is the slowest way to search.

1. REPRODUCE IT FIRST. A bug you cannot trigger on demand is a bug you cannot confirm you fixed. Write the smallest command or test that shows it.
2. READ THE ACTUAL ERROR. The whole message, the whole stack, the first frame in YOUR code. Most "mysterious" bugs are described precisely in a line nobody read.
3. FORM ONE HYPOTHESIS AND TEST IT. Change one thing. If it did not help, change it back before trying the next. Three simultaneous changes make the result uninterpretable.
4. BISECT. Halve the search space: comment out half, check git log for when it last worked, add a log at the midpoint of the flow.
5. VERIFY THE FIX against the reproduction from step 1, then check that you have not broken the neighbours.

Two rules that save the most time: prefer a log of the actual VALUE over reasoning about what it must be, and when the code "obviously cannot" produce the observed behaviour, one of your assumptions is wrong — usually about which version of the code is running.`,
  },
  {
    id: 'builtin.large-change',
    name: 'Large or risky changes',
    category: 'core',
    description: 'Sequencing work so the project is never broken for long.',
    triggers: ['refactor', 'rewrite', 'migrate', 'redesign', 'restructure', 'big change', 'breaking change', 'rename across'],
    instructions: `Break a large change into steps that each leave the project WORKING.

- Sequence: add the new thing alongside the old → move callers over in batches → delete the old thing. Never "delete and rebuild", which leaves an unknown amount of time where nothing runs.
- Land the mechanical part (a rename, a move) separately from the behavioural part. A diff that both moves a file and changes what it does cannot be reviewed.
- Verify between steps, not at the end. The cost of finding a mistake grows with how much you piled on top of it.
- For a rename that crosses files, use rename_symbol rather than search-and-replace: it understands scope, and a text replace will hit a comment, a string and an unrelated variable with the same name.
- If the change turns out to be larger than expected, say so and re-plan rather than pressing on. An honest "this is bigger than it looked, here is what I found" is worth more than a half-finished refactor.`,
  },

  // ===================== LANGUAGES =====================
  {
    id: 'builtin.typescript',
    name: 'TypeScript',
    category: 'languages',
    description: 'Types that catch bugs rather than types that satisfy the compiler.',
    triggers: ['typescript', 'ts', 'type error', 'tsconfig', 'generic', 'interface', 'type guard'],
    fileHints: ['ts', 'tsx', 'mts', 'cts'],
    instructions: `Types are for the reader and for the compiler, in that order.

- \`any\` is a hole in the type system, and \`as\` is a lie you are telling the compiler. Both are occasionally right and usually a sign the model is wrong. Prefer \`unknown\` plus a narrowing check.
- Make illegal states unrepresentable: a discriminated union beats an object with five optional fields and an implicit rule about which combinations are valid.
- Type the BOUNDARY (function signatures, exported types, API shapes) and let inference do the inside. Annotating every local is noise.
- \`strictNullChecks\` findings are real. \`x!\` says "I know better"; be sure you do, and prefer an early return that makes it true.
- For a value crossing a trust boundary (network, disk, user), validate at runtime — the type annotation is a comment as far as the running program is concerned.
- Do not widen a type to make an error go away. The error is usually correct and the fix is at the call site.`,
  },
  {
    id: 'builtin.javascript',
    name: 'JavaScript',
    category: 'languages',
    description: 'Async, equality and the traps that survive every framework.',
    triggers: ['javascript', 'js', 'node', 'promise', 'async', 'await', 'callback', 'event loop'],
    fileHints: ['js', 'jsx', 'mjs', 'cjs'],
    instructions: `- Every promise must be awaited or explicitly handled. A floating promise loses its error, and an unhandled rejection can take the process down.
- \`await\` inside a loop serialises work that could be concurrent. Use \`Promise.all\` for independent work — and DO NOT use it for work that must be sequential, which is the opposite mistake.
- \`Promise.all\` rejects on the first failure and abandons the rest; \`Promise.allSettled\` when you need every outcome.
- Array methods do not await. \`array.forEach(async …)\` runs everything at once and finishes immediately, which is almost never what was meant. Use a \`for…of\` loop with \`await\`, or \`Promise.all(array.map(…))\`.
- \`===\` unless you specifically want \`== null\` to catch both null and undefined.
- Mutating a shared object is how a bug appears in a module that never mentions the value. Prefer returning new objects at boundaries.
- Node: CommonJS and ESM do not mix freely. Check \`"type"\` in package.json before choosing \`require\` or \`import\`.`,
  },
  {
    id: 'builtin.python',
    name: 'Python',
    category: 'languages',
    description: 'Idioms, environments, and the mutable-default trap.',
    triggers: ['python', 'pip', 'venv', 'pytest', 'django', 'flask', 'fastapi', 'poetry', 'conda'],
    fileHints: ['py', 'pyi'],
    instructions: `- NEVER use a mutable default argument (\`def f(x=[])\`). It is created once and shared by every call. Use \`None\` and build inside.
- Respect the virtual environment. Check for \`.venv\`/\`venv\`/Poetry/conda before installing, and install into it rather than globally.
- Type hints on public functions; they are documentation the tooling can check. \`from __future__ import annotations\` for forward references in older versions.
- Prefer a context manager for anything with a lifetime (files, connections, locks). A \`finally\` that closes something is a context manager waiting to be extracted.
- Catch the specific exception. \`except Exception\` hides the bug you have not thought of; a bare \`except:\` also catches Ctrl-C.
- f-strings for formatting. \`%\` and \`.format\` only where the format string must be data.
- Comprehensions when they fit on a line and read as one thought; a loop when they do not. A triple-nested comprehension is write-only.`,
  },
  {
    id: 'builtin.go',
    name: 'Go',
    category: 'languages',
    description: 'Error values, contexts, and goroutine lifetimes.',
    triggers: ['golang', 'go mod', 'goroutine', 'channel'],
    fileHints: ['go'],
    instructions: `- Handle every error where it happens. \`if err != nil\` is not boilerplate, it is the language's entire error model, and \`_ = err\` throws away the only signal you get.
- Wrap with context: \`fmt.Errorf("reading config: %w", err)\`. The \`%w\` is what lets callers use \`errors.Is\`/\`errors.As\`.
- Every goroutine needs a defined end. Pass a \`context.Context\`, select on \`ctx.Done()\`, and never start one whose lifetime you cannot state in a sentence.
- \`defer\` for cleanup, immediately after acquiring the thing. Remember it runs at FUNCTION exit, not block exit — a defer inside a loop accumulates.
- Accept interfaces, return structs. Define the interface where it is CONSUMED, not next to the implementation.
- Prefer a channel for handing off ownership and a mutex for protecting shared state. Using a channel as a lock is a common and confusing inversion.`,
  },
  {
    id: 'builtin.rust',
    name: 'Rust',
    category: 'languages',
    description: 'Ownership, error types, and fighting the borrow checker less.',
    triggers: ['rust', 'cargo', 'borrow checker', 'lifetime', 'crate'],
    fileHints: ['rs'],
    instructions: `- A borrow-checker error is usually a design problem stated precisely. Before adding a lifetime annotation or an \`Rc<RefCell<_>>\`, ask whether the ownership could simply be clearer — cloning a small value to move on is often the right call and always better than a wrong abstraction.
- \`Result\` for recoverable failure, \`panic!\` only for a broken invariant. \`.unwrap()\` in library code is a crash waiting for a user; in a test it is fine.
- Use \`?\` for propagation, and a real error type (thiserror, or a hand-written enum) at the crate boundary. \`Box<dyn Error>\` is fine inside a binary and unhelpful in a library.
- Prefer iterators to index loops: they are faster to read and eliminate an entire class of off-by-one.
- \`clippy\` is not pedantry, it is a second reviewer. Run it and act on it.
- Derive \`Debug\` on everything; you will want it at 2am.`,
  },
  {
    id: 'builtin.java-kotlin',
    name: 'Java & Kotlin',
    category: 'languages',
    description: 'Nullability, immutability, and JVM build systems.',
    triggers: ['java', 'kotlin', 'spring', 'maven', 'gradle', 'jvm'],
    fileHints: ['java', 'kt', 'kts'],
    instructions: `- Kotlin: let the type system carry nullability. \`!!\` defeats the whole point; use \`?.\`, \`?:\` or an early return.
- Java: \`Optional\` for return values that may be absent, never for fields or parameters. Returning \`null\` from a method whose name promises a value is how NPEs are born.
- Prefer immutable data: \`val\`/\`record\`/\`final\`, and defensive copies at boundaries.
- Constructor injection over field injection — it makes the dependencies visible and the class testable without a container.
- Do not catch and log and continue. Either handle it or let it propagate; "log and swallow" produces a system that is broken and quiet.
- Gradle/Maven: keep dependency versions in one place (a version catalog or a parent POM), not scattered through modules.`,
  },
  {
    id: 'builtin.shell-scripting',
    name: 'Shell scripting',
    category: 'languages',
    description: 'Scripts that fail loudly instead of continuing into nonsense.',
    triggers: ['bash', 'shell script', 'sh script', 'zsh', 'powershell script', 'batch file'],
    fileHints: ['sh', 'bash', 'zsh', 'ps1'],
    instructions: `- Start every bash script with \`set -euo pipefail\`. Without it a failed command is ignored, an unset variable becomes an empty string, and \`rm -rf "$DIR/"\` with an unset DIR deletes the root.
- Quote EVERY variable expansion: \`"$path"\`, not \`$path\`. An unquoted path with a space becomes two arguments.
- \`"$@"\` to forward arguments, never \`$*\`.
- Check that a command exists before using it (\`command -v jq >/dev/null\`) and say what to install if it does not.
- Prefer a real language once a script grows past ~100 lines or needs data structures. Bash arrays and string manipulation are where scripts go to become unmaintainable.
- On Windows, know which shell you are writing for: cmd.exe uses \`&&\` and \`%VAR%\`, PowerShell 5.1 has no \`&&\` at all, and PowerShell 7 does. The three are not interchangeable.`,
  },

  // ===================== FRONTEND =====================
  {
    id: 'builtin.react',
    name: 'React',
    category: 'frontend',
    description: 'Hooks, re-renders, and the stale-closure family of bugs.',
    triggers: ['react', 'hook', 'usestate', 'useeffect', 'component', 'jsx', 'rerender', 'context provider'],
    fileHints: ['jsx', 'tsx'],
    instructions: `- The effect dependency array is not a suggestion. A missing dependency is a STALE CLOSURE — the effect keeps reading the first render's values — and it presents as "it works the first time and then stops".
- Most \`useEffect\` calls should not exist. Derive during render, handle in the event handler, and reserve effects for genuine outside-React synchronisation (subscriptions, timers, the DOM). Fetching in an effect is usually better done by the router or a data library.
- Every effect that subscribes must return a cleanup. Without one you leak a listener per render and get duplicate handlers in development.
- Keys must be stable and identify the ITEM. An array index as a key corrupts state when the list reorders — the classic "the wrong row is now checked".
- Never call a hook conditionally or in a loop.
- Before reaching for \`memo\`/\`useMemo\`/\`useCallback\`, confirm there is a measured problem. Memoising everything costs allocations and readability, and most re-renders are cheap.
- Lift state only as far as it needs to go. State at the top of the tree re-renders the whole tree.`,
  },
  {
    id: 'builtin.vue-svelte',
    name: 'Vue & Svelte',
    category: 'frontend',
    description: 'Reactivity models that are not React\'s.',
    triggers: ['vue', 'svelte', 'sveltekit', 'nuxt', 'composition api', 'runes'],
    fileHints: ['vue', 'svelte'],
    instructions: `- Vue 3: \`ref\` for primitives, \`reactive\` for objects, and remember that destructuring a reactive object BREAKS reactivity — use \`toRefs\`.
- Vue: \`computed\` for derived state; a watcher that only assigns to another ref is a computed written the hard way.
- Svelte 4: assignment is what triggers reactivity, so \`arr.push(x)\` does nothing visible — \`arr = [...arr, x]\`. Svelte 5: use runes (\`$state\`, \`$derived\`) and do not mix the two models in one component.
- Both: prefer props down and events up over reaching into a child. A store is for state that genuinely has no owner.
- Keep template expressions trivial. Logic in a template cannot be tested and is re-evaluated on every render.`,
  },
  {
    id: 'builtin.css',
    name: 'CSS & layout',
    category: 'frontend',
    description: 'Layout that holds up at other sizes and in the other theme.',
    triggers: ['css', 'style', 'layout', 'flexbox', 'grid', 'responsive', 'tailwind', 'scss', 'dark mode'],
    fileHints: ['css', 'scss', 'less'],
    instructions: `- Flexbox for one dimension, grid for two. Absolute positioning only when the element is genuinely out of flow — it is the main cause of layouts that break at other sizes.
- A flex or grid child will not shrink below its content unless you say so. \`min-width: 0\` (or \`min-height: 0\`) on the child is the fix for the overflow that "should not be possible".
- Never hard-code a colour. Use the design system's variables, or the theme is broken in the mode you did not test.
- Test both themes and a narrow viewport before saying it is done. Most CSS bugs are invisible at the size the author happened to be using.
- Prefer \`gap\` to margins for spacing between siblings — it does not collapse and does not leave a stray edge margin.
- Respect \`prefers-reduced-motion\` for anything that moves.`,
  },
  {
    id: 'builtin.accessibility',
    name: 'Accessibility',
    category: 'frontend',
    description: 'The parts that are cheap to do right and expensive to retrofit.',
    triggers: ['accessibility', 'a11y', 'screen reader', 'aria', 'keyboard navigation', 'focus', 'wcag', 'contrast'],
    instructions: `- Use the real element. \`<button>\` is focusable, activates on Enter and Space, and announces itself; a \`<div onClick>\` does none of that and needs four attributes to catch up.
- Everything usable with a mouse must be usable with a keyboard, in a sensible order. Tab through what you built.
- Never remove a focus outline without replacing it with something visible. \`outline: none\` alone makes the page unusable without a mouse.
- Every input needs a label — a real \`<label for>\`, not a placeholder. Placeholders vanish on typing and are not announced consistently.
- Images need alt text that says what they MEAN. Decorative images take \`alt=""\` so they are skipped.
- Text contrast: 4.5:1 for body, 3:1 for large text. This is measurable, so measure it rather than judging by eye.
- ARIA is a last resort. A wrong \`role\` is worse than no role.`,
  },
  {
    id: 'builtin.frontend-performance',
    name: 'Frontend performance',
    category: 'frontend',
    description: 'Making a page fast where it is actually slow.',
    triggers: ['slow page', 'performance', 'bundle size', 'lighthouse', 'lazy load', 'code split', 'jank', 'lag'],
    instructions: `- MEASURE FIRST. A profile or a network waterfall, not a guess. The slow part is routinely not the part that looks complicated.
- The biggest wins are usually not in the code: an unoptimised image, a blocking font, a 400KB dependency imported for one function, a request waterfall that could be parallel.
- Code-split at the route boundary first; component-level splitting rarely pays for its complexity.
- A long list needs virtualisation past a few hundred rows. Rendering ten thousand DOM nodes is slow no matter how fast the framework is.
- Layout thrash: reading a layout property (\`offsetHeight\`, \`getBoundingClientRect\`) after a write forces a synchronous reflow. Batch reads, then writes.
- Debounce input handlers; throttle scroll and resize. An unthrottled scroll handler is the classic cause of jank.`,
  },

  // ===================== BACKEND =====================
  {
    id: 'builtin.api-design',
    name: 'API design',
    category: 'backend',
    description: 'Interfaces other people can use without reading your code.',
    triggers: ['api', 'endpoint', 'rest', 'graphql', 'route handler', 'openapi', 'http api'],
    instructions: `- Correct status codes. 200 for success, 201 with a location for creation, 400 for a malformed request, 401 unauthenticated, 403 authenticated-but-not-allowed, 404 not found, 409 conflict, 422 semantically invalid, 5xx for OUR fault. Returning 200 with \`{"error": …}\` breaks every client's error handling.
- Validate input at the edge and reject with a message naming the field and the expectation.
- Errors get a consistent shape across every endpoint. A client should be able to write one error handler.
- Never return more than the caller needs. Serialise explicitly; spreading a database row leaks the column you add next month.
- Paginate any list that can grow. Retrofitting pagination is a breaking change.
- Design for idempotency where a retry is plausible — a duplicate POST should not create two orders.
- Version before you need to. Adding a field is compatible; changing or removing one is not.`,
  },
  {
    id: 'builtin.concurrency',
    name: 'Concurrency',
    category: 'backend',
    description: 'Races, locks, and work that must not happen twice.',
    triggers: ['race condition', 'concurrency', 'deadlock', 'mutex', 'lock', 'thread safe', 'atomic', 'parallel', 'worker pool'],
    instructions: `- Name the shared mutable state. If there is none, there is no race; if there is, everything below applies to exactly that.
- Check-then-act is a race: \`if (!exists) create()\` runs twice under concurrency. Use a transaction, a unique constraint, or an atomic upsert.
- Take locks in a consistent order everywhere, or you will deadlock. Hold them for the shortest possible time, and never across an await/IO.
- Prefer a queue with one consumer to a lock, when the work can be serialised. It is easier to reason about and easier to observe.
- Anything that can be retried must be idempotent, because it WILL be retried.
- Timeouts on everything that waits. A wait without a timeout is a hang.
- Concurrency bugs are load-dependent, so a passing test proves very little. Reason about the interleaving explicitly rather than testing until it goes quiet.`,
  },
  {
    id: 'builtin.background-jobs',
    name: 'Background jobs',
    category: 'backend',
    description: 'Work that happens later, reliably.',
    triggers: ['background job', 'queue', 'worker', 'cron', 'scheduled task', 'celery', 'sidekiq', 'bullmq'],
    instructions: `- Every job must be idempotent. Delivery is at-least-once in practice whatever the docs say, and a job that charges a card twice is a very expensive lesson.
- Pass an ID, not an object. By the time the job runs the object is stale; re-read it.
- Bound the retries and use exponential backoff with jitter. Infinite retries on a permanently poisoned message is a self-inflicted outage.
- A dead-letter destination for what will never succeed, and something that actually looks at it.
- Make jobs small and resumable. A four-hour job that fails at 3:59 has done nothing.
- Log the job id, the attempt number and the outcome. A job system you cannot observe is a job system you cannot trust.`,
  },
  {
    id: 'builtin.integrations',
    name: 'Third-party integrations',
    category: 'backend',
    description: 'Calling someone else\'s service without inheriting their outages.',
    triggers: ['third party', 'external api', 'webhook', 'integration', 'rate limit', 'sdk', 'stripe', 'oauth flow'],
    instructions: `- Timeout every outbound call. The default in most HTTP clients is "forever", and one slow dependency then exhausts your connection pool.
- Retry only what is safe to retry, with backoff and a cap. Retrying a non-idempotent POST creates duplicates.
- Handle rate limits by reading the response headers, not by guessing. Respect \`Retry-After\`.
- Never trust the shape of a third-party response. Validate it; a provider WILL change a field.
- Webhooks: verify the signature, respond fast (queue the work), and expect duplicates — deduplicate on the event id.
- Keep credentials out of code and logs. Log the request id, not the payload.
- Isolate the integration behind one module, so that swapping it or stubbing it in tests touches one file.`,
  },

  // ===================== DATA =====================
  {
    id: 'builtin.sql',
    name: 'SQL & query performance',
    category: 'data',
    description: 'Queries that stay fast when the table grows.',
    triggers: ['sql', 'query', 'postgres', 'mysql', 'sqlite', 'index', 'join', 'slow query', 'database'],
    fileHints: ['sql'],
    instructions: `- Never build SQL by string concatenation with user input. Parameterised queries, always — this is the single most exploited bug class in the industry.
- Select the columns you need. \`SELECT *\` moves data you do not use and breaks when a column is added.
- An index on the column you filter and sort by is usually the whole answer to a slow query. Check with EXPLAIN rather than adding indexes hopefully — every index costs write throughput.
- Watch for N+1: one query for the list, then one per row. Fix with a join or a batched \`WHERE id IN (…)\`.
- \`LIMIT\` on anything a human will look at.
- Transactions around multi-statement invariants, and keep them SHORT. A transaction held open across a network call holds locks for the length of that call.
- Beware \`NOT IN\` with nullable columns — it does not mean what it looks like. Use \`NOT EXISTS\`.`,
  },
  {
    id: 'builtin.migrations',
    name: 'Schema migrations',
    category: 'data',
    description: 'Changing a schema without downtime or data loss.',
    triggers: ['migration', 'schema change', 'alter table', 'add column', 'drop column', 'prisma migrate', 'alembic', 'flyway'],
    instructions: `- Every migration is FORWARD-ONLY in production, whatever the rollback story says. Write it as if it cannot be undone, because rolling back a migration that dropped a column does not bring the data back.
- Expand, migrate, contract — in SEPARATE deploys:
  1. Add the new column/table, nullable, with no code depending on it.
  2. Backfill in batches, and deploy code that writes both old and new.
  3. Switch reads to the new one.
  4. Only then remove the old one.
  Renaming a column in one step breaks every running instance of the old code the moment it lands.
- Adding a NOT NULL column with a default rewrites the whole table on older Postgres and MySQL. On a large table that is a lock and an outage: add nullable, backfill in batches, then add the constraint.
- Add indexes CONCURRENTLY on Postgres; a plain CREATE INDEX locks writes.
- A migration must be idempotent or guarded, because it will be run twice by something eventually.
- Back up before anything destructive, and say so in the response.`,
  },
  {
    id: 'builtin.data-modelling',
    name: 'Data modelling',
    category: 'data',
    description: 'Getting the shape right, because it is the hardest thing to change later.',
    triggers: ['data model', 'schema design', 'normalize', 'denormalize', 'relationship', 'foreign key', 'entity'],
    instructions: `- Model what is TRUE about the domain, not what is convenient for today's screen. Screens change weekly; the meaning of an order does not.
- Constraints in the database: NOT NULL, UNIQUE, FOREIGN KEY, CHECK. Application-level validation is a nicety; the database is the only thing that cannot be bypassed.
- Normalise until it hurts, denormalise until it works — and when you denormalise, write down what keeps the copies in step.
- Store timestamps in UTC with a timezone-aware type. "It was fine locally" is the most expensive sentence in date handling.
- Never store money as a float. Integer minor units or a decimal type.
- Prefer soft-delete only where you can name who needs the deleted rows. Otherwise it is a permanent tax on every query and a GDPR problem.`,
  },
  {
    id: 'builtin.caching',
    name: 'Caching',
    category: 'data',
    description: 'Speed without serving yesterday\'s data.',
    triggers: ['cache', 'caching', 'redis', 'memoize', 'ttl', 'invalidate', 'stale data'],
    instructions: `- Before caching, ask what makes it slow. A cache over a missing index hides the problem and adds a second one.
- Decide the invalidation strategy BEFORE adding the cache. "We will figure it out" becomes a stale-data bug reported by a customer.
- Prefer a short TTL to clever invalidation. Being at most 60 seconds stale is usually fine and is dramatically simpler than being exactly right.
- Cache keys must include every input that changes the answer — including the user, the locale and the permissions. A cache key that omits the user is a data leak.
- Never cache a response that depends on authorisation without the identity in the key.
- Handle the cache being DOWN. A cache is an optimisation; the system must work without it, slower.
- Watch for the stampede: when a popular key expires, every request recomputes it at once. Use a lock or a stale-while-revalidate.`,
  },

  // ===================== TESTING =====================
  {
    id: 'builtin.testing',
    name: 'Writing tests',
    category: 'testing',
    description: 'Tests that catch real bugs and survive refactoring.',
    triggers: ['test', 'tests', 'unit test', 'jest', 'vitest', 'pytest', 'testing', 'spec file', 'coverage'],
    fileHints: ['test.ts', 'spec.ts', 'test.js', 'test.py'],
    instructions: `- Test BEHAVIOUR through the public interface, not implementation. A test that asserts an internal method was called breaks on every refactor and catches no bugs.
- Name the test after the case, not the function: "rejects a negative quantity" tells you what broke; "test addItem 2" does not.
- One reason to fail per test. A test with six assertions about six things reports one failure and hides the other five.
- Cover the edges, because that is where the bugs are: empty, one, many, null, very large, wrong type, concurrent, out of order, unicode, timezone boundary.
- A test with no failing case is not a test. Before trusting a new test, break the code and watch it fail — a surprising number of tests pass on a broken implementation.
- Mock the boundary (network, clock, filesystem), never the thing you are testing. A test that mocks everything asserts that your mocks work.
- Deterministic: no real time, no real network, no shared mutable state between tests, no dependence on test order.`,
  },
  {
    id: 'builtin.test-strategy',
    name: 'What to test',
    category: 'testing',
    description: 'Spending test effort where it actually reduces risk.',
    triggers: ['test strategy', 'what should i test', 'integration test', 'e2e', 'test pyramid', 'test coverage'],
    instructions: `- Test what would be expensive to get wrong: money, permissions, data loss, anything irreversible. Test what is subtle: parsing, state machines, concurrency, date maths.
- Do not test what the framework already guarantees, or a getter, or a constant. Coverage of trivial code is coverage theatre.
- Prefer a few real integration tests over many heavily-mocked unit tests. The bugs that reach production are usually in the seams the mocks replaced.
- End-to-end tests are slow and flaky in proportion to their number. A handful covering the critical journeys; not one per feature.
- Coverage percentage is a smoke detector, not a goal. 100% coverage with no assertions is possible and worthless.
- When you fix a bug, write the test that would have caught it FIRST, and watch it fail. That is the one test you know has value.`,
  },
  {
    id: 'builtin.flaky-tests',
    name: 'Flaky tests',
    category: 'testing',
    description: 'A test that fails sometimes is a bug report you are ignoring.',
    triggers: ['flaky test', 'intermittent failure', 'passes locally', 'ci fails', 'race in test', 'test timeout'],
    instructions: `- Never fix a flake with a retry or a longer sleep. That converts a signal into silence, and roughly half of flakes are real concurrency bugs in the code under test.
- The usual causes, in order of frequency: a fixed sleep instead of waiting for a condition; shared state between tests; dependence on test ORDER; real time or timezone; unawaited async work leaking into the next test; a real network call.
- Replace sleeps with waiting for the actual condition, with a generous timeout.
- Make each test create and destroy its own fixtures. A test that depends on another test's leftovers passes alone and fails in CI.
- Freeze the clock. Anything involving "now" is a scheduled failure otherwise.
- Reproduce by running the test alone, then in a loop, then with the suite in a different order. Which of the three fails tells you the cause.`,
  },

  // ===================== QUALITY =====================
  {
    id: 'builtin.code-review',
    name: 'Reviewing code',
    category: 'quality',
    description: 'What to look for, in order of what actually matters.',
    triggers: ['review', 'code review', 'pull request', 'pr review', 'critique', 'look over'],
    instructions: `Review in this order, because a comment about naming on code that is wrong is wasted:

1. CORRECTNESS. Does it do what it claims? Walk the edge cases: empty, null, error path, concurrent, the second call.
2. SAFETY. Injection, authorisation, secrets, data loss, anything irreversible.
3. FIT. Does it match the codebase? Does it duplicate something that exists?
4. CLARITY. Will the next reader understand it? Are the names honest?
5. STYLE. Last, and mostly the formatter's job.

When reporting: say what is wrong, why it matters, and what to do instead. Distinguish a bug from a preference and say which you are stating. Do not invent problems to look thorough — "this looks correct, here is the one thing I would change" is a complete review.`,
  },
  {
    id: 'builtin.refactoring',
    name: 'Refactoring',
    category: 'quality',
    description: 'Improving structure without changing behaviour.',
    triggers: ['refactor', 'clean up', 'simplify', 'extract', 'tidy', 'technical debt', 'code smell'],
    instructions: `- Refactoring means behaviour does NOT change. If behaviour changes, that is a rewrite and it needs tests and a separate commit.
- Have a test (or a typecheck, or a run) that would notice if you broke it BEFORE you start. Refactoring without a safety net is editing hopefully.
- One transformation at a time, verified. Extract a function, run the tests. Rename, run the tests.
- Delete rather than deprecate when nothing calls it. Version control remembers; a commented-out block does not.
- Duplication is not automatically a defect. Two things that look alike but change for different reasons should stay apart — the wrong abstraction costs more than the duplication.
- Do not refactor code you were not asked to touch. It bloats the diff, hides the real change and invites a merge conflict.`,
  },
  {
    id: 'builtin.naming',
    name: 'Naming and readability',
    category: 'quality',
    description: 'Code is read far more often than it is written.',
    triggers: ['naming', 'rename', 'readable', 'readability', 'variable name', 'clarity'],
    instructions: `- A name should say what the thing IS or what it DOES, in the vocabulary of the domain. \`data\`, \`info\`, \`temp\`, \`handleStuff\` say nothing.
- Length should scale with scope. \`i\` in a three-line loop is fine; a module-level \`c\` is not.
- Booleans read as assertions: \`isReady\`, \`hasChanges\`, \`shouldRetry\`. Avoid negatives — \`notDisabled\` is a puzzle.
- Say the units and the type when they are not obvious: \`timeoutMs\`, \`sizeBytes\`, \`priceMinorUnits\`.
- Do not abbreviate beyond what the domain already abbreviates. \`usr\`, \`calc\`, \`mgr\` save four characters and cost a moment of translation every single read.
- A comment should say WHY, not what. If a comment explains what the code does, the code needs the work, not the comment. The exception is a non-obvious constraint: "this must run before X because…" is exactly what comments are for.`,
  },
  {
    id: 'builtin.dependencies',
    name: 'Dependencies',
    category: 'quality',
    description: 'Every dependency is a permanent commitment.',
    triggers: ['dependency', 'package', 'npm install', 'library', 'upgrade', 'version conflict', 'lockfile'],
    instructions: `- Adding a dependency is the user's decision, not yours. Check what is already installed first; a great deal of what people reach for is a few lines of the standard library.
- Weigh it: is it maintained, how big is it, how many transitive dependencies does it bring, what is the licence, and what happens if it is abandoned?
- Commit the lockfile. Reproducible builds are the entire point.
- Upgrade deliberately: patch and minor freely, major with the changelog open. Never bulk-upgrade everything at once — when it breaks you will not know which one did it.
- Pin exactly what has burned you before; let the rest float within semver.
- Remove dependencies that are no longer used. Dead dependencies still carry vulnerabilities.`,
  },

  // ===================== INFRASTRUCTURE =====================
  {
    id: 'builtin.docker',
    name: 'Docker & containers',
    category: 'infrastructure',
    description: 'Images that build fast and run safely.',
    triggers: ['docker', 'dockerfile', 'container', 'compose', 'image', 'kubernetes', 'k8s'],
    fileHints: ['dockerfile'],
    instructions: `- Order layers from least to most frequently changed: base, system packages, dependency manifests, dependency install, then source. Copying source before installing dependencies invalidates the cache on every edit and turns a 10-second build into two minutes.
- Multi-stage builds: compile in one stage, copy only the artefact into a slim runtime. Shipping the toolchain is a bigger image and a bigger attack surface.
- Never run as root. Create a user and \`USER\` it.
- Never bake a secret into an image. Layers are permanent and readable by anyone who pulls it.
- Pin base image versions. \`:latest\` makes builds unreproducible and upgrades unintentional.
- A \`.dockerignore\` that excludes node_modules, .git and build output. Without it the whole directory is uploaded as build context.
- One process per container, and let the orchestrator restart it. Supervisors inside containers hide failures.`,
  },
  {
    id: 'builtin.ci-cd',
    name: 'CI/CD',
    category: 'infrastructure',
    description: 'Pipelines that catch problems and can be trusted.',
    triggers: ['ci', 'cd', 'pipeline', 'github actions', 'gitlab ci', 'jenkins', 'deploy', 'workflow yaml'],
    instructions: `- CI must run the same checks a developer runs locally, or it becomes a second source of truth that disagrees with the first.
- Fail fast: lint and typecheck before the slow test suite.
- Cache dependencies, keyed on the lockfile hash. Keying on anything else either never hits or serves a stale cache.
- Never put a secret in the YAML or echo one in a log. Use the platform's secret store, and remember logs are often public on open-source projects.
- Pin action/image versions to a SHA or a tag you chose. \`@main\` means someone else can change your pipeline.
- Deployment should be one reviewed, repeatable, revertible step. A deploy that only one person can do is an outage waiting for their holiday.
- Make the pipeline reproducible locally where you can. "Only fails in CI" is a very expensive class of bug.`,
  },
  {
    id: 'builtin.observability',
    name: 'Logging & observability',
    category: 'infrastructure',
    description: 'Being able to answer questions about a system you cannot attach a debugger to.',
    triggers: ['logging', 'log', 'monitoring', 'metrics', 'tracing', 'observability', 'alert', 'telemetry'],
    instructions: `- Log with structure (key/value), not by interpolating into a sentence. Structured logs can be queried; prose can only be grepped.
- Every log line needs enough context to be actionable alone: the request/job id, the user or tenant, the operation. A line saying "failed" tells you nothing.
- Levels mean things: ERROR needs a human, WARN is suspicious but handled, INFO is a significant state change, DEBUG is for development. Logging everything at ERROR trains people to ignore errors.
- NEVER log secrets, tokens, passwords, full card numbers or personal data. Redact at the logging boundary so it cannot be forgotten at a call site.
- Log at the boundaries — request in, request out, job start/end — rather than every line of the middle.
- Alert on symptoms users feel (error rate, latency, queue depth), not on causes (CPU). An alert nobody acts on should be deleted.`,
  },
  {
    id: 'builtin.build-tooling',
    name: 'Build tooling',
    category: 'infrastructure',
    description: 'Bundlers, compilers and the config that makes them behave.',
    triggers: ['webpack', 'vite', 'rollup', 'esbuild', 'build config', 'bundler', 'tsconfig', 'babel'],
    instructions: `- Understand what the build already does before adding to it. Most "the build is broken" reports are a config option fighting another config option.
- Keep dev and production builds as similar as possible. Every difference is a bug that only appears in production.
- Source maps in production, served privately if the code is sensitive. Debugging minified stack traces is a self-inflicted wound.
- Check the bundle before and after a dependency change. A single import can pull in a megabyte.
- Environment variables at build time are BAKED IN and public. Never put a secret in one that reaches the client — \`VITE_\`/\`NEXT_PUBLIC_\` prefixes are published to the world.
- If a build step is slow, measure which plugin. It is usually one.`,
  },
  {
    id: 'builtin.git',
    name: 'Git',
    category: 'infrastructure',
    description: 'History that helps rather than a wall of "fix".',
    triggers: ['git', 'commit', 'branch', 'merge', 'rebase', 'conflict', 'stash', 'cherry-pick'],
    instructions: `- One logical change per commit. A commit that fixes a bug and reformats a file cannot be reverted, reviewed or bisected.
- Subject line: imperative, under ~72 characters, saying WHAT changed. Body: why, and anything surprising. "Fix bug" is a wasted line.
- Never force-push a shared branch. It rewrites history other people have, and their next pull is a mess they did not cause.
- Resolve a conflict by understanding both sides. Taking "ours" wholesale silently discards someone's work.
- Do not commit secrets. If you do, the fix is to ROTATE the secret — removing it from history does not un-publish it.
- \`git bisect\` is the fastest way to find when something broke, and it only works if commits are small and each one builds.`,
  },

  // ===================== SECURITY =====================
  {
    id: 'builtin.security-basics',
    name: 'Security fundamentals',
    category: 'security',
    description: 'The vulnerabilities that actually get exploited.',
    triggers: ['security', 'vulnerability', 'exploit', 'sanitize', 'xss', 'csrf', 'injection', 'owasp'],
    instructions: `- Never build a query, command or path by concatenating untrusted input. Parameterised queries, argument arrays, and path resolution checked against a root.
- Escape on OUTPUT, in the context you are outputting into. HTML, attribute, URL and JavaScript contexts each need different escaping, and \`innerHTML\` with user data is the default way to get XSS.
- Validate on the server. Client-side validation is a convenience for honest users and no obstacle at all to anyone else.
- Authorisation on every request, checked against the CURRENT user. An id in a URL that is not checked against the session is the most common serious vulnerability in real applications.
- Do not roll your own crypto, tokens or password hashing. Use the platform's primitives — argon2/bcrypt for passwords, a vetted library for JWTs.
- Secrets from the environment or a secret manager, never from source. Rotate anything that has ever been committed.
- Fail closed. If the authorisation check errors, deny.`,
  },
  {
    id: 'builtin.auth',
    name: 'Authentication & sessions',
    category: 'security',
    description: 'Login, tokens and the mistakes that cost accounts.',
    triggers: ['auth', 'login', 'authentication', 'session', 'jwt', 'oauth', 'password', 'token expiry', 'refresh token'],
    instructions: `- Hash passwords with argon2id or bcrypt, never a general-purpose hash however many rounds. Salting is the library's job, not yours.
- Session cookies: \`HttpOnly\`, \`Secure\`, \`SameSite=Lax\` or \`Strict\`. A token in localStorage is readable by any XSS on the page.
- Verify a JWT's signature AND its algorithm. Accepting the token's own \`alg\` header is the classic \`alg: none\` bypass.
- Short-lived access tokens, rotating refresh tokens, and a way to revoke. A JWT you cannot revoke is a permanent grant.
- Rate-limit login and password reset. Without it, credential stuffing is trivial.
- Do not tell an attacker which half was wrong: "incorrect email or password" for both.
- Password reset tokens: single use, short expiry, invalidated on use and on password change.`,
  },
  {
    id: 'builtin.secrets',
    name: 'Secrets handling',
    category: 'security',
    description: 'Keeping credentials out of the places they end up.',
    triggers: ['secret', 'api key', 'credential', 'env var', 'dotenv', 'token storage', 'keychain'],
    instructions: `- Secrets come from the environment or a secret manager. Never from source, never from a committed config file, never from a comment.
- \`.env\` in \`.gitignore\`, with a \`.env.example\` listing the KEYS and no values.
- Redact at the boundary: the logger, the error formatter, the crash reporter. Relying on every call site to remember is relying on the one that forgets.
- A secret in a URL is in the browser history, the referrer header and every proxy log. Use a header.
- Anything that has been committed, pasted or logged is compromised. Rotate it — deleting it from history does not recall the copies.
- Prefer short-lived, scoped credentials to long-lived admin ones. Scope is what limits the blast radius when one leaks.`,
  },
  {
    id: 'builtin.input-validation',
    name: 'Input validation',
    category: 'security',
    description: 'Every external input is hostile until proven otherwise.',
    triggers: ['validation', 'validate', 'sanitize', 'user input', 'zod', 'schema validation', 'parse'],
    instructions: `- Parse, do not validate: convert untrusted input into a trusted TYPE at the boundary, once, and let the type carry the guarantee inwards. Scattered \`if (x)\` checks are how one path gets missed.
- Allow-list, do not deny-list. You cannot enumerate everything an attacker might send; you can enumerate what you accept.
- Bound everything: string length, array size, number range, upload size, nesting depth. An unbounded input is a denial of service.
- Validate the file CONTENT, not the extension or the client's content type. Both are attacker-controlled.
- Normalise before comparing (unicode, case, path separators) — otherwise two spellings of the same thing pass different checks.
- Reject with a message that says which field and what was expected, without echoing the raw input back into an HTML page.`,
  },

  // ===================== PRACTICE =====================
  {
    id: 'builtin.documentation',
    name: 'Documentation',
    category: 'practice',
    description: 'Writing the thing that is read when someone is stuck.',
    triggers: ['documentation', 'readme', 'docs', 'docstring', 'jsdoc', 'changelog', 'comment this'],
    fileHints: ['md', 'mdx', 'rst'],
    instructions: `- A README answers four questions in order: what is this, how do I run it, how do I use it, how do I contribute. Anything before "what is this" is decoration.
- Every command in the docs must actually work, from a clean checkout, on the platforms you claim to support. Untested instructions are worse than none — they cost trust as well as time.
- Document the WHY. The what is in the code; the reasoning behind a non-obvious decision exists nowhere else and is the thing people need.
- Keep docs next to what they describe, so they are updated in the same change.
- Say what something does NOT do, and its limits. That is what stops someone using it wrongly.
- Prefer a short example to a long description. People copy the example.`,
  },
  {
    id: 'builtin.commits',
    name: 'Commits & pull requests',
    category: 'practice',
    description: 'Making changes reviewable by someone who was not there.',
    triggers: ['commit message', 'pull request', 'pr description', 'changelog entry', 'squash'],
    instructions: `- A pull request should do ONE thing. A reviewer's attention is finite, and it is spent on the first hundred lines whatever the diff size.
- The description says: what changed, why, and how to verify it. Include what you tested and what you deliberately did not.
- Call out anything risky, anything you were unsure about, and anything the reviewer should look at hardest. Reviewers find what you point at.
- Keep unrelated formatting out. A whitespace change spread across a file makes the real change invisible.
- Reference the issue, and say what it does NOT fix if it only fixes part.
- Draft a PR early if you want direction on the approach; a finished PR is an expensive place to discover the approach was wrong.`,
  },
  {
    id: 'builtin.performance-work',
    name: 'Performance work',
    category: 'practice',
    description: 'Making something faster, provably.',
    triggers: ['performance', 'optimize', 'optimise', 'slow', 'speed up', 'profiling', 'benchmark', 'memory leak', 'latency'],
    instructions: `- MEASURE FIRST, and write down the number. Optimising without a baseline is not engineering, and the bottleneck is routinely somewhere nobody suspected.
- Fix the biggest thing. A 90% saving on 2% of the runtime is not worth the complexity it costs.
- Prefer an algorithmic fix to a micro-optimisation. Removing an N² is worth more than every clever trick combined.
- The usual real causes, in order: doing it more times than necessary (N+1, re-render, re-parse), doing it at the wrong time (blocking, serial when it could be parallel), moving too much data, and only then slow code.
- Measure again after the change, the same way. "It feels faster" is not a result.
- Stop when it is fast enough. Say what the number is now and what the remaining bottleneck is.`,
  },
  {
    id: 'builtin.reading-unfamiliar-code',
    name: 'Reading unfamiliar code',
    category: 'practice',
    description: 'Orienting in a codebase you have never seen.',
    triggers: ['understand', 'explain', 'how does', 'what does this do', 'walk me through', 'unfamiliar', 'legacy code', 'onboard'],
    instructions: `- Start from an ENTRY POINT, not from the file list: main, the route table, the CLI command, the test that exercises the feature. Reading alphabetically teaches you nothing about how it fits together.
- Follow one real path all the way through — one request, one command — before trying to understand the whole. Breadth without one complete depth is a list of names.
- Use get_repo_map for shape, find_symbol to jump, find_references to see how something is actually used. Real call sites tell you more than the definition.
- Read the tests. They are executable documentation of the intended behaviour, including the edge cases the author worried about.
- Check git history for a confusing piece of code — the commit that introduced it usually says why.
- When you explain it back, describe the FLOW and the responsibilities, not the file structure. Name the two or three decisions the design turns on.`,
  },
  {
    id: 'builtin.long-autonomous-runs',
    name: 'Long autonomous runs',
    category: 'practice',
    description: 'Working for hours without drifting, looping or losing the thread.',
    triggers: ['keep going', 'work through', 'until done', 'autonomous', 'unattended', 'overnight', 'loop until', 'all of them'],
    instructions: `Working unattended for a long time fails in specific ways. Guard against each.

- MAINTAIN THE PLAN. Update it as you go with set_status, not by re-sending it. The plan is your memory across a compaction — an abandoned plan is how a long run forgets what it was for.
- CHECKPOINT WITH REALITY. Every few steps, run the project's typecheck or tests. Twenty unverified edits is not twenty steps of progress, it is one large unverified change.
- NEVER REPEAT A FAILED ACTION UNCHANGED. If something failed twice, the third attempt fails too. Change the approach or state clearly what is blocking you.
- WATCH, DO NOT POLL. For anything slow, register a detached watch and end the turn; you will be resumed with the result. Polling burns the context you need.
- PREFER SMALL VERIFIED STEPS to large hopeful ones. When context is compacted, finished-and-verified work survives as facts on disk; half-finished work survives as confusion.
- KNOW WHEN TO STOP. If you are blocked on a decision only the user can make, ask and stop. Guessing on an ambiguous requirement for two hours produces two hours of work to throw away.
- LEAVE THE TREE WORKING. Whenever you pause, the project should build. Someone may look at it before you resume.`,
  },
  {
    id: 'builtin.scaffolding',
    name: 'New projects & scaffolding',
    category: 'practice',
    description: 'Setting up a project so the first hour is not spent on the toolchain.',
    triggers: ['new project', 'scaffold', 'create app', 'bootstrap', 'set up', 'starter', 'init project', 'from scratch'],
    instructions: `- Use the official scaffolder where one exists (\`npm create vite\`, \`cargo new\`, \`django-admin startproject\`). Hand-assembling a project means owning a config nobody else recognises.
- Scaffolders ask questions. Pass the flags that answer them (\`--template\`, \`--yes\`, \`--no-git\`) — an interactive prompt in a non-interactive shell hangs until it is killed.
- Install dependencies and VERIFY the install landed before writing code against them. A half-finished install produces "module not found" errors that look like your mistake.
- Get one thing running end to end before adding anything: start the dev server, load the page, see it work. Debugging a five-feature app that has never run is debugging five things at once.
- Set up the checks early — typecheck, lint, test, format. Retrofitting them onto a large codebase means fixing hundreds of findings at once.
- Commit the scaffold on its own, before your changes. It makes every later diff readable.`,
  },
  {
    id: 'builtin.ambiguity',
    name: 'Handling ambiguity',
    category: 'practice',
    description: 'What to do when the request does not determine the answer.',
    triggers: ['not sure', 'unclear', 'ambiguous', 'which approach', 'options', 'should i', 'what do you think'],
    instructions: `- Separate what the request DETERMINES from what it leaves open. Most requests are unambiguous about the goal and silent about a detail that does not matter — decide those yourself and say what you decided.
- Ask only when different readings produce materially different work, and when getting it wrong means throwing that work away. One good question beats four hours in the wrong direction.
- When you ask, ask about the DECISION, not about something you could look up. "Should this be a modal or a page?" is a question; "what is this function called?" is a task.
- Offer a recommendation with the question. "I'd default to X because Y — or Z if you want W" is far easier to answer than an open question.
- If you proceed on an assumption, state it explicitly in the response so it can be corrected cheaply.
- Never silently narrow the scope. Doing the easy half of a request without saying so is the failure mode that wastes the most time.`,
  },
];

/** Fast lookup by id, for the enable/disable layer. */
export const BUILTIN_SKILL_IDS = new Set(BUILTIN_SKILLS.map((s) => s.id));

export function builtinSkillById(id: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}
