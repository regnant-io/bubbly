# BUBBLY - Comprehensive Context Documentation

**Generated:** 2026-07-14  
**Project Type:** Local-first AI coding agent with native Windows desktop support  
**Status:** Production-ready, actively developed

---

## 🎯 PROJECT OVERVIEW

Bubbly is a sophisticated AI coding agent system that combines:
- **Native Windows Desktop App** (Electron-based)
- **Browser-based Web Interface** (React + Vite)
- **Powerful Backend** (Node.js + TypeScript + Express)
- **Code Intelligence Engine** (structural code analysis, symbol indexing)
- **Multi-Model Support** (Claude, Gemini, Ollama)

### Core Philosophy

> "The breakthrough is NOT model size. It's **context narrowing**. The agent becomes 'smart' because it searches well, retrieves well, scopes well, edits minimally, and validates relationships."

Bubbly is designed to make even small local models (Granite, llama3.1, qwen2.5-coder) perform at enterprise-level by providing excellent tooling and structured workflows.


---

## 📁 PROJECT STRUCTURE

```
bubbly/
├── backend/              # Node.js + TypeScript + Express backend
│   ├── src/
│   │   ├── agent/       # Core agent logic + orchestration
│   │   │   ├── intelligence/  # Code intelligence engine
│   │   │   │   ├── codeIntelligence.ts  # Index builder, repo maps, symbol lookups
│   │   │   │   ├── symbols.ts           # Multi-language symbol extraction
│   │   │   │   └── validator.ts         # Deterministic syntax/type validation
│   │   │   ├── tools/                    # Agent tool implementations
│   │   │   │   ├── index.ts             # Tool definitions + execution router
│   │   │   │   ├── filesystem.ts        # File operations (read/write/edit)
│   │   │   │   ├── shell.ts             # Command execution
│   │   │   │   ├── browserControl.ts    # Playwright browser automation
│   │   │   │   ├── computerControl.ts   # PyAutoGUI desktop automation
│   │   │   │   ├── specs.ts             # Spec system CRUD
│   │   │   │   ├── git.ts               # Git operations
│   │   │   │   ├── contextGatherer.ts   # Repository analysis tool
│   │   │   │   └── backgroundProcess.ts # Long-running process management
│   │   │   ├── orchestrator.ts          # Main agent loop coordinator
│   │   │   ├── specOrchestrator.ts      # Spec-driven multi-agent execution
│   │   │   ├── taskAgent.ts             # Focused worker agent for delegated tasks
│   │   │   ├── contextManager.ts        # History compaction + token management
│   │   │   ├── contextLimits.ts         # Model-specific context window configs
│   │   │   ├── verifier.ts              # Semantic task verification
│   │   │   ├── skills.ts                # Reusable agent capabilities
│   │   │   └── parallelAgents.ts        # Parallel task execution
│   │   ├── models/                      # LLM provider adapters
│   │   │   ├── index.ts                 # Unified model interface
│   │   │   ├── claude.ts                # Anthropic Claude API
│   │   │   ├── ollama.ts                # Ollama local models
│   │   │   ├── gemini.ts                # Google Gemini API
│   │   │   ├── capabilities.ts          # Model feature detection
│   │   │   └── streamBuffer.ts          # Token streaming utilities
│   │   ├── db/                          # SQLite persistence
│   │   │   ├── index.ts                 # Database + migrations
│   │   │   └── migrations/              # Schema evolution
│   │   ├── session/                     # Session management
│   │   │   └── manager.ts               # CRUD for sessions/messages
│   │   ├── steering/                    # Project-specific instructions
│   │   │   └── loader.ts                # Load BUBBLY.md files
│   │   ├── terminal/                    # Integrated terminal
│   │   │   └── terminalManager.ts       # PTY management
│   │   ├── mcp/                         # Model Context Protocol
│   │   │   ├── manager.ts               # MCP server orchestration
│   │   │   └── client.ts                # MCP client implementation
│   │   ├── routes/                      # REST API routes
│   │   │   ├── sessions.ts              # Session endpoints
│   │   │   ├── files.ts                 # File operations
│   │   │   ├── settings.ts              # Configuration
│   │   │   └── mcp.ts                   # MCP management
│   │   ├── utils/                       # Shared utilities
│   │   │   ├── logger.ts                # Winston logging
│   │   │   ├── errorHandler.ts          # Error recovery
│   │   │   └── configParser.ts          # JSON/YAML/TOML parsing
│   │   ├── types.ts                     # TypeScript type definitions
│   │   └── index.ts                     # Express server entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/             # React + TypeScript + Tailwind UI
│   ├── src/
│   │   ├── components/
│   │   │   ├── BubbleRoom/             # Main layout + panels
│   │   │   ├── Chat/                   # Chat interface + messages
│   │   │   ├── FileExplorer/           # File tree + Monaco editor
│   │   │   ├── SpecPanel/              # Spec authoring UI
│   │   │   ├── TaskQueue/              # Task progress display
│   │   │   ├── Terminal/               # Xterm.js terminal
│   │   │   ├── Settings/               # Configuration panels
│   │   │   ├── ThreadPanel/            # Thread history
│   │   │   └── Shared/                 # Reusable components
│   │   ├── hooks/                      # React hooks
│   │   │   ├── useWebSocket.ts         # WS connection management
│   │   │   ├── useApi.ts               # REST API calls
│   │   │   ├── useDesktop.ts           # Electron bridge
│   │   │   └── useTheme.ts             # Theme system
│   │   ├── store/                      # Zustand state management
│   │   ├── utils/                      # Frontend utilities
│   │   ├── types.ts                    # TypeScript types
│   │   ├── App.tsx                     # Root component
│   │   └── main.tsx                    # React entry point
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.js
├── desktop/              # Electron desktop shell
│   ├── main.js          # Electron main process
│   ├── preload.js       # Secure IPC bridge
│   ├── assets/          # App icons
│   └── package.json
├── scripts/              # Build + utility scripts
│   ├── build-all.js     # Production build orchestrator
│   └── gen-icons.js     # Icon generation
├── README.md             # User documentation
├── ARCHITECTURE.md       # Technical deep-dive
├── run.md               # Development notes
├── package.json         # Root workspace orchestrator
├── start.sh             # Browser mode launcher (Unix)
├── start.bat            # Browser mode launcher (Windows)
└── start-desktop.bat    # Desktop app launcher (Windows)
```


---

## 🔧 TECHNOLOGY STACK

### Backend
- **Runtime:** Node.js 18+ with TypeScript 5.5
- **Framework:** Express 4.19 (REST API + static serving)
- **WebSocket:** ws 8.17 (real-time bidirectional communication)
- **Database:** better-sqlite3 11.0 (local SQLite, synchronous)
- **Process Management:** node-pty 1.1 (pseudo-terminal for integrated shell)
- **Browser Automation:** Playwright 1.48 (Bubbly Preview)
- **Desktop Automation:** PyAutoGUI (via computer_control tool)
- **Git Operations:** simple-git 3.25
- **File Operations:** Node.js fs with glob 10.4, micromatch 4.0
- **Logging:** Winston 3.19 + winston-daily-rotate-file
- **Config Parsing:** yaml 2.9, @iarna/toml 2.2, JSON (built-in)
- **Model APIs:** @anthropic-ai/sdk 0.110, custom Ollama + Gemini clients
- **Testing:** Jest 30.4 (unit + integration tests)

### Frontend
- **Framework:** React 18.3 with TypeScript
- **Build Tool:** Vite 5.3 (fast dev server + optimized builds)
- **Styling:** Tailwind CSS 3.4 (utility-first, responsive)
- **State Management:** Zustand 4.5 (lightweight, no boilerplate)
- **Code Editor:** @monaco-editor/react 4.6 (VS Code editor component)
- **Terminal:** @xterm/xterm 5.5 + addons (fit, web-links)
- **Markdown:** react-markdown 10.1 + remark-gfm + rehype-highlight
- **Syntax Highlighting:** highlight.js 11.11
- **Icons:** lucide-react 0.400 (consistent iconography)

### Desktop (Electron)
- **Shell:** Electron 31.7 (Chromium + Node.js runtime)
- **Bundler:** electron-builder 24.13 (Windows NSIS installer)
- **IPC:** Electron IPC (contextBridge + preload for security)

### Development
- **Language:** TypeScript 5.5 (strict mode, full type safety)
- **Linting:** (none configured - opportunity for improvement)
- **Testing:** Jest (backend), no frontend tests yet
- **Build:** tsc (backend), Vite (frontend), electron-builder (desktop)


---

## 🧠 CODE INTELLIGENCE ENGINE

The **breakthrough feature** that makes Bubbly exceptional. Located in `backend/src/agent/intelligence/`.

### 1. Symbol Extraction (`symbols.ts`)
Multi-language parser that extracts structural information:
- **Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby, PHP
- **Extracts:** Functions, classes, methods, interfaces, types, enums, structs
- **Metadata:** Line numbers, signatures, export status, container relationships
- **Import Graph:** Tracks file dependencies
- **Heuristic-based:** No native parsers needed (packages cleanly in desktop app)

### 2. Code Intelligence (`codeIntelligence.ts`)
Builds and maintains workspace index:

**Core Maps:**
1. **Structural Map** — Every file's symbols (functions/classes/types)
2. **Symbol Index** — Name → declarations (`find_symbol`)
3. **Reference Graph** — Symbol → usages (`find_references`)
4. **Import Graph** — File dependencies (forward + reverse edges)
5. **Centrality (PageRank)** — Which files are most important

**Key Features:**
- **Repo Map Generation:** Compressed, ranked overview of codebase
- **Incremental Updates:** mtime-based cache invalidation
- **Fuzzy Search:** Find symbols by partial name
- **Task Context Builder:** Focused context packages for delegated work
- **Token-Budgeted Output:** Fits whole projects into model context

