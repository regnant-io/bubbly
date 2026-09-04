# Architecture

How Bubbly is put together, and why it is put together that way. This is for
people changing the code; [README.md](README.md) is for people using it.

## The shape

```
                    ┌──────────────┐   ┌──────────────┐
                    │ Desktop app  │   │     CLI      │
                    │  (Electron)  │   │  (terminal)  │
                    └──────┬───────┘   └──────┬───────┘
                           │  WebSocket + REST │
                           └─────────┬─────────┘
                                     ▼
                        ┌────────────────────────┐
                        │        backend         │
                        │  agent loop · tools    │
                        │  providers · sessions  │
                        └───────────┬────────────┘
                                    ▼
                    ┌───────────────┴───────────────┐
                    ▼               ▼               ▼
              local disk       SSH host        git remote
```

One backend, two clients, one protocol. That is the load-bearing decision in the
whole system.

### Why the CLI is a client, not a second agent

The obvious way to build a CLI for an agent is to import the agent loop and run
it in-process. It works on the first day and diverges forever: two
implementations of approvals, of compaction, of what `/fix` means, and every fix
applied to one of them.

So the CLI speaks the same WebSocket protocol the desktop app speaks. It gets
every feature automatically, including ones added after it was written, and a
thread started in the terminal opens in the app because it is the same thread.

The cost is that the CLI needs a backend running. `bubbly serve` and `--start`
exist for that; the alternative cost was much higher.

## The workspaces

```
backend/     the agent, its tools, and the HTTP + WebSocket service
frontend/    React UI, served by the backend in production
desktop/     Electron shell: window, menus, OS integration, keychain
cli/         terminal client
scripts/     build helpers, including the theme generator
```

### backend

```
src/
  index.ts              HTTP + WebSocket entry point
  agent/
    orchestrator.ts     the agent loop
    chatDispatch.ts     plain message vs workflow vs loop
    workflows.ts        slash commands, as prompt programs
    clientCommands.ts   the slash commands the CLIENTS perform, catalogued here
    loopRunner.ts       /loop — budgets, stall detection, stopping
    fileDrift.ts        files changed by someone other than the agent
    planManager.ts      the working plan, server-owned
    skills.ts           conditional expertise selection
    builtinSkills.ts    the 48 shipped skills
    contextManager.ts   compaction
    contextMigration.ts moving to a fresh thread near the limit
    runtimeState.ts     what is TRUE right now, restated every call
    tools/              the tool implementations
    intelligence/       tree-sitter indexing, symbols, repo map
  workspace/            local / SSH / git providers, forge APIs
  secrets/              the credential vault and credential discovery
  session/              threads, messages, persistence
  terminal/             PTY-backed interactive terminals
  models/               provider clients
  db/                   SQLite schema and migrations
```

## The agent loop

`runAgentLoop` in `orchestrator.ts` is one `while` loop:

1. Report context usage; compact if over budget; migrate if near the limit.
2. Build the live state block and append it to the system prompt.
3. Call the model, streaming text, reasoning and tool arguments.
4. Execute each tool call, requesting approval where policy demands it.
5. Append the results and go round again — until the model returns no tool
   calls, which is how it says it is finished.

Two things about this are worth knowing before changing it.

**Single-flight.** `activeSessions` is the only record of "is this thread busy",
and the check happens after the session id is known and before any work begins.
Two concurrent runs on one thread duplicate every tool call and both write to the
same history.

**The live state block is per-iteration, not per-turn.** A turn can run twenty
tool calls; the install that finished on iteration 4 has to be visible to
iteration 5. It is built from process tables and stat calls, so it is far cheaper
than the wasted tool call it prevents.

**A turn does not end while something is waiting to be said.** Before the loop
breaks on "no tool calls" it drains two queues: messages the user typed mid-run
(`queueUserMessage`), and watcher results that settled after the agent had
already decided to stop. Both are things the loop already holds and has not
shown the model, and ending the turn on top of either is how "I told it and it
ignored me" and "the watcher fired but nothing woke up" happen.

## Two kinds of slash command

`workflows.ts` holds prompt PROGRAMS: `/fix` expands server-side into several
hundred words and the agent works on them. `clientCommands.ts` holds a
CATALOGUE of commands the clients perform themselves — `/model`, `/clear`,
`/status`, `/bg`.

The split is not cosmetic. There is no prompt that changes which model is
answering, and writing one that pretends otherwise is how a command surface
stops being trustworthy. So the behaviour lives in each client
(`frontend/src/utils/clientCommands.ts`, `cli/src/commands/localCommands.ts`)
and only the LIST is shared, served from `GET /api/settings/commands?surface=…`.
Each entry declares which surfaces it works on, so a command that cannot do
anything on one of them is never shown there.

> **Adding a client command means editing three files**: the catalogue, and both
> implementations. If it only makes sense on one surface, narrow `surfaces` and
> edit two.

## The workspace provider

Every tool that touches the workspace goes through one interface
(`workspace/types.ts`). A local workspace gets an implementation backed by `fs`
and `spawn`; an SSH workspace gets one backed by a live `ssh2` connection.

The seam is in `executeTool`: it calls `executeRemoteTool` **first**, which
handles the tools listed in `REMOTE_HANDLED_TOOLS` and returns `null` for
everything else.

That list is deliberately narrow and auditable. The alternative — rewriting every
tool to go through the provider — touches every tool and every test to change
behaviour that already works locally, and the failure mode of a missed call site
is not a compile error but a write to the wrong machine.

> **If you add a tool that touches the workspace, add it to
> `REMOTE_HANDLED_TOOLS` and implement it in `remoteTools.ts`.** Otherwise it
> will silently operate on the local disk while the thread is remote.

