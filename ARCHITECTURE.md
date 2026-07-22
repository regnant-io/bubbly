# Bubbly Architecture — Code Intelligence & Spec System

This document explains the systems that let Bubbly perform at the level of
Cursor / Antigravity, and why they make even small local models (Granite,
llama3.1, qwen2.5-coder) work well.

The guiding principle from `dream.md`:

> The breakthrough is NOT model size. It's **context narrowing**. The agent
> becomes "smart" because it searches well, retrieves well, scopes well, edits
> minimally, and validates relationships.

Bubbly implements that principle directly.

---

## 1. Code Intelligence Engine

`backend/src/agent/intelligence/`

### symbols.ts — structural extraction
A multi-language symbol extractor (TypeScript/JavaScript, Python, Go, Rust,
Java, C#). For every file it pulls out functions, classes, methods, interfaces,
types, enums, structs and the import edges between files — with compact,
single-line signatures. This is the "code as structure, not text" foundation
from the dream. It uses robust heuristics rather than heavy native parsers so
the desktop app packages cleanly.

### codeIntelligence.ts — the structural brain
Builds and caches a per-workspace index:

1. **Structural map** — every file's symbols
2. **Symbol index** — name → declarations (`find_symbol`)
3. **Reference graph** — symbol → usages (`find_references`)
4. **Import graph** — file → dependencies (+ reverse edges)
5. **Centrality (PageRank)** — which files matter most

From these it produces the key artifact — the **Repo Map**: a compressed,
ranked, token-budgeted outline of the most important/relevant files and their
signatures, optionally focused on a task. The map fits the whole project's
*shape* into a few hundred tokens. The index is mtime-incremental so it stays
fast on large repos and is invalidated automatically after each write/edit.

### validator.ts — deterministic validation
Cheap, grounded checks that run **before** any LLM judgment:
- balanced-delimiter / unterminated-string structural checks (instant, all langs)
- `tsc --noEmit` for TypeScript projects
- `python -m py_compile` for Python

It returns concrete `file:line` errors. Weak models can fix a specific reported
error far more reliably than they can self-assess "is this correct?".

---

## 2. New agent tools (context narrowing in practice)

Exposed in `backend/src/agent/tools/index.ts`:

| Tool | Purpose |
| --- | --- |
| `get_repo_map(focus?)` | Compressed ranked overview — call first to orient |
| `find_symbol(name)` | Jump to a declaration (file + line + signature) |
| `find_references(name)` | Blast radius before changing a signature |
| `get_file_outline(path)` | A file's structure without reading it all |
| `validate_changes(files)` | Deterministic syntax/type validation + repair brief |

The orchestrator also **auto-injects the repo map** (focused on the user's
request) into the first message of every session, so even a model with no
agentic discipline starts grounded in the codebase.

---

## 3. Elevated Spec System

`backend/src/types.ts`, `backend/src/agent/tools/specs.ts`

Specs are now an executable contract, not prose:

- **Requirements → EARS properties.** Each requirement becomes a testable
  acceptance property (`WHEN … THE SYSTEM SHALL …`), classified as functional /
  constraint / invariant / edge_case. Stored in `requirements.md` and `spec.json`.
- **Rich tasks.** Each task can declare `target_files`, `depends_on`,
  `satisfiesProperties`, and a concrete `acceptance` definition of done.
- **Dependency-aware scheduling.** `get_next_task` returns the first `todo`
  task whose dependencies are all `done` (topological order), so the agent
  builds foundations before things that rely on them.

---

## 4. Two-stage verification + repair loop

In `orchestrator.ts`, when a task is marked done:

1. **Deterministic validation** (`runValidation`) runs first. If syntax/type
   checks fail, the task is reverted to `in_progress` and the agent receives a
   precise repair brief (`file:line — message`). No model tokens spent yet.
2. **Semantic verification** (`verifier.ts`) then judges whether the task's
   intent is genuinely met against the real file contents.

A failure at either stage feeds the repair loop with grounded, actionable
feedback — the "self-healing" behaviour from the dream.

---

## Why this helps small models

- They don't have to hold the whole repo in their head — the repo map does it.
- They navigate by exact symbol lookups instead of fuzzy guessing.
- They get the exact files to edit, scoped tightly per task.
- They get concrete, deterministic errors to fix instead of vague "try again".
- The spec contract keeps multi-step work coherent across iterations.

Result: the system supplies the intelligence; the model just fills small,
well-defined blanks — which is something even a 3B–8B local model can do well.

---

## 5. Multi-Agent Spec Execution

`backend/src/agent/specOrchestrator.ts`, `backend/src/agent/taskAgent.ts`

In Spec Session mode Bubbly no longer runs one long free-form chat. Once a spec
exists, the **Spec Orchestrator owns the plan** and walks tasks in dependency
order. For each task it dispatches a focused **Task Agent**:

- receives a TIGHT context package — the task contract (acceptance criteria,
  target files, related properties) + a task-focused repo map + outlines of the
  files it will touch.
- has a bounded iteration budget (it does ONE thing).
- self-validates with the deterministic validator and gets one repair pass.
- reports structured progress: `dispatched → gathering_context → working →
  validating → repairing → verifying → done`.

After the task agent finishes, the independent semantic verifier double-checks
the work against the real files. A task only advances when both pass; repeated
failures surface clearly rather than stalling the run. The UI's Task Queue shows
each task's live phase, target files, and verification note.

This is the "spec mode dispatches agents instead of replying" behaviour — and
it's what keeps multi-step runs coherent and stable for weak models.

## 6. Loop Stability — Context Manager

`backend/src/agent/contextManager.ts`

Long runs accumulate huge histories that overflow the context window and break
the loop. The context manager maintains bounded working memory: it always keeps
the goal (first message) and the most recent turns verbatim, compacts the
middle (truncating large tool outputs, dropping redundant nudges), and preserves
tool_use/tool_result pairing so provider APIs stay valid. It runs every
iteration but is a no-op until history exceeds the configurable token budget.

## 7. Integrated Terminal

`backend/src/terminal/terminalManager.ts`, `frontend/src/components/Terminal/`

Real, long-lived shell sessions (PowerShell on Windows) bound to the workspace,
driven from the UI like a true IDE. Multiple tabs, live streaming output, command
history, Ctrl+C interrupt, Ctrl+\` to toggle. Pipe-based (no native PTY
dependency) so the desktop installer stays simple.

## 8. IDE polish

- **Humanized tool labels** — "Reading index.html…" while running, "Read
  index.html" when done (`frontend/src/utils/toolDisplay.ts`), with per-tool
  icons and colors.
- **Command palette** (Ctrl/Cmd+K) — fast navigation, terminal, theme, sessions.
- **Smoother streaming** — token updates are coalesced onto animation frames.
- **Expanded settings** — multi-agent toggle, auto-validate, context budget,
  task iteration cap, streaming speed, editor font size.