**Performance:**
- Caches per workspace (30-second TTL)
- Only re-scans changed files
- Handles 1000s of files efficiently
- ~100-300ms for medium projects

### 3. Deterministic Validation (`validator.ts`)
Fast, grounded error checking BEFORE LLM judgment:

**Checks:**
1. **Structural:** Balanced brackets, unterminated strings (instant, all langs)
2. **TypeScript:** `tsc --noEmit` (real compiler errors)
3. **Python:** `python -m py_compile` (syntax validation)

**Benefits:**
- Concrete `file:line` errors for repair loop
- Weak models fix specific errors reliably
- No false "is this correct?" self-assessment
- Validation runs in <30 seconds (configurable)


---

## 🎨 ELEVATED SPEC SYSTEM

Transforms requirements into executable contracts. Located in `backend/src/agent/tools/specs.ts`.

### Spec Document Types

**1. Requirements → EARS Properties**
Each requirement becomes a testable acceptance property:
```
WHEN <trigger> THE SYSTEM SHALL <response>
```
- **Types:** functional, constraint, invariant, edge_case
- **Stored in:** `requirements.md` and `spec.json`
- **Verifiable:** Concrete acceptance criteria

**2. Design Document**
Architecture, components, data models, sequencing:
- Written as markdown
- Authored AFTER requirements approval
- Guides implementation

**3. Tasks (Dependency-Aware)**
Each task can declare:
- `target_files`: Files to create/modify
- `depends_on`: Prerequisites (topological order)
- `satisfiesProperties`: Which acceptance criteria it fulfills
- `acceptance`: Concrete definition of done
- `subTasks`: Ordered breakdown for complex work

### Staged Authoring Workflow

Three-phase, human-gated process:

**Phase 1: Requirements**
- Agent presents requirements as testable properties
- User reviews and approves
- Call `approve_spec_phase(spec_id, "requirements")`

**Phase 2: Design**
- Agent writes design document (architecture)
- User reviews and approves
- Call `approve_spec_phase(spec_id, "design")`

**Phase 3: Tasks**
- Agent breaks work into ordered tasks
- User reviews and approves
- Call `approve_spec_phase(spec_id, "tasks")`

**Phase 4: Ready**
- Spec is locked and executable
- Tasks executed in dependency order

### Two-Stage Verification

**1. Deterministic Validation** (validator.ts)
- Syntax/type checks first
- If fails: task → in_progress, agent gets repair brief
- No model tokens spent yet

**2. Semantic Verification** (verifier.ts)
- Judges if task intent is met
- Checks against real file contents
- Only runs if deterministic validation passes


---

## 🤖 AGENT ARCHITECTURE

### Two Thread Types

**1. Vibe Coding (Default)**
- Hands-on engineer
- Direct file edits for small changes
- Delegates large jobs via `delegate_task`
- Uses `update_plan` for progress tracking
- Fast and direct for quick work

**2. Spec Session**
- Tech lead / architect role
- NO direct file editing (tools stripped)
- Creates specs: requirements → design → tasks
- Delegates ALL implementation via workers
- Structured, human-gated workflow

### Multi-Agent Execution

**Orchestrator** (`orchestrator.ts`)
- Coordinates main agent loop
- Manages WebSocket events
- Handles approvals + questions
- Streams token deltas
- Context management
- Model API calls

**Spec Orchestrator** (`specOrchestrator.ts`)
- Owns spec execution plan
- Walks tasks in dependency order
- Dispatches Task Agents for each task
- Tracks progress phases
- Handles verification

**Task Agent** (`taskAgent.ts`)
- Focused worker for ONE task
- Receives tight context package:
  - Task contract (acceptance, target files, properties)
  - Task-focused repo map
  - Outlines of files to touch
- Bounded iteration budget
- Self-validates with deterministic validator
- One repair pass allowed
- Reports structured progress

### Tool System

**Lead Tools** (always available):
- Planning: `update_plan`, `delegate_task`, `delegate_parallel`
- Navigation: `get_repo_map`, `find_symbol`, `find_references`, `get_file_outline`
- Reading: `read_file`, `read_files`, `list_directory`, `grep_search`
- Human input: `ask_user`
- Specs: `create_spec`, `read_spec`, `update_task_status`, etc.

**Direct Work Tools** (Vibe mode only):
- `write_file`, `edit_file`, `append_file`, `delete_file`
- `run_command`, `run_background`, `get_process_output`
- `git_status`, `git_add_and_commit`, `git_diff`
- `computer_control`, `browser_control`

**Worker Tools** (Task Agents):
- Full toolset (read + write + execute)
- Context-focused (task-specific files)
- Validation included


---

## 🔗 MODEL ADAPTERS

### Claude API (`models/claude.ts`)

**Features:**
- Streaming + non-streaming modes
- Prompt caching (2 breakpoints):
  - Tools + system prompt (static prefix)
  - Last message (growing history)
- Tool-start events (UI shows "Creating file…" immediately)
- Vision support (images in tool results)
- Automatic max_tokens clamping per model family

**Supported Models:**
- claude-3-opus, claude-3-sonnet, claude-3-haiku (8192 tokens)
- claude-3-5-sonnet, claude-3-5-haiku (8192 tokens)
- claude-opus-4, claude-sonnet-4, claude-haiku-4.5 (32000-64000 tokens)

### Ollama API (`models/ollama.ts`)

**Features:**
- **Exponential Backoff Retry:** 5 attempts, 1s → 2s → 4s → 8s → 16s
- **Connection Timeout Detection:** ECONNREFUSED, ETIMEDOUT, fetch failed
- **Graceful Degradation:** Strips unsupported options on 400
  - `think` parameter (non-reasoning models)
  - Large `num_ctx` (memory-constrained hosts)
  - `num_predict: -1` (OpenAI-compatible proxies)
  - Image inputs (non-vision models)
- **Auto-sizing Context Window:** Queries model's real capacity via `/api/show`
- **Native Thinking Support:** Extracts reasoning from `message.thinking` field
- **Control Sigil Stripping:** Removes leaked template tokens
- **NDJSON Line Buffering:** Handles split tool calls (prevents truncation)
- **Retryable Error Detection:** Network errors, 5xx status codes
- **Non-Retryable 4xx:** Fails fast on bad requests

**Configurable:**
- Max attempts (default: 5)
- Initial delay (default: 1000ms)
- Backoff multiplier (default: 2)
- Per-attempt timeout (default: 300000ms / 5 minutes)

### Gemini API (`models/gemini.ts`)

**Features:**
- Google Generative AI SDK integration
- Rate limit handling (waits and retries)
- Streaming support
- Tool calling support
- Temperature control


---

## 💾 DATA PERSISTENCE

### SQLite Database (`backend/src/db/`)

**Location:** `~/.bubbly/bubbly.db`

**Tables:**
1. **sessions** - Agent sessions/threads
   - id, workspace_path, status, provider, model
   - thread_type, thread_name, parent_session_id
   - spec_id, first_message, plan (JSON)
   - session_changes (JSON array of file diffs)
   - created_at, updated_at

2. **messages** - Conversation history
   - id, session_id, role, content
   - tool_calls (JSON), sequence (ordering)
   - created_at

3. **approvals** - User approval requests
   - id, session_id, tool, args (JSON)
   - preview, status (pending/approved/rejected)
   - created_at

4. **audit_events** - Tool execution log
   - id, session_id, event_type, tool
   - args (JSON), result_summary
   - tokens_used, created_at

5. **specs** - Spec documents
   - Stored as JSON files in `.bubbly/specs/` (not in DB)

### Migrations (`db/migrations/`)
- 001: Thread management (parent_session_id, thread_name)
- 002: Message sequencing (sequence column)
- 003: Thread metadata (thread_type, first_message, plan, session_changes)

### File Storage
**Specs:** `.bubbly/specs/<spec-id>/`
- `spec.json` - Full spec data
- `requirements.md` - Human-readable requirements
- `design.md` - Architecture document
- `tasks.md` - Task list (optional)

**Logs:** `~/.bubbly/logs/` (Winston daily rotate)
- `bubbly-YYYY-MM-DD.log`
- Separate desktop logs: `~/.bubbly/desktop-logs/desktop.log`


---

## 🖥️ DESKTOP APP ARCHITECTURE

### Electron Main Process (`desktop/main.js`)

**Responsibilities:**
1. **Boot Backend** - Spawns compiled backend as child process on dynamic port
2. **Wait for Health** - Polls `/api/health` until backend ready
3. **Create Window** - Loads UI from backend's served port (same-origin)
4. **Native Menus** - File, Edit, View, Window, Help
5. **OS Integration** - Folder picker, About dialog, Open with Bubbly
6. **Process Management** - Clean shutdown (kills backend + children)
7. **Single Instance** - Prevents multiple app instances
8. **Crash Recovery** - Restarts backend on unexpected exit (max 3 attempts)

