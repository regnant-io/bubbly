<div align="center">

<img src="frontend/public/bubble.svg" width="72" height="72" alt="">

# Bubbly

**A local-first AI coding agent, with a desktop IDE and a terminal client.**

Your code stays on your machine. Your model is your choice. The agent works on a
local folder, on a remote host over SSH, or on a repository it clones for you —
using the same tools in every case.

</div>

---

## What it is

Bubbly is an agent that does real engineering work in a codebase: reads it,
changes it, runs it, and tells you what happened. It runs entirely on your own
machine — a local backend, a local database, a local UI — and talks to whichever
model provider you configure.

There are three ways to use it, and they are the same product:

| | |
|---|---|
| **Desktop app** | A native window with a chat, a file tree, a Monaco editor, a real terminal and a live preview. Closing it minimises to the system tray; your threads keep running. |
| **Terminal** | `bubbly` opens an interactive session; `bubbly run "…"` does one task and exits with a meaningful code. |
| **Backend** | An HTTP + WebSocket service you can run headless and point either client at. |

The clients speak the same protocol to the same backend, so a thread you start
in the terminal opens in the app, and vice versa.

## Why it exists

Most coding agents are a chat window with a file-write tool attached. The
difficult parts of the job are not in the model — they are in everything around
it, and that is where Bubbly puts its effort:

- **Knowing when it is done.** Verification is a first-class step, not a
  suggestion. Workflows require evidence before a phase can end.
- **Not losing the thread.** The working plan, the running processes, the open
  waits and the installed dependencies are re-stated to the model on every call,
  so a long run does not drift or repeat itself.
- **Waiting without burning tokens.** A watcher parks a wait in the backend and
  wakes the thread when it settles, instead of polling a build for six minutes at
  full context cost.
- **Telling the truth about failure.** A truncated search says it was truncated.
  A partial install says the tree is not trustworthy. A tool that ran in the
  wrong shell says which one. A repo map that only covers part of a very large
  repository says so, rather than letting the agent conclude a file is missing.
- **Not stopping when you look away.** Closing the window minimises to the
  system tray; the backend, its threads, its dev servers and its waits all keep
  going. A six-minute build is not interrupted by you being done looking at it.

## Install

### Desktop

Download the build for your platform from
[Releases](../../releases), or build it yourself:

**Linux/macOS:**
```bash
git clone <this-repo> bubbly && cd bubbly
chmod +x setup.sh make-executable.sh
./make-executable.sh  # Make all scripts executable
./setup.sh            # Install dependencies
npm run dist          # Build for current platform
```

**Windows:**
```cmd
git clone <this-repo> bubbly && cd bubbly
npm run setup
npm run dist
```

Installers land in `desktop/release/`:
- **Windows**: `.exe` (installer), `.exe` (portable)
- **macOS**: `.dmg` (Intel + Apple Silicon), `.zip`
- **Linux**: `.AppImage` (universal), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), `.tar.gz`

Node.js 18+ must be installed and on `PATH` — the desktop shell runs the backend
with the system Node so its native modules match your platform.

**Quick start scripts:**
- Linux/macOS: `./run.sh` - Interactive setup and launch menu
- Windows: `start.bat` - Start development mode

### Terminal

**Linux/macOS:**
```bash
chmod +x install-cli.sh
./install-cli.sh       # Builds and installs globally
```

**Windows:**
```cmd
install-cli.bat
```

Or manually:
```bash
npm --prefix cli install && npm --prefix cli run build
npm --prefix cli link      # puts `bubbly` on your PATH
```

## Getting started

**Terminal CLI:**
```bash
bubbly doctor              # check everything is wired up
bubbly                     # interactive session in the current directory
bubbly "add a health check endpoint"
bubbly /fix "login redirects to / instead of the dashboard"
bubbly run "update the changelog" --json
```

Once a session is open, `/help` lists everything. Outside one:

```bash
bubbly status              # what is running: threads, dev servers, waits
bubbly stop                # halt every running turn
bubbly config              # read settings; `bubbly config <key> <value>` writes
bubbly serve --detach      # leave a backend running after this shell exits
```

**Background commands** live in the backend, not in your terminal — start one
and close the window:

```bash
bubbly bg start "npm run dev"   # returns immediately with an id
bubbly bg list                  # what is running, and where it is serving
bubbly bg logs <id> --follow    # tail it
bubbly bg stop --all            # one command to stop everything
```

