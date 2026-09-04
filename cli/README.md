# `bubbly` — the terminal client

A client of the Bubbly backend, speaking the same WebSocket protocol the desktop
app speaks. Threads are shared between them: one started here opens in the app.

## Install

```bash
npm install && npm run build && npm link
```

## Use

```bash
bubbly                        # interactive session in the current directory
bubbly "add a health check"   # one task, then exit
bubbly /fix "login is broken" # run a workflow
bubbly run "…" --json         # machine-readable, for scripts and CI
```

| Command | |
|---|---|
| `bubbly chat` | interactive session |
| `bubbly run <task>` | one task, then exit |
| `bubbly workflows` | list the available workflows |
| `bubbly threads` | recent threads |
| `bubbly connect` | SSH hosts, forge accounts, detected credentials |
| `bubbly serve` | run the backend in the foreground |
| `bubbly doctor` | check everything is wired up |

## Options

| | |
|---|---|
| `-w, --workspace <path>` | directory to work in (default: the current one) |
| `-t, --thread <id>` | continue an existing thread |
| `-a, --approve <policy>` | `ask` \| `auto` \| `deny` |
| `-m, --mode <mode>` | `vibe_coding` \| `spec_session` |
| `-u, --url <url>` | backend URL (default `http://localhost:3001`) |
| `-v, --verbose` | show tool calls, output and diffs |
| `--start` | start the backend if it is not running |

## Exit codes

`bubbly run` is meant for scripts, so its exit code carries information:

| | |
|---|---|
| `0` | finished with no error |
| `1` | the agent reported an error |
| `2` | bad usage — no such directory, unknown workflow, backend unreachable |
| `3` | needed a human: an approval under `--approve deny`, or a question |

`3` is distinct from `1` on purpose. "The agent failed" and "the agent needed
permission it was not given" call for different responses from whoever reads the
log.

## In a session

`Ctrl-C` stops the agent and keeps the prompt. `Ctrl-D` exits.

`/help` lists everything. `/new` starts a fresh thread, `/cd <path>` changes
workspace, `/approve auto` changes the permission policy mid-session, and any
workflow (`/fix`, `/loop`, `/review`…) prompts for its arguments.