**Key Features:**
- **System Node.js:** Backend runs with system Node (not Electron's) so better-sqlite3 works
- **Dynamic Port:** PORT=0 avoids conflicts
- **Same-Origin:** No CORS/proxy needed (REST + WS "just work")
- **Graceful Shutdown:** `taskkill /t /f` on Windows kills entire process tree
- **Machine-Readable Ready Signal:** `BUBBLY_READY {"port":3001}`
- **IPC Channel:** Notifies parent via process.send() too

**Window Config:**
- 1440x900 default, 940x600 minimum
- Frameless style with overlay controls
- Transparent title bar (app's own strip acts as drag region)
- Hidden menu bar (actions via shortcuts)
- `<webview>` enabled for Bubbly Preview

### Preload Bridge (`desktop/preload.js`)

**Exposed API:** `window.bubblyDesktop`
- `isDesktop: true` - Feature detection
- `pickFolder()` - Native OS folder picker
- `getInfo()` - Platform, version, backend port
- `menuAction(action)` - Run native menu commands
- `setTitleBarOverlay(opts)` - Theme-aware controls
- `openExternal(url)` - Open URLs in browser
- `onNavigate(cb)` - Listen for menu navigation
- `onWorkspaceChanged(cb)` - Folder selection events

**Security:**
- Context isolation ON
- Node integration OFF
- Sandbox OFF (for webview)
- Only safe IPC exposed

### Build Process
1. `npm run build:all` - Compiles backend + frontend
2. `npm run icons` - Generates PNG + ICO
3. `cd desktop && npm run dist` - electron-builder
4. Output: `desktop/release/Bubbly Setup.exe` (NSIS installer)


---

## 🎨 FRONTEND ARCHITECTURE

### React + Zustand State Management (`frontend/src/store/index.ts`)

**Global State:**
- `messages` - Chat message list
- `currentSessionId` - Active thread
- `sessions` - Thread history
- `workspacePath` - Project root
- `settings` - Configuration
- `activePanel` - Current view (chat/threads/files/specs)
- `diffs` - File change list
- `agentPlan` - Current plan steps
- `specs` - Loaded spec documents

### Key Components

**BubbleRoom** (`components/BubbleRoom/`)
- Main layout container
- Activity bar (left sidebar)
- Center panel (chat/threads/files/specs)
- Right panel (diffs/preview/audit)
- Status bar (bottom)
- Title bar (desktop mode)
- Mode tabs (Vibe/Spec toggle)

**Chat Panel** (`components/Chat/`)
- Message list with streaming
- ChatInput with auto-resize
- Tool indicators (humanized labels)
- Approval cards
- Terminal output blocks
- Delegation progress
- Parallel agent lanes
- Welcome screen

**File Explorer** (`components/FileExplorer/`)
- Recursive file tree
- Monaco editor integration
- Syntax highlighting
- Read-only mode

**Spec Panel** (`components/SpecPanel/`)
- Requirements display
- Design document viewer
- Task queue with status
- Phase approval workflow

**Terminal** (`components/Terminal/`)
- XTerm.js integration
- Multiple tabs
- Input detection
- Command history
- Ctrl+C interrupt
- Ctrl+` toggle

**Settings** (`components/Settings/`)
- Model configuration
- API keys (masked)
- Workspace selection
- Approval toggles
- MCP server management
- Skills management
- Advanced options

### Hooks

**useWebSocket** - Bidirectional communication
- Connects to `ws://localhost:<port>/ws`
- Event routing to store
- Reconnection logic
- Ping/pong heartbeat

**useApi** - REST API calls
- Fetch wrappers
- Error handling
- Type-safe responses

**useDesktop** - Electron bridge
- Detects desktop mode
- Folder picker
- Menu actions
- Theme sync

**useTheme** - Light/dark/system
- Persists to localStorage
- Syncs with desktop controls
- CSS custom properties


---

## 🌐 WEBSOCKET PROTOCOL

### Client → Server Messages (`WSClientMessage`)

```typescript
{ type: 'chat', message: string, sessionId?: string, workspacePath: string, 
  threadType?: 'vibe_coding' | 'spec_session', specId?: string }
{ type: 'approve', approvalId: string }
{ type: 'reject', approvalId: string }
{ type: 'answer', questionId: string, answer: string }
{ type: 'stop', sessionId: string }
{ type: 'term_create', workspacePath: string, title?: string, cols?: number, rows?: number }
{ type: 'term_input', terminalId: string, data: string }
{ type: 'term_resize', terminalId: string, cols: number, rows: number }
{ type: 'term_kill', terminalId: string }
{ type: 'preview_result', id: string, ok: boolean, result: string, image?: string }
{ type: 'ping' }
```

### Server → Client Events (`WSServerEvent`)

**Session Events:**
- `session_created` - New session ID assigned
- `status` - Status message
- `done` - Session completed

**Streaming Events:**
- `thinking` - Reasoning content (streamed)
- `text_delta` - Answer text (streamed)
- `message` - Final complete message

**Tool Events:**
- `tool_started` - Tool execution beginning (for immediate UI feedback)
- `tool_call` - Tool invoked with arguments
- `tool_result` - Tool completed with result + optional diff

**Terminal Events:**
- `terminal_start` - Command execution started
- `terminal_output` - stdout/stderr chunk
- `terminal_end` - Command completed with exit code

**Approval Events:**
- `approval_preparing` - About to request approval
- `approval_required` - User decision needed
- `approval_timeout` - Approval expired (5 min)

**File Events:**
- `diff` - File changes detected

**Spec Events:**
- `spec_created` - New spec document
- `spec_updated` - Spec modified
- `task_dispatched` - Task assigned to worker
- `task_progress` - Task phase update
- `task_completed` - Task finished + verified

**Delegation Events:**
- `delegation_started` - Worker spawned
- `delegation_progress` - Worker phase update
- `delegation_completed` - Worker finished

**Context Events:**
- `context_compacted` - History compressed (tokens before/after)
- `context_migrated` - Moved to new session (overflow/downgrade)

**Interactive Terminal:**
- `term_created` - Terminal session ready
- `term_data` - Terminal output chunk
- `term_exit` - Terminal closed
- `term_input_required` - Waiting for keyboard input

**Misc:**
- `diagnostics` - Validation errors/warnings
- `browser_screenshot` - Bubbly Preview image
- `preview_control` - Browser action request
- `plan_updated` - Working plan changed
- `question_asked` - ask_user tool invoked
- `ollama_retry` - Retry attempt progress
- `error` - Error with recovery suggestions
- `pong` - Ping response


---

## 🛠️ TOOL CATALOG (70+ Tools)

### Navigation & Orientation
- `get_repo_map(focus?, max_files?)` - Compressed structural overview
- `find_symbol(name)` - Locate declaration by name
- `find_references(name)` - Find all usages
- `get_file_outline(path)` - File structure without full read
- `gather_context(task_description, max_files?)` - Analyze + rank relevant files
- `search_in_files(query, path?, file_pattern?)` - Text search
- `grep_search(pattern, path?, include?, exclude?)` - Regex search with context
- `find_files(query, limit?)` - Fuzzy filename search

### File Operations
- `read_file(path, start_line?, end_line?)` - Read file or slice
- `read_files(paths[], start_line?, end_line?)` - Batch read
- `write_file(path, content)` - Create/replace entire file
- `edit_file(path, old_str, new_str)` - Minimal targeted edit (preferred)
- `append_file(path, content)` - Add to end (for large files)
- `delete_file(path)` - Remove file
- `create_directory(path)` - Make directory tree
- `list_directory(path?)` - List files/folders
- `get_file_tree(path?, depth?)` - Recursive tree view

### Shell & Process
- `run_command(command, timeout_ms?, foreground?)` - One-shot execution
- `run_background(command)` - Long-running process
- `get_process_output(process_id, full?, lines?)` - Read process logs
- `send_process_input(process_id, input)` - Answer interactive prompts
- `list_processes()` - All background processes
- `stop_process(process_id)` - Kill process tree

### Git Operations
- `git_status()` - Current status
- `git_diff(staged?)` - Show changes
- `git_add_and_commit(files[], message)` - Stage + commit
- `git_log(n?)` - Recent commits

### Spec System
- `create_spec(title, type, requirements, tasks|task_details?, notes?, staged?, start_phase?)` - New spec
- `read_spec(spec_id)` - Load spec
- `list_specs()` - All specs
- `update_spec_status(spec_id, status)` - Change spec status
- `add_spec_task(spec_id, task_title)` - Add task
- `update_task_status(spec_id, task_id, status)` - Mark task progress
- `get_next_task(spec_id)` - Next todo task
- `set_spec_design(spec_id, design)` - Save design document
- `approve_spec_phase(spec_id, phase)` - User approval + advance
- `add_sub_tasks(spec_id, task_id, sub_tasks[])` - Break down task

### Agent Coordination
- `update_plan(steps[])` - Maintain working plan
- `delegate_task(instruction, target_files?, acceptance?)` - Spawn worker
- `delegate_parallel(tasks[])` - Parallel workers (2-4 independent units)
- `ask_user(question, options?)` - Pause for human input

### Configuration
- `read_config(path)` - Parse JSON/YAML/TOML
- `write_config(path, data, sort_keys?)` - Write structured config

### Validation
- `validate_changes(files[]?)` - Deterministic syntax/type checks

### Checkpoints
- `create_checkpoint(description)` - Save snapshot
- `list_checkpoints()` - All checkpoints
- `revert_to_checkpoint(checkpoint_id)` - Restore state

### Advanced
- `rename_symbol(path, line, character, old_name, new_name)` - Semantic rename
- `computer_control(action, x?, y?, ...)` - PyAutoGUI desktop automation
- `browser_control(action, params?)` - Playwright browser control


---

## 🔒 SECURITY MODEL

### Network Security
**Loopback-Only Binding:**
- Backend binds to `127.0.0.1` (localhost) by default
- NOT reachable from network/LAN
- Override with `HOST` env var (trusted containers only)

**Origin Validation:**
- CORS: Only local origins (`localhost`, `127.0.0.1`, `[::1]`)
- WebSocket: `verifyClient` rejects cross-origin upgrades
- Non-browser requests (no Origin header) allowed

### Context Isolation
**Electron Preload:**
- Context isolation: ON
- Node integration: OFF
- Sandbox: OFF (for `<webview>` support)
- Only safe IPC exposed via `contextBridge`

### Approval Flow
**Requires User Approval:**
- File writes (configurable: `requireApprovalForWrites`)
- Shell commands (configurable: `requireApprovalForShell`)
- Computer control actions (always)
- Browser control actions (always)

**Timeout:** 5 minutes, then auto-reject

### Secrets Management
- API keys masked in UI
- Stored in SQLite database (`~/.bubbly/bubbly.db`)
- Not transmitted except to respective APIs
- Never logged in plaintext

### File System
**Sandboxed to Workspace:**
- All file operations relative to workspace root
- Path traversal prevented
- Cannot escape workspace directory


---

## 🎯 CONTEXT MANAGEMENT

### The Problem
Long agent runs accumulate huge message histories that:
- Overflow model context windows
- Slow down every API call
- Eventually break the loop entirely

### The Solution (`contextManager.ts`)

**Bounded Working Memory:**
- Always keeps: Goal (first message) + recent turns (verbatim)
- Compacts middle: Truncate large tool outputs, drop redundant nudges
- Preserves pairing: `tool_use` ↔ `tool_result` (provider API validation)
- Runs every iteration but no-op until history exceeds token budget

**Configurable Budget:**
- Default: 24,000 tokens
- User adjustable in Settings
- Per-model limits in `contextLimits.ts`

**Token Estimation:**
- ~4 chars per token (rough heuristic)
- Counts system prompt + all messages
- Efficient (doesn't call tokenizer APIs)

### Context Migration (`contextMigration.ts`)

**Auto-Migration When:**
1. History exceeds threshold (default 85% of limit)
2. Model downgrade detected (smaller context window)

**Process:**
1. Creates new session with same workspace/model
2. Summarizes old session history
3. Injects summary as first message in new session
4. Links sessions (parent_session_id)
5. Notifies UI with migration reason

**User Control:**
- Enable/disable: `autoContextMigration` setting
- Threshold: `contextMigrationThreshold` (0-1)

### Compaction Strategy

**What Gets Compressed:**
- Tool results over 1000 chars → truncated to 500 + "…"
- Repeated status messages → deduplicated
- Empty thinking blocks → removed
- Redundant validations → kept only if errors

**What Stays Full:**
- User messages (always)
- Most recent 3 turns (always)
- Tool calls with arguments (always)
- Error messages (always)


---

## 🎨 BUBBLY PREVIEW (Integrated Browser)

### Architecture
**Playwright Integration:** Live browser in right panel
- Runs in backend (`browserControl.ts`)
- Streams screenshots to frontend
- Executes actions via `browser_control` tool

### Features

**Actions:**
- `open(url)` - Navigate to URL
- `click(selector)` - Click element
- `type(selector, text)` - Type into input
- `scroll(direction, amount)` - Scroll page
- `reload()` - Refresh page
- `back()` - Go back
- `forward()` - Go forward
- `screenshot()` - Capture frame
- `evaluate(script)` - Run JavaScript
- `wait(selector)` - Wait for element

**Vision Integration:**
- Screenshots returned as base64 images
- Attached to tool results
- Vision models (Claude) can SEE rendered output
- Agent analyzes actual UI, not just code

**Use Cases:**
- Verify UI changes live
- Test responsive design
- Debug rendering issues
- Validate user flows
- Check cross-browser behavior

**User Control:**
- Enable/disable: `browserControlEnabled` setting
- Approval required for each action
- Manual reload button in UI


---

## 🖱️ COMPUTER CONTROL (Desktop Automation)

### Architecture
**PyAutoGUI Integration:** Real mouse/keyboard control
- Requires Python + PyAutoGUI installed
- Runs via `computerControl.ts`
- **DISABLED by default** (security)

### Features

**Actions:**
- `screenshot()` - Capture full screen
- `screen_size()` - Get resolution
- `move(x, y)` - Move mouse
- `click(x, y)` - Click position
- `double_click(x, y)` - Double-click
- `right_click(x, y)` - Right-click
- `drag(x, y, toX, toY)` - Drag mouse
- `type(text)` - Type text
- `key(key_name)` - Press key (enter, tab, etc.)
- `scroll(direction, amount)` - Scroll wheel

**Coordinates:**
- Absolute screen pixels
- (0, 0) = top-left corner
- Get from screenshots

**Use Cases:**
- Automate desktop apps (no API)
- Test native UI
- Fill forms in legacy software
- Click through installers
- Scrape desktop applications

**Safety:**
- User approval REQUIRED for every action
- Only screenshot() auto-approved
- Enable in Settings: `computerControlEnabled`


---

## 📋 INTEGRATED TERMINAL

### Architecture
**Pipe-Based PTY:** Real shell sessions without native dependencies
- Windows: PowerShell (powershell.exe)
- Unix: sh/bash
- Multiple tabs supported
- Input/output streaming via WebSocket

### Features

**Interactive:**
- Full terminal emulation (xterm.js)
- Command history
- ANSI color support
- Ctrl+C interrupt
- Ctrl+\` toggle visibility
- Resize support

**Input Detection:**
- Recognizes when shell is waiting for input
- Prompts: "(y/N)?", "Press any key", "Password:"
- Suggests replies
- Agent can respond via `send_process_input`

**Sessions:**
- Each terminal = separate shell session
- Bound to workspace directory
- Persistent until closed
- Survives reconnects

**Agent Integration:**
- `run_command` uses terminal for streaming output
- Background processes logged to terminal
- Real-time output display

### Management (`terminalManager.ts`)

**Session Tracking:**
- terminalId → session map
- Output buffering (scrollback)
- Exit code capture

**Events:**
- `term_created` - Session started
- `term_data` - Output chunk
- `term_exit` - Process ended
- `term_input_required` - Waiting for input


---

## 🔌 MODEL CONTEXT PROTOCOL (MCP)

### Integration (`backend/src/mcp/`)

**MCP Manager** (`manager.ts`):
- Connects to configured MCP servers
- Spawns server processes (stdio transport)
- Maintains tool registry
- Handles reconnection
- Graceful shutdown

**Configuration:**
- User-level: `~/.kiro/settings/mcp.json`
- Workspace-level: `.kiro/settings/mcp.json`
- Merged with precedence (workspace overrides user)

**Server Format:**
```json
{
  "mcpServers": {
    "server-name": {
      "command": "uvx",
      "args": ["package-name@latest"],
      "env": { "KEY": "value" },
      "disabled": false,
      "autoApprove": ["tool_name_1", "tool_name_2"]
    }
  }
}
```

### Features

**Tool Integration:**
- MCP tools exposed to agent
- Same approval flow as built-in tools
- Auto-approve whitelist per server
- Tools grouped by server in UI

**Server Management:**
- Auto-reconnect on config change
- Manual reconnect via UI
- Status monitoring
- Error recovery

**Common Servers:**
- `aws-docs` - AWS documentation
- `filesystem` - Enhanced file operations
- `git` - Advanced git operations
- `web-search` - Internet search
- Custom servers via stdio


---

## 📚 STEERING FILES

### Purpose
Project-specific instructions that persist across sessions.

### Locations

**1. Root README:**
- `README.md` in workspace
- Auto-loaded into system prompt
- Contains project overview

**2. BUBBLY.md:**
- Workspace root
- Standing instructions for agent
- Coding standards, conventions, constraints

**3. .bubbly/steering/:**
- Multiple steering files
- Organized by topic
- Always included by default
- Can reference other files via `#[[file:path]]`

### Loader (`steering/loader.ts`)

**Functions:**
- `loadSteeringContext(workspace)` - Load all steering
- `loadReadme(workspace)` - Load README.md
- `detectProjectType(workspace)` - Infer language/framework

**Example Steering:**
```markdown
# Project Rules

- Always use TypeScript strict mode
- Prefer functional components in React
- Run `npm test` after every change
- Never modify files in the `legacy/` directory
- Use 2-space indentation
- Import React as `import React from 'react'`
```

### File References
Include external docs/specs:
```markdown
See the API spec: #[[file:docs/api.yaml]]
GraphQL schema: #[[file:schema.graphql]]
```


---

## 🎨 SKILLS SYSTEM

### Purpose
Reusable agent capabilities (Claude-style).

### Architecture (`agent/skills.ts`)

**Skill Definition:**
```json
{
  "name": "skill-name",
  "description": "What this skill does",
  "keywords": ["keyword1", "keyword2"],
  "always_active": false,
  "content": "Markdown instructions..."
}
```

**Locations:**
- User-level: `~/.kiro/skills/`
- Workspace-level: `.kiro/skills/`

**Activation:**
- **Always-on:** `always_active: true`
- **Keyword-matched:** User message contains keywords
- **Manual:** User explicitly references

**Integration:**
- Injected into system prompt
- Scoped per request
- Minimal overhead when not active

### Example Skills

**Testing Skill:**
```markdown
When writing tests:
- Use Jest for unit tests
- Use React Testing Library for components
- Mock external dependencies
- Test edge cases
- Aim for 80%+ coverage
```

**API Design Skill:**
```markdown
When designing APIs:
- Use RESTful conventions
- Return consistent error formats
- Include pagination for lists
- Version endpoints (/api/v1)
- Document with OpenAPI
```


---

## 🚀 RUNNING BUBBLY

### Development Mode

**Browser (Cross-Platform):**
```bash
# Install dependencies
npm run setup

# Start backend + frontend dev servers
./start.sh        # macOS/Linux
start.bat         # Windows

# Open http://localhost:3000
```

**Desktop (Windows):**
```bat
# First time: install desktop dependencies
npm run setup:desktop

# Start desktop app
start-desktop.bat
```

### Production Build

**Browser:**
```bash
npm run build              # Build backend + frontend
npm run start:prod         # Run production server
```

**Desktop:**
```bash
npm run build:all          # Build everything
npm run icons              # Generate app icons
npm run dist               # Create installer
# Output: desktop/release/Bubbly Setup.exe
```

### Environment Variables

**Backend (.env):**
```bash
PORT=3001                      # Server port (0 = dynamic)
NODE_ENV=development           # Environment
ANTHROPIC_API_KEY=             # Claude API key
GEMINI_API_KEY=                # Gemini API key
OLLAMA_BASE_URL=http://localhost:11434
BUBBLY_FRONTEND_DIST=          # Override frontend path
BUBBLY_LOG_DIR=                # Override log directory
BUBBLY_ELECTRON=1              # Set by desktop shell
HOST=127.0.0.1                 # Bind address
```

### System Requirements

**Required:**
- Node.js 18+ (LTS recommended)
- npm 8+
- 2GB RAM minimum
- Windows 10+ / macOS 10.15+ / Linux (Ubuntu 20.04+)

**Optional:**
- Python 3.8+ (for computer control via PyAutoGUI)
- Git (for git operations)
- TypeScript compiler (for validation)


---

## ⚙️ CONFIGURATION

### Settings Schema

**Model Configuration:**
- `defaultProvider`: 'claude' | 'ollama' | 'gemini'
- `claudeModel`: e.g., 'claude-3-5-sonnet-20241022'
- `geminiModel`: e.g., 'gemini-2.0-flash-exp'
- `ollamaModel`: e.g., 'llama3.1', 'qwen2.5-coder'
- `anthropicApiKey`: Masked in UI
- `geminiApiKey`: Masked in UI
- `ollamaBaseUrl`: Default 'http://localhost:11434'

**Workspace:**
- `workspacePath`: Absolute path to project

**Approvals:**
- `requireApprovalForWrites`: 'true' | 'false'
- `requireApprovalForShell`: 'true' | 'false'

**Ollama Advanced:**
- `ollamaEnableThinking`: 'true' | 'false' (reasoning models)
- `ollamaRetryMaxAttempts`: Default '5'
- `ollamaRetryInitialDelayMs`: Default '1000'
- `ollamaRetryBackoffMultiplier`: Default '2'
- `ollamaNumCtx`: Default '16384' (context window)
- `ollamaAutoNumCtx`: 'true' | 'false' (auto-size to model max)
- `ollamaNumCtxCeiling`: Default '32768' (safety ceiling)
- `ollamaRequestTimeoutMs`: Default '300000' (5 minutes per attempt)

**Context Management:**
- `contextTokenBudget`: Default '24000'
- `autoContextMigration`: 'true' | 'false'
- `contextMigrationThreshold`: Default '0.85' (85%)

**Validation:**
- `autoValidate`: 'true' | 'false' (deterministic checks)

**Spec Mode:**
- `multiAgentSpec`: 'true' | 'false' (worker agents)
- `maxTaskIterations`: Default '10' (task agent budget)
- `specDocsAsMarkdown`: 'true' | 'false' (save as .md files)

**Vibe Mode:**
- `vibeWorkerThreshold`: Default '4' (when to delegate vs do directly)

**UI:**
- `theme`: 'light' | 'dark' | 'system'
- `editorFontSize`: Default '14'
- `terminalFontSize`: Default '14'
- `streamingSpeed`: 'instant' | 'smooth'
- `revealRightPanelOnDiff`: 'true' | 'false'
- `tabSize`: Default '2'
- `wordWrap`: 'on' | 'off'
- `formatOnSave`: 'true' | 'false'
- `autoSave`: 'true' | 'false'

**Advanced:**
- `computerControlEnabled`: 'false' (DISABLED by default)
- `browserControlEnabled`: 'true'
- `mcpServers`: JSON string
- `skills`: JSON string


---

## 🧪 TESTING

### Backend Tests (`backend/src/**/*.test.ts`)

**Test Framework:** Jest 30.4 with ts-jest

**Coverage Areas:**
- **Agent Logic:** orchestrator, contextManager, contextMigration
- **Code Intelligence:** symbols, codeIntelligence, validator
- **Tools:** filesystem, shell, git, specs, computerControl, browserControl
- **Models:** ollama retry logic, stream buffering
- **Session Management:** manager, threadLoading
- **Database:** migrations
- **Utilities:** configParser, errorHandler, fileVerifier, settingsValidator

**Test Types:**
- Unit tests (*.test.ts)
- Integration tests (*.integration.test.ts)
- Manual tests (*.manual-test.ts)

**Running Tests:**
```bash
cd backend
npm test                  # All tests
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report
```

### Frontend Tests
**Status:** No test suite yet (opportunity for contribution)

**Suggested Framework:**
- Vitest (Vite-native)
- React Testing Library
- Mock Service Worker (API mocking)

### Desktop Tests
**Status:** No automated tests (manual testing only)

### Test Files Breakdown

**Agent Tests:**
- `orchestrator.integration.test.ts` - Full agent loop
- `orchestrator.approvalLoading.test.ts` - Approval flow
- `orchestrator.errorRecovery.test.ts` - Error handling
- `orchestrator.retryConfig.test.ts` - Retry behavior
- `contextManager.test.ts` - History compaction
- `contextMigration.test.ts` - Session migration
- `parallelAgents.test.ts` - Parallel execution

**Intelligence Tests:**
- `symbols.test.ts` - Symbol extraction
- `codeIntelligence.test.ts` - Index building
- `validator.test.ts` - Validation engine
- `validatorRegex.test.ts` - Regex patterns

**Tool Tests:**
- `filesystem.integration.test.ts` - File operations
- `shell.test.ts` - Command execution
- `git.test.ts` - Git operations
- `specs.test.ts` - Spec CRUD
- `computerControl.test.ts` - Desktop automation
- `browserControl.test.ts` - Browser control


---

## 🐛 ERROR HANDLING & LOGGING

### Winston Logging (`utils/logger.ts`)

**Levels:**
- error (0)
- warn (1)
- info (2)
- http (3)
- verbose (4)
- debug (5)
- silly (6)

**Transports:**
- Console (colorized, pretty-printed)
- Daily rotate file (`~/.bubbly/logs/bubbly-YYYY-MM-DD.log`)
- Separate desktop logs (`~/.bubbly/desktop-logs/desktop.log`)

**Log Fields:**
- timestamp (ISO 8601)
- level
- message
- metadata (structured JSON)
- component (logger.child({ component: 'name' }))

**Usage Pattern:**
```typescript
logger.info('Operation started', { 
  sessionId, 
  workspacePath,
  fileCount: 42 
});

logger.error('Operation failed', {
  error: err.message,
  stack: err.stack
});
```

### Error Recovery (`utils/errorHandler.ts`)

**Recoverable Errors:**
- Network timeouts → retry
- Missing workspace → prompt user
- Invalid config → show suggestions
- Model API errors → retry with backoff

**Non-Recoverable:**
- Missing API keys → stop with instructions
- Invalid model name → fail fast
- File permission denied → surface immediately

**Error Event Format:**
```typescript
{
  type: 'error',
  message: 'Human-readable description',
  recoverable: boolean,
  suggestions: string[]  // What user can do
}
```

### Global Error Handlers

**Backend (index.ts):**
- `process.on('uncaughtException')` - Log + continue
- `process.on('unhandledRejection')` - Log + continue
- Express error middleware - 500 response

**Desktop (main.js):**
- `process.on('uncaughtException')` - Log + continue
- `process.on('unhandledRejection')` - Log + continue
- `window.on('unresponsive')` - Log + wait for recovery
- `webContents.on('render-process-gone')` - Reload window

**Frontend (ErrorBoundary.tsx):**
- React error boundary
- Catches rendering errors
- Shows fallback UI
- Logs to console


---

## 📊 PERFORMANCE CHARACTERISTICS

### Code Intelligence Indexing
- **Initial Build:** 100-500ms for medium projects (100-500 files)
- **Incremental Update:** <50ms (only changed files)
- **Cache TTL:** 30 seconds
- **Memory:** ~5-20MB per indexed workspace
- **Disk:** No persistent cache (rebuild on restart)

### Model API Latency
**Claude:**
- First token: 200-800ms
- Subsequent tokens: 20-50ms
- Prompt caching: ~90% input cost reduction after first call
- Streaming: Real-time (<100ms delay)

**Ollama (Local):**
- First token: 1-10 seconds (depends on hardware)
- Subsequent tokens: 50-200ms
- No network latency
- Retry backoff: 1s → 2s → 4s → 8s → 16s

**Gemini:**
- First token: 300-1000ms
- Subsequent tokens: 30-60ms
- Rate limit handling: Auto-waits

### Database Operations
**SQLite (better-sqlite3):**
- Session CRUD: <5ms
- Message save: <10ms
- Message load: <20ms (100 messages)
- Synchronous (no async overhead)

### WebSocket
- Message latency: <5ms (localhost)
- Event coalescing: 16ms (animation frame)
- Reconnection: Automatic, exponential backoff

### File Operations
- Read file: <10ms (small), <100ms (large)
- Write file: <20ms
- Directory scan: <50ms (100 files), <500ms (1000 files)
- Diff generation: <30ms per file


---

## 🔮 DESIGN PHILOSOPHY & KEY INSIGHTS

### Core Principles

**1. Structure Over Text**
- Code is parsed as AST/symbols, not raw text
- Navigation by declarations/references, not grep
- Compressed repo maps > reading whole files

**2. Context Narrowing**
- Agent isn't "smart" because of model size
- Agent is smart because it searches/retrieves/scopes well
- Weak models + good tooling > strong models + bad tooling

**3. Deterministic Validation First**
- Concrete errors (file:line) > vague "is this correct?"
- Syntax checks before semantic checks
- Real compiler output > LLM judgment

**4. Executable Contracts**
- Requirements → testable EARS properties
- Tasks → target files + acceptance criteria
- Dependencies → topological execution order

**5. Human-in-the-Loop**
- Approvals for writes/shell (safety)
- Staged spec workflow (requirements → design → tasks)
- Questions only when genuinely blocked

**6. Multi-Agent by Design**
- Lead plans, workers execute
- Parallel tasks for independent work
- Focused context per agent
- Bounded iteration budgets

### Why It Works

**Small Models Succeed Because:**
1. Repo map gives structural overview (no reading 1000s of files)
2. Symbol lookups jump to exact declarations
3. Reference tracking shows blast radius
4. Deterministic validation catches syntax errors instantly
5. Task agents get tight, focused context packages
6. Verification loop catches semantic mistakes

**Desktop Integration Because:**
1. Users want native apps, not browser tabs
2. File picker is native OS dialog
3. Menu shortcuts work (Ctrl+O, Ctrl+,)
4. Runs offline (backend is localhost)
5. Single-click launch (no terminal juggling)

**Spec System Because:**
1. Complex features need planning before coding
2. Human approval gates prevent wasted work
3. Dependency-aware tasks scale better
4. Testable properties > vague requirements
5. Workers stay focused on one thing


---

## 🚧 KNOWN LIMITATIONS & FUTURE WORK

### Current Limitations

**Code Intelligence:**
- Heuristic parsing (not full AST)
- No cross-file type inference
- Limited to 11 languages
- No incremental persistence (rebuilds on restart)

**Model Support:**
- No OpenAI GPT models yet
- No local vision models
- Ollama thinking only on supported models

**Testing:**
- No frontend test suite
- No desktop app tests
- Coverage varies by component

**Platform:**
- Desktop app Windows-only (macOS/Linux in progress)
- Computer control requires Python + PyAutoGUI
- PTY terminal Windows-specific (PowerShell)

**Scalability:**
- Single user only (no multi-user)
- No distributed execution
- No cloud deployment
- Limited to single workspace at a time

### Roadmap Ideas

**Near-Term:**
- macOS + Linux desktop support
- Frontend test suite (Vitest)
- OpenAI GPT integration
- Better error messages
- Performance profiling

**Mid-Term:**
- Language server protocol (LSP) integration
- Full AST parsing (tree-sitter)
- Persistent code intelligence cache
- More MCP servers
- Plugin system

**Long-Term:**
- Multi-user collaboration
- Cloud deployment option
- Mobile app (iOS/Android)
- Voice input/output
- Code review workflows
- Team analytics


---

## 🔍 DEEP DIVE: AGENT ORCHESTRATION FLOW

### Main Agent Loop (`orchestrator.ts`)

**Entry Point:** `runAgentLoop(params)`

**Initialization Phase:**
1. Validate configuration (API keys, workspace)
2. Create or resume session
3. Load settings from database
4. Detect project type
5. Build system prompt (with steering)
6. Load skills (keyword-matched + always-on)
7. Connect MCP servers (best-effort)
8. Build initial repo map (focused on user request)
9. Set up abort controller (Stop button)

**Iteration Loop:**
```
while (!stopped && !doneReason):
  1. Compact history if needed (token budget)
  2. Check for context migration (threshold)
  3. Call model API (with retry + streaming)
  4. Process response:
     - Text: Stream to UI
     - Thinking: Stream separately
     - Tool calls: Execute each
  5. Handle approvals (pause + wait)
  6. Execute tools:
     - Validation
     - Execution
     - Result formatting
     - Diff generation
  7. Append tool results to history
  8. Check stop reason
  9. Loop or exit
```

**Tool Execution Pipeline:**
```
tool_call → approval? → execute → validate? → format → attach_to_history
```

**Stop Conditions:**
- `stop_reason === 'end_turn'` (model decided to finish)
- `stop_reason === 'max_tokens'` (output limit)
- User clicked Stop button
- Error (non-recoverable)
- All spec tasks done (spec mode)

**Event Streaming:**
Every significant event emitted via WebSocket:
- Status updates
- Token deltas
- Tool calls/results
- Approvals
- Errors
- Plan updates
- Context operations


---

## 🎭 DEEP DIVE: SPEC ORCHESTRATION

### Spec Session Lifecycle (`specOrchestrator.ts`)

**Phase 1: Spec Creation**
```
User request → Agent analyzes → create_spec(staged:true)
→ Requirements authored → User approves → approve_spec_phase("requirements")
→ Design authored (written in chat) → User approves → approve_spec_phase("design")
→ Tasks added (add_spec_task) → User approves → approve_spec_phase("tasks")
→ Spec status: ready
```

**Phase 2: Execution**
```
runSpecToCompletion(spec_id):
  while (hasIncompleteTasks):
    1. Get next task (dependency-aware)
    2. Check prerequisites (depends_on all done?)
    3. Build task context:
       - Task-focused repo map
       - Outlines of target files
       - Related properties
       - Acceptance criteria
    4. Dispatch Task Agent:
       - Spawn focused worker
       - Bounded iteration budget
       - Self-validates
       - One repair pass
    5. Wait for completion
    6. Run semantic verifier
    7. Mark task done or failed
    8. Update UI (task progress)
  
  emit 'spec_completed'
```

**Task Agent Lifecycle:**
```
PHASES:
dispatched → gathering_context → working → validating → [repairing?] → verifying → done

CONTEXT PACKAGE:
{
  instruction: "Clear description of work",
  target_files: ["file1.ts", "file2.ts"],
  acceptance: "Concrete definition of done",
  repo_map: "Task-focused structural overview",
  file_outlines: [{ path, outline }],
  properties: [{ statement, acceptance }]
}

ITERATION BUDGET:
Max 10 iterations (configurable)
Each iteration: model call → tools → validate → loop or exit

VALIDATION:
1. Deterministic (syntax/type) - if fails → repairing phase
2. Semantic (intent met?) - if fails → report to orchestrator

SUCCESS CRITERIA:
✓ All target files modified/created
✓ Deterministic validation passed
✓ Semantic verification passed
✓ Acceptance criteria met
```


---

## 🔧 DEEP DIVE: TOOL SYSTEM ARCHITECTURE

### Tool Definition Structure

```typescript
interface ToolDefinition {
  name: string;                    // Unique identifier
  description: string;             // What it does (for model)
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
```

### Tool Execution Flow

**1. Tool Call Received:**
```typescript
{
  id: "call_abc123",
  name: "write_file",
  args: { path: "src/app.ts", content: "..." }
}
```

**2. Approval Check:**
```typescript
checkRequiresApproval(toolName, args, settings):
  if (toolName in WRITE_TOOLS && requireApprovalForWrites):
    return true
  if (toolName in SHELL_TOOLS && requireApprovalForShell):
    return true
  if (toolName in ['computer_control', 'browser_control']):
    return true (always)
  return false
```

**3. Approval Flow (if needed):**
```typescript
requestApproval(sessionId, toolName, args, preview?):
  1. Generate approvalId (uuid)
  2. Emit 'approval_preparing' event
  3. Emit 'approval_required' event
  4. Store in DB (status: pending)
  5. Create Promise + resolver
  6. Set 5-minute timeout
  7. Wait for user decision
  8. Update DB (approved/rejected)
  9. Return boolean
```

**4. Tool Execution:**
```typescript
executeTool(toolName, args, workspacePath):
  switch (toolName):
    case 'write_file': return writeFile(...)
    case 'read_file': return readFile(...)
    case 'run_command': return runShell(...)
    // ... 70+ tools
    
  // Returns: { result: string, diff?: FileDiff[] }
```

**5. Result Formatting:**
```typescript
formatToolResult(toolName, result, diff):
  - Humanize action: "Created src/app.ts"
  - Include diff if file changed
  - Truncate long outputs (>5000 chars)
  - Add context hints
```

**6. Attach to History:**
```typescript
messages.push({
  role: 'assistant',
  content: [
    { type: 'tool_use', id, name, input: args },
  ]
});

messages.push({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: id, content: result },
  ]
});
```

### Tool Categories

**Read-Only (No Approval):**
- get_repo_map, find_symbol, find_references
- read_file, read_files, list_directory
- search_in_files, grep_search, find_files
- get_file_outline, gather_context
- read_config, read_spec, list_specs

**Write (Approval Optional):**
- write_file, edit_file, append_file, delete_file
- create_directory, write_config

**Execute (Approval Optional):**
- run_command, run_background
- git_add_and_commit

**Always Require Approval:**
- computer_control (desktop automation)
- browser_control (web automation)

**Meta (No Approval):**
- update_plan, delegate_task, ask_user
- validate_changes


---

## 📝 DEEP DIVE: FILE EDITING STRATEGIES

### write_file (Full Replacement)
**Use When:**
- Creating NEW files
- File is small (<100 lines)
- Complete rewrite needed

**Process:**
```typescript
1. Resolve absolute path (workspace + relative)
2. Validate path (no escaping workspace)
3. Create parent directories if needed
4. Write content atomically
5. Generate unified diff
6. Return { result, diff }
```

**Limitations:**
- For large files, splits into write + append chunks
- Can be slow for huge files
- Loses undo history

### edit_file (Targeted Edit)
**Use When:**
- Modifying EXISTING files
- Making minimal changes
- Preserving surrounding code

**Process:**
```typescript
1. Read current file content
2. Find old_str (must be unique + exact match)
3. Replace with new_str
4. Write back to file
5. Generate diff
6. Return { result, diff }
```

**Requirements:**
- old_str must match EXACTLY (whitespace included)
- Must be UNIQUE in file
- Include 2-3 lines context for uniqueness

**Why Preferred:**
- Minimal token usage
- Preserves formatting
- Clear intent
- Easier to review

### append_file (Incremental Build)
**Use When:**
- Building large files incrementally
- Avoiding truncation
- Adding to existing content

**Process:**
```typescript
1. Open file in append mode
2. Add content to end
3. Generate diff (show addition)
4. Return { result, diff }
```

**Use Case:**
```typescript
// Building a 2000-line file:
write_file("large.ts", firstPart)      // Lines 1-500
append_file("large.ts", secondPart)    // Lines 501-1000
append_file("large.ts", thirdPart)     // Lines 1001-1500
append_file("large.ts", finalPart)     // Lines 1501-2000
```

### Best Practices

**Small Changes:**
```typescript
// ❌ BAD - Rewrites entire file
write_file("app.ts", entireFileWithOneLineChanged)

// ✅ GOOD - Targets specific change
edit_file("app.ts", 
  "const port = 3000;",
  "const port = 3001;"
)
```

**New Files:**
```typescript
// ✅ GOOD - Direct creation
write_file("new-component.tsx", fullContent)
```

**Large Files:**
```typescript
// ✅ GOOD - Incremental
write_file("config.json", firstPart)
append_file("config.json", middlePart)
append_file("config.json", lastPart)
```


---

## 🔄 DEEP DIVE: PARALLEL EXECUTION

### delegate_parallel Architecture

**Purpose:** Run 2-4 independent tasks simultaneously

**Requirements:**
1. Tasks must be INDEPENDENT
2. Each must declare `target_files`
3. NO overlapping files between tasks
4. Completely separate work units

**Process:**
```typescript
delegate_parallel({ tasks: [
  {
    instruction: "Build user profile component",
    target_files: ["src/components/UserProfile.tsx"],
    acceptance: "Component renders user data"
  },
  {
    instruction: "Build settings panel",
    target_files: ["src/components/Settings.tsx"],
    acceptance: "Panel shows all settings"
  },
  {
    instruction: "Build navigation menu",
    target_files: ["src/components/Nav.tsx"],
    acceptance: "Menu links to all pages"
  }
]});

EXECUTION:
1. Validate: all tasks have target_files, no overlaps
2. Spawn N Task Agents (one per task)
3. Run in parallel (Promise.all)
4. Each agent:
   - Gets focused context
   - Works independently
   - Validates separately
   - Reports back
5. Combine results
6. Return unified report
```

**Benefits:**
- 3x-4x faster for independent work
- Maximizes CPU/API utilization
- Scales to available resources

**Limitations:**
- Max 4 tasks (API rate limits + readability)
- Must be truly independent
- File conflicts cause corruption
- Harder to debug failures

### Lane System (UI)

**Parallel Execution Display:**
```
┌─────────────────────────────────────────┐
│ PARALLEL TASKS (3 active)              │
├─────────────────────────────────────────┤
│ Lane 1: UserProfile.tsx                 │
│ ├─ Phase: working                       │
│ ├─ Tool: write_file                     │
│ └─ Activity: Creating component...      │
├─────────────────────────────────────────┤
│ Lane 2: Settings.tsx                    │
│ ├─ Phase: validating                    │
│ ├─ Tool: validate_changes               │
│ └─ Activity: Running tsc...             │
├─────────────────────────────────────────┤
│ Lane 3: Nav.tsx                         │
│ ├─ Phase: done ✓                        │
│ └─ Files: src/components/Nav.tsx        │
└─────────────────────────────────────────┘
```

**Event Routing:**
```typescript
// Server emits with lane info
{ type: 'tool_call', lane: 'lane-1', laneIndex: 0, ... }
{ type: 'delegation_progress', lane: 'lane-2', laneIndex: 1, ... }

// Frontend groups by batchId
{
  type: 'parallel_group',
  batchId: 'batch-abc',
  lanes: [
    { lane: 'lane-1', instruction: "...", phase: 'working' },
    { lane: 'lane-2', instruction: "...", phase: 'done' },
  ]
}
```


---

## 💡 TROUBLESHOOTING GUIDE

### Backend Won't Start

**Symptom:** `start.bat` / `start.sh` fails

**Common Causes:**
1. **Port in use:** Another process on 3001
   - Fix: `PORT=3002 npm start` or kill process
2. **Dependencies missing:** `node_modules` empty
   - Fix: `npm run setup`
3. **TypeScript errors:** Build failed
   - Fix: `cd backend && npm run build`
4. **Node version:** <18
   - Fix: Install Node 18+ from nodejs.org

**Check Logs:**
```bash
cat ~/.bubbly/logs/bubbly-$(date +%Y-%m-%d).log
```

### Desktop App Won't Launch

**Symptom:** `start-desktop.bat` fails or crashes

**Common Causes:**
1. **Backend not built:** `backend/dist/` empty
   - Fix: `npm run build:all`
2. **System Node not found:** `where node` fails
   - Fix: Install Node, ensure on PATH
   - Override: `set BUBBLY_NODE_PATH=C:\...\node.exe`
3. **better-sqlite3 mismatch:** Wrong Node ABI
   - Fix: `cd backend && npm rebuild better-sqlite3`
4. **Port conflict:** 3001 occupied
   - Fix: Desktop uses PORT=0 (dynamic), should auto-resolve

**Check Logs:**
```bash
cat ~/.bubbly/desktop-logs/desktop.log
```

### Agent Stops Responding

**Symptom:** Chat input frozen, no events

**Common Causes:**
1. **WebSocket disconnected:** Network glitch
   - Fix: Refresh page (session resumes)
2. **Backend crashed:** Process died
   - Check: `ps aux | grep node` (Unix) or Task Manager (Windows)
   - Fix: Restart backend
3. **Context overflow:** History too large
   - Enable auto-migration in Settings
4. **Model API timeout:** Ollama down, network issue
   - Check Ollama: `curl http://localhost:11434/api/tags`
   - Check network: API key valid?

### File Truncation Issues

**Symptom:** Large files cut off mid-generation

**Cause:** Context window too small

**Solutions:**
1. **Ollama:** Enable auto-sizing
   - Settings → `ollamaAutoNumCtx: true`
   - Raises `num_ctx` to model's max
2. **Claude:** Increase `maxTokens`
   - Default 32000 should be sufficient
3. **Use append_file:**
   - Break large files into chunks
   - `write_file` + multiple `append_file`

### Validation Always Fails

**Symptom:** Task stuck in repair loop

**Common Causes:**
1. **TypeScript not installed:** `tsc` not found
   - Fix: `npm install -g typescript`
2. **Wrong tsconfig.json:** Strict errors
   - Check project's TypeScript config
3. **Python not found:** `python` command fails
   - Fix: Install Python 3.8+
4. **False positive:** Structural check wrong
   - Disable: Settings → `autoValidate: false`

### Approval Cards Don't Appear

**Symptom:** Agent waits indefinitely

**Causes:**
1. **Approval settings off:** Both toggles disabled
   - Check: Settings → Approval toggles
2. **WebSocket event lost:** Network glitch
   - Refresh page
3. **Timeout expired:** 5 minutes passed
   - Restart operation

### Desktop App Crashes on Windows

**Symptom:** Window closes unexpectedly

**Common Causes:**
1. **GPU driver issue:** Electron GPU process crash
   - Check logs for "child-process-gone"
   - Usually recovers automatically
2. **Backend process tree leak:** Orphaned processes
   - Fix: `taskkill /f /im node.exe` (nuclear option)
3. **Out of memory:** Large project + many tabs
   - Close unused apps
   - Increase system RAM


---

## 🎓 USAGE PATTERNS & BEST PRACTICES

### For Users

**Starting a New Project:**
1. Open folder with Ctrl+O (desktop) or set in Settings
2. Let agent analyze with `get_repo_map`
3. Create steering file: `BUBBLY.md` with project rules
4. For complex features: Start Spec Session

**Quick Fixes (Vibe Mode):**
```
"Fix the typo in UserProfile.tsx on line 42"
"Add error handling to the login function"
"Update the README with new installation steps"
```
→ Agent does it directly (fast)

**Large Features (Spec Mode):**
```
"Build a user authentication system with JWT"
→ Create spec
→ Requirements → Approve
→ Design → Approve
→ Tasks → Approve
→ Execute (agent delegates each task)
```

**Iterative Development:**
```
1. "Create basic user profile page"
2. "Add avatar upload"
3. "Add bio editing"
4. "Add social links"
```
→ Build incrementally, verify each step

**Code Review:**
```
"Review the AuthService for security issues"
"Check if the API endpoints follow REST conventions"
"Find all TODO comments and create a spec"
```
→ Agent analyzes, reports findings

### For the Agent

**Tool Selection:**
- **Always start with:** `get_repo_map(focus: user_request)`
- **Find declarations:** `find_symbol(name)` not `search_in_files`
- **Check blast radius:** `find_references` before renaming
- **Understand file:** `get_file_outline` before editing
- **Minimal edits:** `edit_file` not `write_file` for existing files
- **Large files:** `write_file` + `append_file` chunks

**When to Delegate:**
```typescript
// ❌ DON'T delegate tiny work
delegate_task("Add a console.log")

// ✅ DO delegate substantial work
delegate_task(
  "Build complete user authentication flow",
  target_files: ["src/auth/", "src/middleware/"],
  acceptance: "Users can register, login, logout"
)
```

**Parallel Execution:**
```typescript
// ✅ GOOD - Independent components
delegate_parallel([
  { instruction: "Build Header", target_files: ["Header.tsx"] },
  { instruction: "Build Footer", target_files: ["Footer.tsx"] },
  { instruction: "Build Sidebar", target_files: ["Sidebar.tsx"] }
])

// ❌ BAD - Overlapping files
delegate_parallel([
  { instruction: "Add auth", target_files: ["app.ts", "routes.ts"] },
  { instruction: "Add logging", target_files: ["app.ts", "logger.ts"] }
])  // app.ts conflict!
```

**Validation:**
```typescript
// After any file changes
validate_changes(["file1.ts", "file2.ts"])

// Check before marking task done
// Deterministic first, semantic second
```


---

## 📚 KEY FILES REFERENCE

### Critical Backend Files

**Entry Points:**
- `backend/src/index.ts` - Express server + WebSocket + routes
- `backend/src/agent/orchestrator.ts` - Main agent loop (1800+ lines)
- `backend/src/agent/specOrchestrator.ts` - Spec execution controller
- `backend/src/agent/taskAgent.ts` - Worker agent implementation

**Code Intelligence:**
- `backend/src/agent/intelligence/codeIntelligence.ts` - Index + repo maps (600+ lines)
- `backend/src/agent/intelligence/symbols.ts` - Multi-language parser (800+ lines)
- `backend/src/agent/intelligence/validator.ts` - Deterministic validation (400+ lines)

**Tools:**
- `backend/src/agent/tools/index.ts` - Tool registry + definitions (1500+ lines)
- `backend/src/agent/tools/filesystem.ts` - File operations (600+ lines)
- `backend/src/agent/tools/shell.ts` - Command execution (400+ lines)
- `backend/src/agent/tools/specs.ts` - Spec CRUD (800+ lines)
- `backend/src/agent/tools/backgroundProcess.ts` - Process management (400+ lines)
- `backend/src/agent/tools/browserControl.ts` - Playwright integration (500+ lines)
- `backend/src/agent/tools/computerControl.ts` - PyAutoGUI wrapper (300+ lines)

**Models:**
- `backend/src/models/index.ts` - Unified model interface
- `backend/src/models/claude.ts` - Anthropic adapter (300+ lines)
- `backend/src/models/ollama.ts` - Ollama adapter with retry (1000+ lines)
- `backend/src/models/gemini.ts` - Google Gemini adapter (400+ lines)

**Context Management:**
- `backend/src/agent/contextManager.ts` - History compaction (400+ lines)
- `backend/src/agent/contextLimits.ts` - Model context windows (200+ lines)
- `backend/src/agent/contextMigration.ts` - Session migration (300+ lines)

**Database:**
- `backend/src/db/index.ts` - SQLite + migrations (400+ lines)
- `backend/src/session/manager.ts` - Session CRUD (600+ lines)

**Utilities:**
- `backend/src/utils/logger.ts` - Winston configuration
- `backend/src/utils/errorHandler.ts` - Error recovery
- `backend/src/utils/configParser.ts` - JSON/YAML/TOML parsing

### Critical Frontend Files

**Entry Points:**
- `frontend/src/main.tsx` - React entry
- `frontend/src/App.tsx` - Root component + routing (200+ lines)
- `frontend/src/store/index.ts` - Zustand state (500+ lines)

**Main Layout:**
- `frontend/src/components/BubbleRoom/BubbleRoom.tsx` - Layout container (400+ lines)
- `frontend/src/components/BubbleRoom/Sidebar.tsx` - Left navigation
- `frontend/src/components/BubbleRoom/RightPanel.tsx` - Diffs/preview/audit

**Chat:**
- `frontend/src/components/Chat/ChatPanel.tsx` - Message list (400+ lines)
- `frontend/src/components/Chat/ChatInput.tsx` - Input with auto-resize
- `frontend/src/components/Chat/MessageList.tsx` - Rendering logic (600+ lines)

**Shared:**
- `frontend/src/components/Shared/ToolIndicator.tsx` - Tool UI (300+ lines)
- `frontend/src/components/Shared/ApprovalCard.tsx` - Approval flow (200+ lines)
- `frontend/src/components/Shared/DiffViewer.tsx` - File diffs (300+ lines)

**Hooks:**
- `frontend/src/hooks/useWebSocket.ts` - WS connection + events (400+ lines)
- `frontend/src/hooks/useApi.ts` - REST API wrappers (200+ lines)
- `frontend/src/hooks/useDesktop.ts` - Electron bridge (100+ lines)

**Utils:**
- `frontend/src/utils/messageReconstruction.ts` - Thread loading (200+ lines)
- `frontend/src/utils/toolDisplay.ts` - Tool humanization (400+ lines)

### Desktop Files

- `desktop/main.js` - Electron main process (800+ lines)
- `desktop/preload.js` - IPC bridge (100+ lines)
- `desktop/package.json` - electron-builder config

### Configuration

- `backend/tsconfig.json` - TypeScript config
- `frontend/tsconfig.json` - Frontend TS config
- `frontend/vite.config.ts` - Vite build config
- `frontend/tailwind.config.js` - Tailwind styles
- `package.json` (root) - Workspace scripts


---

## 🎯 CONTRIBUTING GUIDELINES

### Development Setup

```bash
# Clone repository
git clone https://github.com/your-org/bubbly.git
cd bubbly

# Install all dependencies
npm run setup

# Start development servers
./start.sh  # or start.bat on Windows

# Run tests
cd backend && npm test
```

### Code Standards

**TypeScript:**
- Strict mode enabled
- Explicit types for public APIs
- Avoid `any` (use `unknown` instead)
- JSDoc comments for complex functions

**Naming Conventions:**
- Files: camelCase.ts (e.g., `contextManager.ts`)
- Interfaces: PascalCase (e.g., `ToolDefinition`)
- Functions: camelCase (e.g., `buildRepoMap`)
- Constants: SCREAMING_SNAKE_CASE (e.g., `MAX_FILE_SIZE`)

**Error Handling:**
- Use try/catch for async operations
- Log errors with context
- Return Result types where appropriate
- Emit error events to UI

**Testing:**
- Unit tests for pure functions
- Integration tests for API flows
- Manual tests for UI interactions
- Mock external dependencies

### Pull Request Process

1. **Fork & Branch:**
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make Changes:**
   - Write code
   - Add tests
   - Update documentation

3. **Verify:**
   ```bash
   npm run build        # Ensure builds
   npm test             # Run tests
   ```

4. **Commit:**
   ```bash
   git commit -m "feat: add feature description"
   ```
   Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`

5. **Push & PR:**
   ```bash
   git push origin feature/your-feature
   ```
   Create PR on GitHub with description

### Areas for Contribution

**High Priority:**
- Frontend test suite (Vitest + RTL)
- macOS desktop support
- Linux desktop support
- OpenAI GPT integration
- LSP integration

**Medium Priority:**
- More MCP servers
- Better error messages
- Performance profiling
- Documentation improvements
- Additional language support (symbols.ts)

**Low Priority:**
- UI polish
- Keyboard shortcuts
- Theme customization
- Plugin system architecture
- Cloud deployment guide


---

## 📖 GLOSSARY

**Agent** - The AI assistant that executes tasks via tool calls

**Approval** - User decision required before executing certain tools

**Code Intelligence** - System for structural code analysis (symbols, index, repo map)

**Context Window** - Token limit for model input (varies by model)

**Delegation** - Spawning focused worker agents for subtasks

**Desktop Shell** - Electron wrapper providing native OS integration

**Deterministic Validation** - Syntax/type checks before semantic verification

**EARS Properties** - Easy Approach to Requirements Syntax (testable acceptance criteria)

**Lead Agent** - Main orchestrator in spec mode (plans, doesn't implement)

**MCP** - Model Context Protocol (standard for extending AI capabilities)

**Orchestrator** - Main control loop coordinating agent iterations

**Parallel Execution** - Running multiple independent tasks simultaneously

**Preload** - Electron's secure IPC bridge (contextBridge)

**PTY** - Pseudo-terminal (real shell session)

**Repo Map** - Compressed structural overview of codebase

**Skill** - Reusable agent capability (keyword-activated)

**Spec** - Structured feature definition (requirements → design → tasks)

**Steering** - Project-specific instructions for agent

**Symbol** - Function, class, interface, or type declaration

**Task Agent** - Focused worker for one unit of work

**Thread** - Conversation session with persistent history

**Token** - Unit of text for model processing (~4 characters)

**Tool** - Function the agent can invoke (read_file, write_file, etc.)

**Vibe Mode** - Default hands-on coding mode (agent does work directly)

**Worker** - Delegated agent handling specific subtask


---

## 🔗 RELATED RESOURCES

### Documentation
- **README.md** - User-facing getting started guide
- **ARCHITECTURE.md** - Technical deep-dive into code intelligence + specs
- **run.md** - Development notes and scratch work

### External References
- **Anthropic Claude API:** https://docs.anthropic.com/
- **Google Gemini API:** https://ai.google.dev/docs
- **Ollama:** https://ollama.ai/
- **Model Context Protocol:** https://modelcontextprotocol.io/
- **Electron:** https://www.electronjs.org/docs
- **React:** https://react.dev/
- **Vite:** https://vitejs.dev/
- **TypeScript:** https://www.typescriptlang.org/docs/

### Community
- **Issues:** GitHub Issues (bug reports + feature requests)
- **Discussions:** GitHub Discussions (questions + ideas)
- **Discord:** (if available)

---

## 📄 DOCUMENT METADATA

**Generated:** 2026-07-14  
**Author:** Automated Investigation  
**Version:** 1.0  
**Total Sections:** 35  
**Word Count:** ~15,000  
**Lines of Code Analyzed:** ~50,000+  
**Files Read:** ~120+  

**Completeness:**
- ✅ Architecture & Design
- ✅ Technology Stack
- ✅ Code Intelligence Engine
- ✅ Spec System
- ✅ Agent Orchestration
- ✅ Model Adapters
- ✅ Tool System
- ✅ Desktop App
- ✅ Frontend
- ✅ WebSocket Protocol
- ✅ Security Model
- ✅ Context Management
- ✅ Integrated Terminal
- ✅ MCP Integration
- ✅ Configuration
- ✅ Testing
- ✅ Error Handling
- ✅ Performance
- ✅ Troubleshooting
- ✅ Best Practices
- ✅ File Reference
- ✅ Contributing Guidelines
- ✅ Glossary

**Notes:**
This document was created by systematically reading and analyzing every major component of the Bubbly codebase. Unlike the README.md (which is user-facing marketing), this CONTEXT.MD provides complete technical documentation for developers, maintainers, and advanced users who need to understand the entire system architecture.

---

**END OF CONTEXT.MD**