This is the same process table the agent reads, so `bubbly bg list` and the
agent's own view of what is running can never disagree.

**Development mode (Linux/macOS):**
```bash
./setup.sh                 # First time only
./start.sh                 # Starts backend + frontend
```

**Development mode (Windows):**
```cmd
setup.bat                  # First time only
start.bat                  # Starts backend + frontend
```

In the app: open a folder, pick a model in **Settings → AI Providers**, and type.

**Platform-specific guides:**
- See `INSTALL_UNIX.md` for detailed Linux/macOS instructions
- See `PLATFORM_GUIDE.md` for cross-platform command reference

## Where the work happens

A thread runs in one of three places, chosen from the composer before the first
message:

**Local** — a directory on this machine.

**SSH** — a directory on another machine. Every tool executes *there*: reads,
writes, searches, commands, background processes, terminals. Nothing is mirrored
locally, so nothing can drift. Bubbly uses your existing `ssh-agent`, your
`~/.ssh` keys and your `~/.ssh/config`; hosts already configured there can be
imported in one click.

**Repository** — a GitHub or GitLab project (including self-hosted), cloned into
a managed directory and worked on locally. Authentication reuses your git
credential helper, then `gh`/`glab`, then a token you have saved — usually
nothing to configure. The agent can read issues, open pull requests and comment,
but deliberately cannot merge, force-push or close anything.

## Models

| Provider | Notes |
|---|---|
| **Anthropic** | Claude models via API key. |
| **Ollama** | Local models. Context window resolved from `/api/show`, not guessed. |
| **Google Gemini** | Context window resolved from the API. |
| **OpenRouter** | Anything OpenRouter serves; context window resolved from its catalogue. |

Bubbly measures context pressure against the model's *real* window, compacts
history when it approaches it, and migrates to a fresh thread with a handoff
summary rather than hitting a hard overflow.

## Slash commands

Typing `/` opens one picker with two kinds of command in it, tagged so you can
tell them apart at a glance.

### Workflows — `run`

Prompt programs, not text shortcuts. Each one states the phases the work must go
through, what evidence is required to leave each phase, and what is out of scope.

```
/implement   understand → design → build → verify
/fix         reproduce → diagnose → fix the cause → prove it
/review      correctness first, style last
/test        write tests, then break the code to prove they work
/refactor    behaviour held constant, with a safety net
/audit       the vulnerabilities that actually get exploited
/ship        verify → commit → push → open a PR
/loop        work towards a goal until it is met or the budget runs out
```

`/loop` is the one to know about for long unattended work. It takes a goal, a
stop condition and two budgets (rounds and wall-clock), starts each round by
checking the real state rather than trusting its own summary, and stops early
when the goal is met, when it is blocked, or when two rounds produce no
measurable progress.

### Client commands — `do`

Actions the app or the terminal performs directly. No model is involved, which
is exactly why they are a separate kind: there is no prompt that changes which
model is answering.

```
/new /threads /resume /cd          the thread you are in
/stop /plan /watch /approve        the run in flight
/context /compact /cost            what the window is holding
/init /todos /checkpoint /diff     this project
/model /config /tools /mcp         settings
/status /doctor /help              is everything working
/bg /verbose                       terminal only
```

The catalogue is served by the backend (`GET /api/settings/commands`), so the
desktop app and the terminal offer the same commands under the same names, and
a command that cannot work on one surface is not shown there.

## While the agent is working

A thread runs one turn at a time — two loops over one conversation would
duplicate every tool call — but that does not mean you have to sit still.

- **Type anyway.** Up to three messages queue against the running turn and are
  handed to the agent at its next step, framed as corrections that take priority.
  They appear in the transcript at the point the agent actually read them.
- **Skip a wait.** A watcher's deadline is set hours out on purpose, so a
  healthy build is never reported as a failure. When you can see it is not going
  to happen, Skip settles that one wait and tells the agent a human made the
  call — it moves on rather than diagnosing a failure that did not occur.
- **Follow the phases.** The agent names what it is doing (`set_phase`, or a
  plan step going in progress) and a burst of twenty tool calls renders as the
  three or four pieces of work it actually was: building, finding the failure,
  fixing it, verifying.

## Skills

