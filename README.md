# 🫧 Bubbly

A local-first AI coding agent. Give it a task, it explores your codebase, writes code, runs commands, and asks for approval on anything sensitive. Runs as a **native Windows desktop app** or in your browser.

## Features

- **Native desktop IDE** — one-window Windows app with native menus and an OS folder picker (no browser, no terminal juggling)
- **Code Intelligence Engine** — multi-language symbol index, dependency graph, PageRank file ranking, and a compressed "repo map" so the agent understands large codebases without reading everything (see [ARCHITECTURE.md](ARCHITECTURE.md))
- **Structure-first navigation tools** — `get_repo_map`, `find_symbol`, `find_references`, `get_file_outline` for precise, token-cheap exploration
- **Deterministic validation + repair loop** — real syntax/type checks (tsc, py_compile) feed concrete `file:line` errors back to the agent before it claims success
- **Elevated specs** — requirements become testable EARS properties; tasks carry target files, dependencies, and acceptance criteria; scheduling is dependency-aware
- **Works with small local models** — the system does the heavy lifting (retrieval, scoping, validation) so models like Granite/llama3.1 perform well
- **Claude & Ollama** — use Anthropic's Claude API or any local Ollama model
- **Agentic loop** — multi-step planning with tools: read/write files, run shell commands, git operations, search
- **Approval flow** — agent pauses and asks before writing files or running shell commands
- **Diff viewer** — real-time display of every file change
- **Spec system** — agent creates structured specs in `.bubbly/specs/`
- **Monaco editor** — view any workspace file with syntax highlighting
- **Audit log** — every tool call and token count logged per session
- **Steering files** — drop a `BUBBLY.md` in your project to give the agent standing instructions

## Requirements

- **Node.js 18+**
- **npm**
- One of:
  - Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
  - [Ollama](https://ollama.ai) running locally with a model pulled (e.g. `ollama pull llama3.1`)

## Quick Start

### Desktop App (Windows — recommended)

Double-click **`start-desktop.bat`**, or from a terminal:

```bat
:: From the bubbly folder
start-desktop.bat
```

This installs the desktop dependencies on first run, builds the backend + frontend, and opens Bubbly in a native window. Use **File → Open Folder…** (Ctrl+O) to pick the project you want the agent to work on, then open **Settings** (Ctrl+,) to add your Anthropic API key or point Bubbly at Ollama.

To build a distributable Windows installer (`.exe`):

```bash
npm run setup:desktop   # one time — installs electron + electron-builder
npm run dist            # builds everything and produces desktop/release/
```

### Browser (cross-platform)

```bash
# 1. Install dependencies
npm run setup

# 2. Start backend + frontend dev servers
./start.sh        # macOS/Linux
start.bat         # Windows

# 3. Open http://localhost:3000
```

On first launch, go to **Settings** (gear icon in the sidebar) and set:
1. **Workspace path** — absolute path to the project you want the agent to work on
2. **API Key** or **Ollama URL**

## Usage

1. Type a task in the chat input
2. The agent will explore your project, explain its plan, then execute
3. For file writes and shell commands you'll see an **Approve / Deny** card
4. Watch file diffs appear live in the right panel

### Example prompts

```
Add input validation to the registration form
Write tests for the UserService class
Refactor the database layer to use connection pooling
Find all TODO comments and create a spec for them
Set up ESLint and fix all linting errors
```

## Steering Files

Create a `BUBBLY.md` in your project root to give the agent permanent instructions:

```markdown
# Project Rules

- Always use TypeScript strict mode
- Prefer functional components in React
- Run `npm test` after every change
- Never modify files in the `legacy/` directory
```

You can also create `.bubbly/steering/` files for more granular control (e.g. `coding-style.md`, `architecture.md`).

## Project Structure

```
bubbly/
├── backend/          Node.js + TypeScript backend
│   └── src/
│       ├── agent/    Agentic loop + tools
│       ├── models/   Claude & Ollama adapters
│       ├── db/       SQLite (sessions, messages, audit)
│       ├── routes/   REST API
│       └── steering/ Workspace steering loader
├── frontend/         React + TypeScript + Tailwind frontend
│   └── src/
│       ├── components/
│       │   ├── BubbleRoom/  Main layout
│       │   ├── Chat/        Chat + messages + audit
│       │   ├── FileExplorer/ File tree + Monaco editor
│       │   ├── SpecPanel/   Specs display
│       │   ├── Settings/    Configuration
│       │   └── Shared/      Diffs, tool bubbles, approvals
│       ├── hooks/    WebSocket + API + desktop bridge
│       └── store/    Zustand global state
├── desktop/          Electron desktop shell (native Windows app)
│   ├── main.js       Boots backend, manages window + native menus
│   └── preload.js    Secure bridge (folder picker, menu nav)
├── scripts/
│   ├── build-all.js  Builds backend + frontend for packaging
│   └── gen-icons.js  Generates app icons (PNG + ICO)
├── setup.sh
├── start.sh / start.bat         Browser mode
├── start-desktop.bat            Desktop app
└── README.md
```

## How the desktop app works

The Electron **main process** (`desktop/main.js`) launches the compiled Bubbly
backend as a child process on a **dynamic free port** (so it never collides with
anything already running), waits for the backend's health check, then loads the
UI the backend serves on that same origin. Because everything is same-origin,
the existing REST API and WebSocket "just work" with no CORS or proxy config.

The backend runs under the **system Node.js** (not Electron's runtime) so the
native `better-sqlite3` module keeps working without a rebuild. A single-instance
lock, graceful shutdown, and crash reporting are all handled by the shell. The
React app detects the desktop shell via `window.bubblyDesktop` and lights up
native features (OS folder picker, menu navigation) while remaining fully
functional in a plain browser.

## Data Storage

Bubbly stores its database at `~/.bubbly/bubbly.db`. Specs are stored inside your workspace at `.bubbly/specs/`.

## Development

```bash
# Run backend and frontend separately for easier debugging
cd backend && npm run dev    # Port 3001
cd frontend && npm run dev   # Port 3000
```

## Supported Ollama Models

Any model with tool-call support works best:
- `llama3.1` (recommended)
- `llama3.2`
- `mistral-nemo`
- `qwen2.5-coder`
- `deepseek-coder-v2`

Note: Not all Ollama models support tool use. If a model doesn't, the agent will still work but won't be able to call tools in a structured way.