Git is not a remote execution target. A git remote is storage, not a computer;
repositories are cloned to `~/.bubbly/repos` and worked on locally, with the
forge API layered on top for issues and pull requests.

## Shells

Windows shell handling is the single most bug-prone area in the codebase, and
`agent/tools/shellDialect.ts` documents why at length. In summary:

- The **dialect** is explicit and chosen per command. PowerShell syntax goes to
  PowerShell, POSIX syntax goes to Git Bash when installed, everything else goes
  to `cmd.exe` where the JS toolchain behaves best.
- Every rewrite is a function of the dialect. `&&` is native in cmd.exe and a
  parse error in PowerShell 5.1; a rewrite that ignores which one is running
  destroys every chained command.
- `cmd.exe` needs `windowsVerbatimArguments` with the command wrapped in its own
  quote pair. Without it Node escapes embedded quotes in a form cmd cannot read,
  which corrupts the command **and reports its failure as exit code 0**.

Child process environments come from `utils/childEnv.ts`, which inherits the
user's real environment minus the variables that describe Bubbly's own process.
`NODE_ENV` is the important one: inherited from a packaged build it makes every
`npm install` skip devDependencies and report "up to date" forever.

## Context management

Three mechanisms, in escalating order:

1. **Compaction** (`contextManager.ts`) — truncate old tool results, keep the
   goal and the recent turns verbatim, protect the user's own words. Runs to 70%
   of the budget so it does not re-trigger immediately.
2. **The budget** scales with the model's real window rather than a fixed
   number. A 24k budget on a 200k model shreds the working set while most of the
   window sits unused.
3. **Migration** (`contextMigration.ts`) — near the limit, summarise and continue
   in a fresh thread, carrying the live state block so the new thread does not
   restart a dev server that never stopped.

## Watchers

`agent/tools/watchers.ts`. An agent waiting on a six-minute build by polling pays
a full model round-trip per poll. A watcher moves the wait into the backend,
where waiting is free.

Watchers bind to the process that owes them the condition, so a dev server that
dies on startup is reported in seconds with its error, rather than as a timeout
five minutes later. A **detached** watcher wakes its thread when it settles —
which is the only reason "end your turn, you'll be resumed" is true rather than
aspirational.

Two things make that promise hold rather than nearly hold. The settle listener
stands down while the thread is still running, so the loop asks
`watchers.hasUndelivered(sessionId)` before it ends a turn and picks up anything
that settled inside the gap. And `watchers.skip(id)` lets a PERSON end one wait
without stopping the turn — the agent is told a human made that call, so it
moves on instead of diagnosing a failure that did not occur.

## The desktop shell is a view, not the app

`desktop/main.js` runs a system tray. Closing the last window HIDES it; the
backend, its threads, its background processes and its watchers all keep
running, and `app.quit()` happens only from the tray or Cmd/Ctrl-Q.

This is what makes a six-minute build survive you being done looking at it, and
it changes two invariants elsewhere: `window-all-closed` must not quit while a
tray exists, and the watcher wake-up path must run even when no window is
listening (its events are persisted to the thread and read back when one opens).
The tray menu is rebuilt from `GET /api/status`, which is the only place that
knows which threads are actually working — `activeSessions` is in memory,
because a database row saying "running" survives a crash and then lies forever.

## Persistence

SQLite at `~/.bubbly/bubbly.db`, via `better-sqlite3`. Schema in `db/index.ts`;
changes go in a numbered migration under `db/migrations/` and are registered in
`migrationRunner.ts`. Migrations must be idempotent — they will be run twice by
something eventually.

Secrets never go in the database. See `secrets/vault.ts`.

## The protocol

`WSServerEvent` in `backend/src/types.ts` is the contract. It is mirrored by hand
in `frontend/src/types.ts` because there is no shared package.

> **Change both together.** A protocol change made in one file silently
> half-lands: the backend emits an event no client handles, or the client
> handles one that is never sent.

Every event carries a monotonic `seq` assigned at send time. The client renders
in emission order — without it, a response with three tool calls paints three
call cards and then three results at the bottom, claiming an order of events that
never happened.

## Frontend

React 18 + Zustand + Tailwind. All agent events arrive through
`hooks/useWebSocket.ts` and land in `store/index.ts`.

Themes are **generated**. `styles/palettes.ts` is the source of truth;
`scripts/gen-themes.js` derives `themes.css` including the `-rgb` channel
mirrors Tailwind's opacity modifiers require. A hand-written mirror that drifts
produces an element that renders transparent in one mode of one theme, which is
close to undiscoverable. CI fails if the generated file is stale.

Selection is two independent attributes: `data-palette` for the theme,
`data-theme` for light/dark. Collapsing them means switching to dark silently
changes which theme you are using.

**`border-border` takes no opacity modifier.** Its alpha is baked into
`var(--border)`, so `border-border/40` compiles to `rgb(rgba(…) / .4)` — invalid
CSS, which the browser drops, falling back to Tailwind's default border colour.
That default is gray-200: a bright white line, which is how a file-tree indent
guide and the run timer ended up outlined in white on a dark theme. Use
`border-hairline/40` when a border genuinely needs its own alpha; it goes
through the `--border-rgb` channel mirror. `borderColor.DEFAULT` now points at
the theme border as well, so the worst case of a future slip is an invisible
hairline rather than a white one.

## Testing

`npm --prefix backend test`. The suite is heaviest where the cost of being wrong
is highest: shell dialects and quoting, remote path containment, the credential
vault, context compaction, plan integrity, search honesty.

Tests are written to pin **behaviour that has already been wrong once**. Where a
test exists for something that looks trivial, the comment above it usually
explains which bug it is holding the line against.