Bubbly ships with **48 built-in skills** — conditional engineering knowledge
injected only when it is relevant, matched on the words in your message and the
file types in play. Ten categories, from schema migrations to flaky tests to
long autonomous runs. At most eight apply at once, strongest match first, so the
base prompt stays small.

Every skill can be switched off. None can be deleted. You can add your own, and
give one the same id as a built-in to replace it.

## Safety

Permissions are set from the composer, because the right answer changes with the
task:

- **Guarded** — every file write and every command waits for you.
- **Balanced** — edits go ahead (visible in Changes, revertible per prompt);
  commands wait.
- **Autonomous** — nothing waits. For unattended runs, in a workspace where the
  worst case is acceptable.

At every level: genuinely destructive commands are refused outright, every
prompt takes a checkpoint you can revert to, and every action is written to an
audit log you can read and export.

**Credentials** are never stored in the database. They go in an encrypted vault
(AES-256-GCM), whose master key is held in your OS keychain when running the
desktop app, or in a `0600` key file otherwise, or derived from a passphrase you
set. Bubbly prefers credentials you already have — an ssh-agent key means it
never sees a secret at all.

**The backend binds to loopback only** and rejects WebSocket upgrades from any
origin that is not Bubbly. It can read your files and run commands; it is not
something to expose to a network.

**An unanswered permission request expires** after thirty minutes and is
recorded as *expired*, not as *declined* — "a human looked at this and said no"
and "nobody was watching" are different facts and the audit log keeps them apart.

## Large repositories

Indexing is what scales badly in an agent, and it scales badly quietly. Bubbly's
structural index — the thing behind `get_repo_map`, `find_symbol` and
`find_references` — walks the tree and parses every source file, and on a
monorepo that is minutes of blocked event loop rather than the few hundred
milliseconds it is on a normal project.

So it is bounded, and it is honest about the bound:

- **Dependencies and build output are never walked.** The exclusion list covers
  `node_modules`, `vendor`, `Pods`, `target`, `bazel-out`, `.venv`, `DerivedData`
  and about thirty others — a directory missing from that list does not just
  slow the index down, it dilutes the map with generated code.
- **The walk has a file budget and a time budget**, and it is breadth-first, so
  a truncated index is a shallow view of the whole repository rather than an
  exhaustive view of whichever subdirectory happened to be first.
- **A truncated map says it is truncated**, in the map itself, and tells the
  agent that absence from it does not mean a file does not exist. `search`,
  `read_file` and `get_file_tree` are unbounded and still see everything.
- **The index is cached longer on a large repository**, because there a rebuild
  costs more than staleness does. The agent's own writes invalidate it
  immediately regardless, so its changes are never stale to itself.

Search has the same shape: file, byte and time budgets, and a result that says
`STOPPED EARLY` rather than quietly returning a partial answer as a complete one.

## Configuration

Everything lives in `~/.bubbly/`:

```
~/.bubbly/
  bubbly.db          threads, messages, settings, audit log
  vault.json         encrypted credentials
  repos/             repositories cloned for Git workspaces
  logs/              rotating backend logs
```

Per-project instructions go in `.bubbly/` inside the workspace itself — steering
documents the agent reads on every run, and specs it authors as ordinary
markdown you can read and edit.

## Development

**Linux/macOS:**
```bash
./setup.sh             # install backend + frontend
./start.sh             # backend on :3001, frontend on :3000
./test.sh              # run all tests
npm run desktop        # build everything and launch the Electron shell
```

**Windows:**
```cmd
setup.bat              # install backend + frontend  
start.bat              # backend on :3001, frontend on :3000
npm --prefix backend test
npm run desktop        # build everything and launch the Electron shell
```

Four workspaces:

```
backend/    the agent loop, tools, workspace providers, HTTP + WebSocket
frontend/   React UI (also served by the backend in production)
desktop/    Electron shell — window, menus, OS integration
cli/        terminal client, speaking the same protocol
```

The WebSocket event protocol in `backend/src/types.ts` is the contract between
backend and clients. It is mirrored by hand in `frontend/src/types.ts`; change
both together.

Themes are generated: edit `frontend/src/styles/palettes.ts` and run
`node scripts/gen-themes.js`. CI fails if the generated CSS is out of date.

## Licence

MIT. See [LICENSE](LICENSE).
