# Contributing

## Getting set up

```bash
npm run setup                 # backend + frontend
npm --prefix cli install
npm run dev                   # backend :3001, frontend :3000
```

`npm run desktop` builds everything and launches the Electron shell.

## Before you open a pull request

```bash
npm --prefix backend exec tsc -- --noEmit
npm --prefix frontend exec tsc -- --noEmit
npm --prefix cli exec tsc -- --noEmit
npm --prefix backend test
node scripts/gen-themes.js    # if you touched palettes.ts
```

CI runs exactly this. It also fails if `themes.css` is out of date with respect
to `palettes.ts`, because a generated file that has drifted from its source is
worse than no generator.

## Things that will trip you up

These are not style preferences. Each one is a bug that has already shipped once.

**The protocol lives in two files.** `backend/src/types.ts` and
`frontend/src/types.ts` are mirrored by hand. Change both together or your event
silently half-lands.

**A new tool that touches the workspace needs a remote implementation.** Add it
to `REMOTE_HANDLED_TOOLS` and implement it in `workspace/remoteTools.ts`, or it
will operate on the local disk while the thread is on another machine.

**Shell rewrites are per-dialect.** `&&` is native in `cmd.exe` and a parse error
in Windows PowerShell 5.1. A rewrite that does not ask which shell is running
will destroy every chained command in the product. See `shellDialect.ts`.

**`cmd.exe` needs `windowsVerbatimArguments`.** Without it, Node escapes quotes
in a form cmd cannot read — the command is corrupted *and its failure is
reported as exit code 0*.

**Child environments come from `buildChildEnv`.** Do not spread `process.env`
into a spawn. `NODE_ENV=production` from a packaged build makes every user's
`npm install` skip devDependencies.

**Migrations must be idempotent.** They will be run twice by something.

**Themes are generated.** Edit `styles/palettes.ts`, never `themes.css`.

## Tests

Write the test that would have caught the bug, and watch it fail against the old
behaviour before you fix it. A test that has never failed has not been shown to
test anything.

Where a test exists for something that looks trivial, add a comment saying which
failure it is holding the line against. The existing tests do this and it is the
reason they are still useful.

The suite is heaviest where being wrong is most expensive: shell quoting, remote
path containment, the credential vault, context compaction, plan integrity, and
whether search tells the truth about what it did not look at.

## Commits and pull requests

One logical change per commit; an imperative subject line under ~72 characters;
a body explaining *why* if it is not obvious.

A pull request should do one thing. Say what changed, why, how to verify it, and
what you deliberately did not do. Call out anything you were unsure about —
reviewers find what you point at.

## Code style

Match the file you are editing. The codebase has a consistent voice: comments
explain *why* rather than restating the code, and non-obvious decisions carry the
reasoning that produced them — including what was tried and rejected. That is
deliberate, and it is the main reason the tricky parts (shell dialects, context
migration, watcher binding) are maintainable at all.

If a comment could be deleted without losing anything, delete it. If a decision
took you an hour to reach, write down what you learned.

## Adding a skill

Built-in skills live in `agent/builtinSkills.ts`. Before adding one, check it
against the three tests documented at the top of that file:

1. **Actionable** — a checkable instruction, not a sentiment.
2. **Non-obvious** — something a capable model gets wrong under pressure.
3. **Well-triggered** — fires when relevant and stays silent otherwise.

Triggers match on word boundaries. A trigger like `api` or `go` that also matches
inside other words will fire constantly and push a genuinely relevant skill out
of the eight-skill budget.

## Adding a workflow

Workflows live in `agent/workflows.ts`. The bar is simple: **if deleting the
workflow's text would not change how the run goes, it should not exist.** A
workflow that just rephrases the request is the old slash-command behaviour
wearing a new name.
