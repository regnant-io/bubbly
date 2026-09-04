import type { ToolDefinition, FileDiff, Spec, ToolResultImage } from '../../types';
import fsSync from 'fs';
import { logger } from '../../utils/logger';
import {
  readFile,
  writeFile,
  editFile,
  appendFile,
  deleteFile,
  listDirectory,
  getFileTree,
  createDirectory,
} from './filesystem';
import { runSearch, formatSearchOutcome, type SearchOptions } from './search';
import { isRemotePath } from '../../workspace/registry';
import { REPOSITORY_TOOL_DEFINITIONS, executeRepositoryTool } from './repository';
import { executeRemoteTool } from '../../workspace/remoteTools';
import { backgroundProcesses } from './backgroundProcess';
import { createCheckpoint, listCheckpoints, revertToCheckpoint } from './checkpoint';
import {
  runShell, runShellStreaming, isDestructiveCommand, isLongRunningCommand,
  resolveCommandCwd, verifyInstall,
} from './shell';
import { runComputerAction, validateComputerAction, isComputerControlEnabled, type ComputerActionParams } from './computerControl';
import {
  runBrowserAction, validateBrowserAction, isBrowserControlEnabled,
  readRunConfig, writeRunConfig, describeRunConfig,
  type BrowserActionParams, type RunService,
} from './browserControl';
import { watchers, describeCondition, type WatchCondition, type WatchResult } from './watchers';
import { saveArtifact, listArtifacts, readArtifact, artifactContent, type ArtifactKind } from './artifacts';
import { getSetting } from '../../db/index';
import { supportsVision } from '../../models/capabilities';
import { resolveModelVision } from '../../models/ollama';
import { getGitStatus, getGitDiff, gitAdd, gitCommit, gitLog } from './git';
// Specs are plain markdown files the agent reads and edits with the ordinary
// filesystem tools — there are deliberately no spec tools to import. See
// specs.ts for why the ten that used to live here were removed.
import { configParser, type ConfigFormat } from '../../utils/configParser';
import { gatherContext } from './contextGatherer';
import {
  buildRepoMap,
  findSymbol,
  searchSymbols,
  findReferences,
  getFileOutline,
  buildTaskContext,
} from '../intelligence/codeIntelligence';
import { runValidation, formatIssuesForRepair } from '../intelligence/validator';
import * as path from 'path';
import * as fs from 'fs';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use relative paths from the workspace root. Optionally pass start_line and end_line (1-indexed, inclusive) to read only a slice of a large file — prefer this with get_file_outline to read just the relevant function.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file from workspace root' },
        start_line: { type: 'number', description: 'Optional 1-indexed start line' },
        end_line: { type: 'number', description: 'Optional 1-indexed end line (inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, REPLACING its entire contents. Use this ONLY for creating NEW files. For modifying EXISTING files, prefer edit_file to make minimal targeted changes. Returns a diff of changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
        content: { type: 'string', description: 'Full content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Make a MINIMAL targeted edit to an existing file by replacing an exact piece of text. This is the PREFERRED way to modify existing files - do NOT rewrite the whole file. The old_str must match the file content EXACTLY (including whitespace) and must be unique. Include 2-3 lines of surrounding context to ensure uniqueness.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the existing file' },
        old_str: { type: 'string', description: 'The exact text to find and replace (must be unique in the file)' },
        new_str: { type: 'string', description: 'The new text to replace it with' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete' },
      },
      required: ['path'],
    },
  },
  {
    name: 'append_file',
    description: 'Append content to the END of a file (creating it if it does not exist). Use this to build a LARGE file incrementally — write the first part with write_file, then append the rest in chunks. This avoids truncation/corruption that happens when a whole large file is regenerated at once. Each call adds to the existing content; it never replaces it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
        content: { type: 'string', description: 'Content to append to the end of the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given directory. Defaults to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to directory. Defaults to "."' },
      },
    },
  },
  {
    name: 'get_file_tree',
    description: 'Get a tree representation of the workspace or a subdirectory. Depth limit applies.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root path for the tree. Defaults to "."' },
        depth: { type: 'number', description: 'Max depth to traverse (default 3, max 5)' },
      },
    },
  },
  {
    name: 'search',
    description:
      'Find things by text - THE search tool. Searches file CONTENTS by default, file PATHS with target:"filenames", or both with target:"both".\n' +
      'Literal by default: characters like ( ) [ ] . * + ? match themselves, so you can paste a line of code straight in. Pass regex:true for a pattern (^import, function\\s+\\w+), or multiline:true for a pattern that spans lines.\n' +
      'Case is SMART by default: an all-lowercase query matches any case; a query containing a capital is case-sensitive. Override with case_sensitive.\n' +
      'include/exclude are FORGIVING: "ts", "*.ts" and "**/*.ts" all mean TypeScript files at any depth, "src/components" means everything under it, and named groups ("web", "config", "docs", "py", "go", "rust") expand to their extensions. Comma-separate several ("ts,tsx,md") or use braces ("*.{ts,tsx}").\n' +
      'Files matched by .gitignore are skipped unless include_ignored:true, and dot-directories unless include_hidden:true.\n' +
      'Results are grouped by file and report the true total, so you can tell whether you are seeing everything. If the search hits its time budget it says so - a partial result is never presented as an absence.\n' +
      'Use mode:"count" first on a broad query to see where matches are concentrated, then mode:"content" on the interesting directory. For a code SYMBOL, prefer find_symbol / find_references, which understand declarations and call sites.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for. Literal text unless regex:true.' },
        target: { type: 'string', enum: ['content', 'filenames', 'both'], description: '"content" (default) searches inside files; "filenames" searches paths - use it to locate a file whose name you half-remember; "both" does each.' },
        mode: { type: 'string', enum: ['content', 'files', 'count'], description: '"content" (default) returns matching lines; "files" returns just the file list; "count" returns per-file match counts - the cheapest way to survey a broad query.' },
        regex: { type: 'boolean', description: 'Treat the query as a regular expression (default false).' },
        multiline: { type: 'boolean', description: 'Let the pattern span lines (implies regex). Use for multi-line signatures or JSX blocks.' },
        whole_word: { type: 'boolean', description: 'Only match whole words, so "use" does not match "user" (default false).' },
        case_sensitive: { type: 'boolean', description: 'Force case sensitivity. Omit for smart case.' },
        path: { type: 'string', description: 'Subdirectory to search in. Defaults to the workspace root.' },
        include: { type: 'string', description: 'Only search files matching this. Accepts a glob, a bare extension, a language group ("web"), a directory, or a comma-separated list.' },
        exclude: { type: 'string', description: 'Skip files matching this - same forgiving syntax as include, e.g. "*.test.ts,dist".' },
        include_hidden: { type: 'boolean', description: 'Also search dot-directories (.config, .circleci). Off by default.' },
        include_ignored: { type: 'boolean', description: 'Also search files git ignores (build output, vendored copies). Off by default.' },
        context_lines: { type: 'number', description: 'Lines of surrounding context per match (0-10). Use 2-3 when you need to understand the match, 0 when you just need locations.' },
        max_results: { type: 'number', description: 'How many matches to show (default 60, max 1000). The reported total is always the real one.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and any needed parent directories) in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of directory to create' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a one-shot shell command in the workspace directory (installs, scaffolds, tests, builds, linting). Commands are sandboxed to the workspace and time-bounded, and run WITHOUT a terminal: stdin is closed and CI=1 is set, so anything that asks a question is killed rather than left hanging. ALWAYS pass the non-interactive flags (npm create vite -- --template react, --yes, --defaults) instead of relying on prompts. Dev servers and watchers are detected automatically and started in the background instead of blocking — read their logs with get_process_output. Set foreground:true only if you truly need to await a normally-long-running command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Directory to run in, RELATIVE to the workspace root (e.g. "frontend"). Strongly preferred over chaining `cd x; ...` into the command — especially for installs, which must run where the package.json is. Omit for the workspace root.' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Omit it — the default is chosen from the command (10 min for installs/scaffolds, 5 min for builds and test suites, 60s otherwise). Only set it when you know better.' },
        foreground: { type: 'boolean', description: 'Force foreground execution even if the command looks long-running (default false).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description: 'Get the current git status of the workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'git_diff',
    description: 'Get the git diff of unstaged or staged changes.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'If true, shows staged diff. Default is unstaged.' },
      },
    },
  },
  {
    name: 'git_add_and_commit',
    description: 'Stage files and create a git commit.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage. Use ["."] to stage all changes.',
        },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['files', 'message'],
    },
  },
  {
    name: 'git_log',
    description: 'Get the recent git commit log.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Number of recent commits to show (default 10)' },
      },
    },
  },
  {
    name: 'read_config',
    description: 'Read and parse a configuration file (JSON, YAML, or TOML). Returns the parsed configuration as a structured object. Format is auto-detected from file extension.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the configuration file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_config',
    description: 'Write a configuration object to a file in JSON, YAML, or TOML format. Format is auto-detected from file extension. Optionally sort keys alphabetically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the configuration file' },
        data: { type: 'object', description: 'Configuration data to write' },
        sort_keys: { type: 'boolean', description: 'Sort object keys alphabetically (default: false)' },
      },
      required: ['path', 'data'],
    },
  },
  {
    name: 'gather_context',
    description: 'Analyze the repository structure and identify the most relevant files for a given task. Returns ranked files with relevance scores, dependency graph, project type, and entry points. Use this before starting work on a task to understand the codebase context.',
    inputSchema: {
      type: 'object',
      properties: {
        task_description: { 
          type: 'string', 
          description: 'Description of the task or feature you want to work on. Used to rank file relevance.' 
        },
        max_files: { 
          type: 'number', 
          description: 'Maximum number of relevant files to return (default: 20, max: 50)' 
        },
      },
      required: ['task_description'],
    },
  },
  {
    name: 'get_repo_map',
    description: 'Get a COMPRESSED structural map of the codebase: the most important files (ranked by dependency centrality) and their key function/class/type signatures, within a token budget. This is the fastest way to understand a project WITHOUT reading whole files. Optionally focus the map on a task to bias toward relevant files. ALWAYS prefer this over reading many files.',
    inputSchema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Optional task/topic to bias the map toward (e.g. "authentication flow")' },
        max_files: { type: 'number', description: 'Max files to include (default 40)' },
      },
    },
  },
  {
    name: 'find_symbol',
    description: 'Find where a function, class, interface, type, or method is DECLARED by name. Returns file path, line number, and signature. Use this instead of grepping when you know the name of something. Much more precise than a text search.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact symbol name to find (case-insensitive). Supports fuzzy substring search as a fallback.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_references',
    description: 'Find everywhere a symbol (function/class/variable) is USED across the codebase. Returns file:line locations. Use this BEFORE changing a function signature or renaming, to understand the blast radius and avoid breaking callers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to find references to' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_file_outline',
    description: 'Get a structural outline of a single file: all its functions, classes, methods, types and their line numbers — WITHOUT reading the full contents. Use this to understand a large file cheaply before deciding what to read or edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'validate_changes',
    description: 'Run deterministic validation (syntax/bracket checks, and tsc/py_compile when available) on files you have changed. Use this AFTER editing to catch errors before considering work done. Returns concrete errors with file:line so you can fix them precisely.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative paths of files to validate. If omitted, validates all files changed this session.',
        },
      },
    },
  },
  {
    name: 'set_phase',
    description:
      'Name what you are about to do, in four or five plain words, so the person watching can follow you.\n' +
      'A turn can run twenty tool calls, and to a reader they are one undifferentiated wall of steps. They are almost never one thing: they are "building the backend", then "finding out why it failed", then "fixing the import", then "checking it starts". Naming those phases is the difference between a transcript someone can skim and one they have to decode.\n' +
      'CALL THIS WHENEVER WHAT YOU ARE DOING CHANGES - immediately BEFORE the first tool call of the new phase, not after it. It is a one-line, near-free call; do not batch several phases into one label, and do not narrate individual tool calls with it ("reading a file" is not a phase).\n' +
      'Write it as a present-participle phrase describing the WORK, not the tool: "Wiring up the auth routes", "Tracking down the failing test", "Installing the missing dependency", "Verifying the build". No trailing punctuation.\n' +
      'If you keep a plan, moving a step to in_progress already sets the phase for you - you only need this when there is no plan, or when one plan step covers several distinct pieces of work.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Four or five words naming the work, e.g. "Building the backend" or "Fixing the failed migration".' },
        detail: { type: 'string', description: 'Optional one-line "why now", shown on hover. Skip it unless it genuinely adds something.' },
      },
      required: ['label'],
    },
  },
  {
    name: 'update_plan',
    description:
      'Your working plan - the checklist the user watches to follow what you are doing.\n' +
      'THE PLAN PERSISTS. It is stored per thread, it survives tool calls, compaction and even a migration to a fresh thread, and it is shown back to you on every turn with each step id. You never need to reconstruct it from memory.\n' +
      'TO TICK A BOX, USE set_status - NOT a fresh list of steps:\n' +
      '    update_plan(set_status: [{ id: "s1a2", status: "done" }, { id: "s1a3", status: "in_progress" }])\n' +
      'Re-sending the whole plan to change one status is the single most common way a plan gets damaged: one retyped word makes a step look new, and any step you forget to retype is work you have quietly dropped.\n' +
      'Use `steps` ONLY to create the plan the first time, or when the shape of the work genuinely changed. A `steps` list is MERGED with what is already there - unfinished steps you omit are kept, not deleted - so nothing is lost by accident. Pass replace:true if you really do mean to abandon them.\n' +
      'add_steps appends newly discovered work; remove_steps deletes by id.\n' +
      'Keep exactly ONE step in_progress. Mark a step done when it is actually done, and use status "blocked" with a note when something outside your control is in the way.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The ordered list of steps. Use when CREATING the plan or genuinely restructuring it - not to change a status. Merged with the existing plan by id, then by title.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing step id, when revising a step you were given an id for.' },
              title: { type: 'string', description: 'Short description of the step.' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'], description: 'Step status.' },
              note: { type: 'string', description: 'Optional one-line note - why it is blocked, what was decided.' },
            },
            required: ['title', 'status'],
          },
        },
        set_status: {
          type: 'array',
          description: 'THE NORMAL WAY TO UPDATE PROGRESS. Change the status of specific steps by id, leaving everything else untouched.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The step id, as shown in your plan each turn.' },
              title: { type: 'string', description: 'Fallback if you do not have the id - matched loosely against existing step titles.' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'] },
              note: { type: 'string' },
            },
            required: ['status'],
          },
        },
        add_steps: {
          type: 'array',
          description: 'Append newly discovered work without touching the rest of the plan.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'] },
              note: { type: 'string' },
            },
            required: ['title'],
          },
        },
        remove_steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Step ids to delete, for work that turned out to be unnecessary.',
        },
        replace: {
          type: 'boolean',
          description: 'With `steps`: really discard unfinished steps that are not in the new list. Off by default, because omitting a step is almost always a slip.',
        },
        new_plan: {
          type: 'boolean',
          description: 'With `steps`: this is a NEW plan for NEW work, not a revision of the current one. Use it when the user asks for something unrelated after the previous plan finished. The old plan is sealed and kept in the Plans panel as its own plan instead of growing extra steps. Bubbly infers this automatically when your list matches nothing and every existing step is done, so you rarely need to pass it.',
        },
      },
    },
  },
  {
    name: 'artifact',
    description:
      'Author a standalone DOCUMENT for the user — a plan, a report, a summary, a generated page, a diagram, a self-contained snippet — instead of dumping it into the chat.\n' +
      'It gets a title, a stable id and a version history, appears as a card in the conversation, and opens full-size in the Artifacts panel.\n' +
      'USE IT when your output is a deliverable the user will want to re-read, keep, or compare against a later version, and is longer than a few lines.\n' +
      'DO NOT use it for: conversational answers (just say them), or files the project actually needs (use write_file — an artifact is not a project file; the user chooses whether to save it into the workspace).\n' +
      'To revise, call it again with the SAME id: that adds a version rather than replacing the old one, so nothing is lost. Always send the complete new content — versions are whole documents, not patches.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'list', 'read'],
          description: '"write" (default) creates the document or adds a version to it. "list" shows what already exists. "read" returns one document\'s current content.',
        },
        id: { type: 'string', description: 'Stable slug identifying the document, e.g. "auth-migration-plan". Reuse it to revise; a new id makes a new document.' },
        title: { type: 'string', description: 'Human-readable title shown on the card and in the panel.' },
        kind: {
          type: 'string',
          enum: ['markdown', 'html', 'code', 'svg', 'mermaid', 'json'],
          description: 'How to render it. markdown for prose/plans/reports (default), html for a self-contained page, code for a snippet (set language too), svg/mermaid for diagrams, json for structured data.',
        },
        language: { type: 'string', description: 'For kind "code": the language, e.g. "typescript".' },
        content: { type: 'string', description: 'The COMPLETE document. On a revision this replaces the previous version wholesale.' },
        note: { type: 'string', description: 'One line on what changed in this version. Shown in the version history.' },
        version: { type: 'number', description: 'For "read": a specific version. Defaults to the latest.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question and PAUSE until they answer. Use this ONLY when you are genuinely blocked or facing a high-stakes, ambiguous decision you cannot reasonably make yourself (e.g. "delete the production table?" or a real fork in requirements). Do NOT use it for routine choices — for those, make a sensible decision and continue. Overusing this is worse than not using it.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional suggested answers to make it easy to respond',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'delegate_task',
    description: 'Delegate a concrete unit of work to a focused worker agent. The worker does the actual implementation (reads/edits files, runs commands, validates) and reports back with an ACK summary. Use this in Spec Session mode to act as a tech LEAD: plan the work, then delegate each piece rather than editing files yourself. You may delegate several tasks in sequence. Give a clear, self-contained instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'A clear, self-contained description of the work the worker should do.' },
        target_files: { type: 'array', items: { type: 'string' }, description: 'Files the worker will likely create or modify.' },
        acceptance: { type: 'string', description: 'Concrete definition of done for this delegated unit.' },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'delegate_parallel',
    description: 'Delegate 2-4 INDEPENDENT units of work to run AT THE SAME TIME, each handled by its own worker agent. Use this to speed up work that splits cleanly — e.g. building several unrelated components, files, or modules in parallel. CRITICAL: each task MUST declare target_files, and no file may appear in more than one task (the tasks must touch completely separate files), otherwise the workers would corrupt each other. If the work can\'t be split into disjoint files, use delegate_task sequentially instead. Returns a combined report once all workers finish.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '2-4 independent assignments to run in parallel. Each must touch a disjoint set of files.',
          items: {
            type: 'object',
            properties: {
              instruction: { type: 'string', description: 'Self-contained description of this unit of work.' },
              target_files: { type: 'array', items: { type: 'string' }, description: 'Files this worker will create/modify. Required and must not overlap other tasks.' },
              acceptance: { type: 'string', description: 'Definition of done for this unit.' },
            },
            required: ['instruction', 'target_files'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'read_files',
    description: 'Read MULTIPLE files in one call. Strongly preferred over many separate read_file calls — it saves round-trips and keeps you oriented. Optionally pass start_line/end_line to slice every file the same way.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Relative paths of files to read' },
        start_line: { type: 'number', description: 'Optional 1-indexed start line (applied to each file)' },
        end_line: { type: 'number', description: 'Optional 1-indexed end line, inclusive' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'run_background',
    description: 'Start a LONG-RUNNING command (dev server, test watcher, build) as a background process and return immediately with a process id. Use this for anything that does not exit on its own — NOT run_command (which is one-shot and times out). After starting, use get_process_output to read its logs and stop_process to terminate it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the background (e.g. "npm run dev", "uvicorn main:app")' },
        cwd: { type: 'string', description: 'Directory to run in, RELATIVE to the workspace root (e.g. "frontend"). Preferred over chaining `cd x; ...`. Omit for the workspace root.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'get_process_output',
    description: 'Read output from a background process started with run_background. By default returns only NEW output since your last read; pass full=true for the entire buffer. Use this to check if a server started, watch test results, or debug a build. If the process is blocked waiting for keyboard input, the result will say WAITING FOR INPUT and tell you how to answer it with send_process_input.',
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The background process id from run_background' },
        full: { type: 'boolean', description: 'Return the entire output buffer instead of only new output' },
        lines: { type: 'number', description: 'Limit to the last N lines' },
      },
      required: ['process_id'],
    },
  },
  {
    name: 'send_process_input',
    description: 'Send a line of input to a running background process that is waiting for stdin (e.g. answer a "(y/N)" confirmation, type a value into a scaffolder prompt). A newline is appended automatically. Check get_process_output first to see the prompt and the suggested reply.',
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The background process id to send input to' },
        input: { type: 'string', description: 'The text to type (newline added automatically). Use "y" / "n" for confirmations.' },
      },
      required: ['process_id', 'input'],
    },
  },
  {
    name: 'list_processes',
    description: 'List all background processes (running and exited) with their ids, commands, status, and uptime.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_process',
    description: 'Stop/terminate a background process (and its child process tree) by id.',
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'The background process id to stop' },
      },
      required: ['process_id'],
    },
  },
  {
    name: 'computer_control',
    description: 'Control the real mouse, keyboard and screen (via PyAutoGUI) to operate a browser or desktop app — for tasks that have no API/CLI. DISABLED by default: the user must enable computer control in Settings first. Read the screen with action "screenshot" before acting; every action that changes anything requires user approval. Coordinates are absolute screen pixels. Use sparingly and prefer real APIs/CLIs when available.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'screen_size', 'move', 'click', 'double_click', 'right_click', 'drag', 'type', 'key', 'scroll'], description: 'The computer action to perform.' },
        x: { type: 'number', description: 'Target X (absolute screen pixel).' },
        y: { type: 'number', description: 'Target Y (absolute screen pixel).' },
        toX: { type: 'number', description: 'Drag destination X.' },
        toY: { type: 'number', description: 'Drag destination Y.' },
        text: { type: 'string', description: 'Text to type (for action "type").' },
        keys: { description: 'Key name or array of keys for a combo, e.g. "enter" or ["ctrl","c"] (for action "key").' },
        amount: { type: 'number', description: 'Scroll amount: positive = up, negative = down (for action "scroll").' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_control',
    description: 'Drive the Bubbly Preview — a dedicated web browser that renders live inside the docked Bubbly Preview panel (the AGENT\'s own browser; it does NOT touch the user\'s mouse/screen). Every action streams a fresh frame into the panel, so USE IT LIBERALLY to verify web UIs. TARGETING CONTRACT (this is how you click reliably): 1) open(url); 2) snapshot to read the page — it lists every interactive element with its visible "label", a stable sel= when one exists, its @x,y box, and state flags like [DISABLED] / [COVERED BY …] / [OFFSCREEN]; 3) click by passing the exact "text" label from the snapshot (preferred) or the sel= as "selector" — do NOT invent CSS selectors. If a click FAILS, the result starts with "FAILED:" and lists the closest matching elements — pick one of THOSE by its label instead of retrying the same target. Use "wait" (with text/selector) before clicking freshly-rendered elements. Use "viewport" for responsive checks and "console" to read the page\'s console logs/errors. Preferred over computer_control for any web task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'goto', 'reload', 'click', 'type', 'press', 'scroll', 'wait', 'screenshot', 'snapshot', 'viewport', 'console', 'back', 'forward', 'close'], description: 'Browser action. "snapshot" reads the page + interactive elements (no vision needed). "console" returns recent console logs/errors. "viewport" resizes the browser for responsive QA.' },
        url: { type: 'string', description: 'URL for open/goto.' },
        selector: { type: 'string', description: 'FALLBACK target: the sel= value from a snapshot, or a CSS selector. Prefer "text".' },
        text: { type: 'string', description: 'PRIMARY target for click: the exact visible "label" from the latest snapshot. Also the text to type (for type). For wait: the element to wait for.' },
        key: { type: 'string', description: 'Key to press, e.g. "Enter", "Tab", "Control+A".' },
        amount: { type: 'number', description: 'Scroll amount in px (positive = down). For "wait", milliseconds to wait (default 1000, max 15000).' },
        x: { type: 'number', description: 'Click X (page pixel).' },
        y: { type: 'number', description: 'Click Y (page pixel).' },
        preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'wide'], description: 'For "viewport": a device preset (mobile 390x844, tablet 820x1180, desktop 1280x800, wide 1680x1050).' },
        width: { type: 'number', description: 'For "viewport": custom width in px (200–4000) when not using a preset.' },
        height: { type: 'number', description: 'For "viewport": custom height in px (200–4000) when not using a preset.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'watch',
    description:
      'Be told when something finishes, WITHOUT polling. Use sparingly - only when you genuinely cannot continue until the outcome is known.\n' +
      'DO NOT call this just because you started a background process. Starting a dev server or a build does not require waiting on it; carry on with other work.\n' +
      'TWO MODES:\n' +
      '  - Short gate (default): blocks the session, hard-capped at 4 minutes. Right for a quick precondition, e.g. a port opening before you load the page.\n' +
      '  - detached:true - registers the watcher and returns immediately. Use this for anything slow (installs, builds, test suites, Docker, CI). Then FINISH YOUR TURN; the thread is started again automatically with the result when it settles, so ending the turn costs you nothing. A timeout over 4 minutes becomes detached automatically.\n' +
      'Detached results survive the end of the run that created them, so a build that finishes after you stop still has its answer waiting.\n' +
      'If a wait times out but the work is clearly still healthy, use action:"extend" rather than starting a second watcher - extending keeps the process binding and the output already observed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['wait', 'collect', 'list', 'cancel', 'extend'],
          description: '"wait" (default) creates a watcher. "collect" returns any detached watchers that have since finished. "list" shows active watchers. "cancel" stops one. "extend" gives a live one more time.',
        },
        condition: {
          type: 'string',
          enum: ['process_exit', 'output_match', 'url_live', 'port_open', 'file_exists'],
          description: 'What to wait for. process_exit = a run_background command finishes. output_match = a regex appears in its output (best for dev servers that never exit, e.g. "compiled successfully"). url_live = an HTTP URL responds. port_open = a TCP port accepts connections. file_exists = a path appears.',
        },
        process_id: {
          type: 'string',
          description:
            'The run_background id. REQUIRED for process_exit / output_match. Also pass it for url_live / port_open / file_exists whenever you know which command is supposed to satisfy the condition - the watcher then observes that command too, and tells you the moment it dies instead of polling a port it will never open until the timeout. Without it, a single running background process is bound automatically; with two or more, none is.',
        },
        pattern: { type: 'string', description: 'For output_match: a regex, case-insensitive. e.g. "ready in|compiled successfully|listening on".' },
        url: { type: 'string', description: 'For url_live: e.g. "http://localhost:5173".' },
        port: { type: 'number', description: 'For port_open: e.g. 5173.' },
        path: { type: 'string', description: 'For file_exists: absolute or workspace-relative path.' },
        timeout_seconds: { type: 'number', description: 'How long to wait before giving up. Default 1800 (30 min), max 21600 (6 h). Be generous - a timeout is a safety net against a wait that will never end, not a guess at how long a build takes. For extend, how much EXTRA time to add.' },
        detached: { type: 'boolean', description: 'If true, return immediately and be woken with the result instead of blocking.' },
        watcher_id: { type: 'string', description: 'For cancel and extend: the watcher id.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'preview_config',
    description:
      'Read or author this project\'s run config (.bubbly/browser-meta.json) — the "how do I start this app" record that Bubbly Preview requires.\n' +
      'WORKFLOW: browser_control is BLOCKED until a config exists. When it blocks, call this with action "detect" to see what Bubbly found, verify it against the actual project (read package.json scripts, check subdirectories), then call action "write" with the corrected list.\n' +
      'IF A CONFIG ALREADY EXISTS: use it. Call "show" to read it — do NOT re-write a working config, and never overwrite hand-edited commands. Only "write" again when something is genuinely wrong or a new service was added (browser_control will tell you).\n' +
      'MULTI-SERVICE: list EVERY runnable service — a monorepo with a Vite UI and an Express API needs both, each with its own cwd. One Run starts them all. Mark exactly one UI service as kind:"frontend"; its url is what the preview opens.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['detect', 'show', 'write'],
          description: '"detect" = auto-detect services without saving (a suggestion to verify). "show" = read the saved config plus any problems with it. "write" = save the config you decided on.',
        },
        services: {
          type: 'array',
          description: 'For "write": every runnable service in the project.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Display name, e.g. "web" or "api".' },
              cwd: { type: 'string', description: 'Directory RELATIVE to the workspace root. Use "" for the root itself.' },
              install: { type: 'string', description: 'Install command, e.g. "npm install". Optional.' },
              start: { type: 'string', description: 'Dev command, e.g. "npm run dev". Required for the service to run.' },
              port: { type: 'number', description: 'Dev port, e.g. 5173. Used to derive the preview URL.' },
              url: { type: 'string', description: 'Explicit URL, e.g. "http://localhost:5173". Optional if port is set.' },
              kind: { type: 'string', enum: ['frontend', 'backend'], description: 'kind:"frontend" serves the UI to preview; "backend" is an API/worker.' },
            },
            required: ['cwd', 'start', 'kind'],
          },
        },
        preview_url: { type: 'string', description: 'For "write": override which URL the preview opens. Defaults to the frontend service\'s URL.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_checkpoint',
    description: 'Snapshot the current workspace so you can revert later. Use before a risky change (big refactor, full-file rewrite, migration). Cheap and safe — prefer this over git for quick rollbacks.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A short label describing this checkpoint' },
      },
      required: ['label'],
    },
  },
  {
    name: 'list_checkpoints',
    description: 'List available workspace checkpoints (most recent first).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revert_to_checkpoint',
    description: 'Restore the workspace to a previous checkpoint: rewrites snapshotted files to their saved content and removes files created after the checkpoint. Use to recover from a bad change. This is destructive to current changes, so it requires approval.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'The checkpoint id to revert to' },
      },
      required: ['checkpoint_id'],
    },
  },
  {
    name: 'rename_symbol',
    description: 'Rename a symbol (function/class/variable) across the codebase by replacing whole-word occurrences in all files that reference it. Approximate (text-based, word-boundary) — review the result. Good for consistent renames without manually editing every file.',
    inputSchema: {
      type: 'object',
      properties: {
        old_name: { type: 'string', description: 'Current symbol name' },
        new_name: { type: 'string', description: 'New symbol name (must be a valid identifier)' },
      },
      required: ['old_name', 'new_name'],
    },
  },
  ...REPOSITORY_TOOL_DEFINITIONS,
];

export type ToolExecutionResult = {
  result: string;
  diff?: FileDiff[];
  spec?: Spec;
  requiresApproval?: boolean;
  approvalReason?: string;
  /** Images to feed back to the (vision) model — e.g. a Bubbly Preview shot. */
  images?: ToolResultImage[];
};

/** Whether the currently-selected model can accept image input. For Ollama we
 *  resolve the model's REAL capabilities via /api/show (accurate for models
 *  whose name gives no hint, e.g. minimax); Claude/Gemini are always vision.
 *  Falls back to the name heuristic if the probe is inconclusive. */
async function activeModelSupportsVision(): Promise<boolean> {
  const provider = getSetting('defaultProvider') || 'claude';
  if (provider === 'claude' || provider === 'gemini') return true;
  const model = getSetting('ollamaModel') || '';
  const baseUrl = getSetting('ollamaBaseUrl') || 'http://localhost:11434';
  try {
    const resolved = await resolveModelVision(baseUrl, model);
    if (resolved !== null) return resolved;
  } catch { /* fall back to heuristic */ }
  return supportsVision('ollama', model);
}

/** Read a PNG/JPEG file into a base64 image block for the model, capped for
 *  safety. Returns undefined if the file can't be read. */
function fileToToolImage(filePath: string): ToolResultImage | undefined {
  try {
    const buf = fsSync.readFileSync(filePath);
    // Guard against oversized frames (base64 is ~1.33x). ~5MB PNG cap.
    if (buf.length > 5_000_000) return undefined;
    const ext = filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return { mediaType: ext, data: buf.toString('base64') };
  } catch { return undefined; }
}

/**
 * Describe the ACTUAL on-disk state of a file after a write/edit/append so the
 * model's mental model stays anchored to reality. Reports the real line count
 * and the last line — critical after the self-healer completes a truncated
 * file, so the model doesn't "lose track" and rewrite the whole thing (which is
 * what causes repeated truncation). Best-effort; returns '' on any error.
 */
/**
 * Clamp command output before it reaches the model.
 *
 * Untruncated shell output is the single biggest token sink in an agent: one
 * `npm install` or a verbose test run is thousands of lines, and it lands in
 * context in full, then gets re-sent with EVERY subsequent message for the rest
 * of the conversation. The cost isn't paid once, it's paid on every turn after.
 *
 * We keep the HEAD (what command ran, how it started) and the TAIL (errors, the
 * failure summary, the exit line) — the middle of a long build log is almost
 * never what anyone needs, while the last 40 lines nearly always are. The gap is
 * marked explicitly so the model knows it is reading an excerpt rather than
 * silently reasoning over a truncated log.
 */
/** Hard ceiling on a BLOCKING watch. A blocking wait holds the entire session,
 *  so it may only ever be used for a short gate (a port coming up, a file
 *  appearing). Longer waits are forced detached. */
/**
 * How long a BLOCKING wait may hold the session.
 *
 * This was 60 seconds, which is shorter than almost every real thing an agent
 * waits for: a cold install, a Docker build, a test suite, a dev server on a
 * slow machine. So the overwhelmingly common outcome of `watch` was a wait that
 * "timed out" while the thing it watched was perfectly healthy — and the agent,
 * told only that the wait failed, would kill and restart work that was seconds
 * from finishing.
 *
 * Four minutes is long enough to cover the ordinary cases outright while still
 * being far short of "the session is hung". Anything genuinely longer is
 * DETACHED: the agent ends its turn and is woken when the watcher settles, so
 * nothing is lost by not blocking. The wait races the abort signal throughout,
 * so Stop is instant regardless of the cap.
 */
const BLOCKING_WATCH_CAP_MS = 240_000;

const OUTPUT_HEAD_CHARS = 2_500;
const OUTPUT_TAIL_CHARS = 8_000;
const OUTPUT_CLAMP_AT = OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS + 500;

export function clampOutput(text: string, opts: { hint?: string } = {}): string {
  if (text.length <= OUTPUT_CLAMP_AT) return text;
  const head = text.slice(0, OUTPUT_HEAD_CHARS);
  const tail = text.slice(text.length - OUTPUT_TAIL_CHARS);
  const dropped = text.length - head.length - tail.length;
  const hint = opts.hint ? ` ${opts.hint}` : '';
  return `${head}\n\n… [${dropped.toLocaleString()} characters omitted from the middle — the beginning and end are shown]${hint}\n\n${tail}`;
}

/** Render a settled watcher for the agent. Deliberately carries the OUTPUT with
 *  the verdict — the whole point is that "it finished" and "here's what it said"
 *  arrive together, so no follow-up read is needed. */
function formatWatchResult(r: WatchResult, label: string): string {
  const secs = (r.waitedMs / 1000).toFixed(1);
  const head = {
    met: `DONE after ${secs}s — ${r.detail}`,
    timeout: `TIMEOUT after ${secs}s — ${r.detail}`,
    failed: `FAILED after ${secs}s — ${r.detail}`,
    cancelled: `CANCELLED — ${r.detail}`,
  }[r.outcome] ?? r.detail;
  const parts = [`Watched: ${label}`, head];
  if (r.exitCode != null) parts.push(`Exit code: ${r.exitCode}`);
  if (r.output) parts.push(`Output:\n${r.output}`);
  return parts.join('\n');
}

function describeFileState(workspacePath: string, relPath: string): string {
  try {
    const full = path.resolve(workspacePath, relPath);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return '';
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    const lineCount = lines.length;
    const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
    const tail = lastNonEmpty.trim().slice(0, 80);
    return `The file now has ${lineCount} line(s) on disk and ends with: "${tail}". This is the authoritative current content — base any further edits on THIS, not on what you intended to write.`;
  } catch {
    return '';
  }
}

export function checkRequiresApproval(
  toolName: string,
  args: Record<string, unknown>,
  requireApprovalForWrites: boolean,
  requireApprovalForShell: boolean
): { required: boolean; reason?: string; preview?: string; autoDecline?: boolean } {
  // Validate that required parameters are defined
  if (toolName === 'write_file') {
    if (!args.path || typeof args.path !== 'string' || args.path.trim() === '') {
      logger.warn('write_file: missing or invalid path parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid write_file call: path parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    
    if (requireApprovalForWrites) {
      const content = String(args.content ?? '').slice(0, 300);
      return {
        required: true,
        reason: `Agent wants to write to: ${args.path}`,
        preview: content + (String(args.content ?? '').length > 300 ? '\n...' : ''),
      };
    }
  }
  
  if (toolName === 'append_file') {
    if (!args.path || typeof args.path !== 'string' || args.path.trim() === '') {
      logger.warn('append_file: missing or invalid path parameter - auto-declining', { args });
      return {
        required: false,
        autoDecline: true,
        reason: 'Invalid append_file call: path parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters',
      };
    }
    if (requireApprovalForWrites) {
      const content = String(args.content ?? '').slice(0, 300);
      return {
        required: true,
        reason: `Agent wants to append to: ${args.path}`,
        preview: content + (String(args.content ?? '').length > 300 ? '\n...' : ''),
      };
    }
  }

  if (toolName === 'edit_file') {
    if (!args.path || typeof args.path !== 'string' || args.path.trim() === '') {
      logger.warn('edit_file: missing or invalid path parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid edit_file call: path parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    if (typeof args.old_str !== 'string' || args.old_str === '') {
      logger.warn('edit_file: missing or invalid old_str parameter - auto-declining', { args });
      return {
        required: false,
        autoDecline: true,
        reason: 'Invalid edit_file call: old_str parameter is missing or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    
    if (requireApprovalForWrites) {
      const oldPreview = String(args.old_str ?? '').slice(0, 150);
      const newPreview = String(args.new_str ?? '').slice(0, 150);
      return {
        required: true,
        reason: `Agent wants to edit: ${args.path}`,
        preview: `- ${oldPreview}\n+ ${newPreview}`,
      };
    }
  }
  
  if (toolName === 'delete_file') {
    if (!args.path || typeof args.path !== 'string' || args.path.trim() === '') {
      logger.warn('delete_file: missing or invalid path parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid delete_file call: path parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    return { required: true, reason: `Agent wants to delete: ${args.path}` };
  }
  
  if (toolName === 'run_command') {
    if (!args.command || typeof args.command !== 'string' || args.command.trim() === '') {
      logger.warn('run_command: missing or invalid command parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid run_command call: command parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    
    if (requireApprovalForShell) {
      const cmd = String(args.command);
      const preview = `$ ${cmd}`;
      if (isDestructiveCommand(cmd)) {
        return { required: true, reason: `Potentially destructive command`, preview };
      }
      return { required: true, reason: `Agent wants to run: ${cmd}`, preview };
    }
  }
  
  if (toolName === 'git_add_and_commit') {
    if (!args.message || typeof args.message !== 'string' || args.message.trim() === '') {
      logger.warn('git_add_and_commit: missing or invalid message parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid git_add_and_commit call: message parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    return { required: true, reason: `Agent wants to commit: "${args.message}"` };
  }
  
  if (toolName === 'write_config') {
    if (!args.path || typeof args.path !== 'string' || args.path.trim() === '') {
      logger.warn('write_config: missing or invalid path parameter - auto-declining', { args });
      return { 
        required: false,
        autoDecline: true,
        reason: 'Invalid write_config call: path parameter is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters'
      };
    }
    
    if (requireApprovalForWrites) {
      const preview = JSON.stringify(args.data, null, 2).slice(0, 300);
      return {
        required: true,
        reason: `Agent wants to write config to: ${args.path}`,
        preview: preview + (JSON.stringify(args.data).length > 300 ? '\n...' : ''),
      };
    }
  }
  
  if (toolName === 'run_background') {
    if (!args.command || typeof args.command !== 'string' || args.command.trim() === '') {
      return {
        required: false,
        autoDecline: true,
        reason: 'Invalid run_background call: command is undefined, null, or empty',
        preview: 'Operation auto-declined due to invalid parameters',
      };
    }
    if (requireApprovalForShell) {
      const cmd = String(args.command);
      return { required: true, reason: `Agent wants to start a background process: ${cmd}`, preview: `$ ${cmd} (background)` };
    }
  }

  if (toolName === 'revert_to_checkpoint') {
    // Destructive to current changes — always confirm.
    return { required: true, reason: `Agent wants to revert the workspace to checkpoint ${args.checkpoint_id}`, preview: 'This discards changes made since the checkpoint.' };
  }

  if (toolName === 'rename_symbol') {
    if (!args.old_name || !args.new_name) {
      return {
        required: false,
        autoDecline: true,
        reason: 'Invalid rename_symbol call: old_name and new_name are required',
        preview: 'Operation auto-declined due to invalid parameters',
      };
    }
    if (requireApprovalForWrites) {
      return { required: true, reason: `Agent wants to rename "${args.old_name}" → "${args.new_name}" across the codebase` };
    }
  }

  if (toolName === 'computer_control') {
    const action = String(args.action ?? '');
    // Read-only observation (screenshot/screen_size) needs no approval so the
    // agent can "see" to plan; everything that ACTS always requires approval.
    if (action === 'screenshot' || action === 'screen_size') {
      return { required: false };
    }
    const detail = action === 'type' ? `type "${String(args.text ?? '').slice(0, 60)}"`
      : action === 'key' ? `press ${JSON.stringify(args.keys)}`
      : action;
    return {
      required: true,
      reason: `Agent wants to control the computer: ${detail}`,
      preview: `Computer action: ${action}${args.x != null ? ` @ (${args.x}, ${args.y})` : ''}`,
    };
  }

  return { required: false };
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workspacePath: string,
  onEvent?: (event: { type: string; content: string }) => void,
  /** Aborted when the user presses Stop. Tools that WAIT (rather than compute)
   *  must honour it — without this, an in-flight tool call kept running after
   *  Stop and the session appeared frozen until its own timeout expired. */
  signal?: AbortSignal,
  /** Which thread this call belongs to. A detached `watch` needs it so the
   *  watcher can wake that exact thread when it settles. */
  ctx?: { sessionId?: string }
): Promise<ToolExecutionResult> {
  // Clean up tool name - Ollama sometimes prefixes with "function:"
  const cleanToolName = toolName.replace(/^function:/, '');
  const toolLogger = logger.child({ tool: cleanToolName, component: 'tool-execution' });
  
  toolLogger.debug('Tool execution started', { args, originalName: toolName });
  const startTime = Date.now();

  try {
    let result: ToolExecutionResult;

    /*
     * REMOTE WORKSPACES BRANCH FIRST.
     *
     * When this thread's workspace lives on another machine, the I/O tools have
     * to execute THERE — reading a file must read the remote file, running a
     * command must run it on the remote host. `executeRemoteTool` handles
     * exactly those tools and returns null for everything else, so tools with no
     * workspace I/O (update_plan, artifact, ask_user, delegate_task) fall
     * through to the shared implementation below and behave identically
     * regardless of source.
     *
     * This is deliberately the FIRST thing in the function. A remote check
     * placed inside individual cases is a check that can be forgotten, and the
     * consequence of forgetting it is a write to the wrong machine.
     */
    if (isRemotePath(workspacePath)) {
      const remote = await executeRemoteTool(cleanToolName, args, workspacePath, onEvent, signal);
      if (remote) {
        const duration = Date.now() - startTime;
        toolLogger.info('Remote tool execution completed', { durationMs: duration });
        return remote;
      }
    }
    
    switch (cleanToolName) {
      case 'read_file': {
        const content = await readFile(workspacePath, String(args.path));
        // Optional line-range slicing for cheap reads of large files.
        const start = args.start_line ? Math.max(1, Number(args.start_line)) : undefined;
        const end = args.end_line ? Number(args.end_line) : undefined;
        if (start || end) {
          const lines = content.split('\n');
          const from = (start ?? 1) - 1;
          const to = end ?? lines.length;
          const slice = lines.slice(from, to);
          const numbered = slice.map((l, i) => `${from + i + 1}\t${l}`).join('\n');
          result = { result: `# ${args.path} (lines ${from + 1}-${Math.min(to, lines.length)} of ${lines.length})\n${numbered}` };
        } else {
          result = { result: content };
        }
        break;
      }

      case 'write_file': {
        const targetPath = String(args.path);
        const existedBefore = fs.existsSync(path.resolve(workspacePath, targetPath));
        const { success, diff } = await writeFile(
          workspacePath,
          targetPath,
          String(args.content)
        );
        // Nudge the model toward minimal edits: if it rewrote an existing file,
        // remind it to prefer edit_file next time (does not block the write).
        const nudge = existedBefore
          ? ` (note: ${targetPath} already existed — for small changes prefer edit_file to avoid rewriting the whole file)`
          : '';
        result = {
          result: success ? `File written: ${targetPath}${nudge}. ${describeFileState(workspacePath, targetPath)}` : 'Write failed',
          diff: [diff],
        };
        toolLogger.info('File written', {
          path: targetPath,
          size: String(args.content).length,
          existedBefore,
          success,
        });
        break;
      }

      case 'edit_file': {
        const { success, diff, message } = await editFile(
          workspacePath,
          String(args.path),
          String(args.old_str),
          String(args.new_str)
        );
        result = {
          result: success ? message + '. ' + describeFileState(workspacePath, String(args.path)) : 'Edit failed',
          diff: [diff],
        };
        toolLogger.info('File edited', { path: args.path, success });
        break;
      }

      case 'append_file': {
        const { success, diff, message } = await appendFile(
          workspacePath,
          String(args.path),
          String(args.content)
        );
        result = {
          result: success ? message + '. ' + describeFileState(workspacePath, String(args.path)) : 'Append failed',
          diff: [diff],
        };
        toolLogger.info('File appended', { path: args.path, success });
        break;
      }

      case 'read_files': {
        const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
        if (paths.length === 0) {
          result = { result: 'read_files requires a non-empty "paths" array.' };
          break;
        }
        const start = args.start_line ? Math.max(1, Number(args.start_line)) : undefined;
        const end = args.end_line ? Number(args.end_line) : undefined;
        const parts: string[] = [];
        for (const p of paths.slice(0, 20)) {
          try {
            const content = await readFile(workspacePath, String(p));
            if (start || end) {
              const lines = content.split('\n');
              const from = (start ?? 1) - 1;
              const to = end ?? lines.length;
              parts.push(`### ${p} (lines ${from + 1}-${Math.min(to, lines.length)} of ${lines.length})\n${lines.slice(from, to).join('\n')}`);
            } else {
              parts.push(`### ${p}\n${content}`);
            }
          } catch (err) {
            parts.push(`### ${p}\n[error: ${err instanceof Error ? err.message : String(err)}]`);
          }
        }
        result = { result: parts.join('\n\n---\n\n') };
        toolLogger.info('Batch file read', { count: paths.length });
        break;
      }

      case 'run_background': {
        const bgCwd = resolveCommandCwd(workspacePath, args.cwd != null ? String(args.cwd) : undefined);
        if (!bgCwd.ok) { result = { result: `FAILED: ${bgCwd.error}` }; break; }
        const r = backgroundProcesses.start(String(args.command), bgCwd.cwd, (url) => {
          onEvent?.({ type: 'preview_url', content: url });
        });
        if (r.error) {
          result = { result: `Failed to start: ${r.error}` };
        } else {
          result = { result: `${r.reused ? 'Reusing' : 'Started'} background process ${r.id} for: ${args.command}\nUse get_process_output("${r.id}") to read its logs, stop_process("${r.id}") to stop it.` };
        }
        toolLogger.info('Background process tool', { command: args.command, id: r.id, reused: r.reused });
        break;
      }

      case 'get_process_output': {
        const r = backgroundProcesses.getOutput(String(args.process_id), {
          full: args.full === true,
          lines: args.lines ? Number(args.lines) : undefined,
        });
        if (!r.ok) {
          result = { result: r.error ?? 'Process not found.' };
        } else {
          let header = `[${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ''}]`;
          let waitNote = '';
          if (r.awaitingInput) {
            const ai = r.awaitingInput;
            header = `[${r.status} — WAITING FOR INPUT]`;
            waitNote =
              `\n\n⚠ This process appears to be waiting for input (${ai.kind}): "${ai.prompt}"\n` +
              `Answer it with send_process_input("${args.process_id}", "<your reply>")` +
              (ai.suggestedReply ? ` — likely reply: "${ai.suggestedReply}".` : '.');
          }
          // A "still running, no new output" read is the signature of a polling
          // loop. Point the agent at the watcher instead of letting it spin.
          const idle = r.status === 'running' && !r.output && !r.awaitingInput;
          const pollNote = idle
            ? `\n\nNothing new yet. Do NOT keep re-reading this in a loop. Get on with other work; if you truly cannot proceed without ` +
              `the outcome, register watch(condition:"process_exit", process_id:"${args.process_id}", detached:true) and end your turn — ` +
              `you'll be resumed when it finishes.`
            : '';
          result = { result: `${header}\n${clampOutput(r.output || '(no new output)', { hint: 'Use lines:N for just the tail.' })}${waitNote}${pollNote}` };
        }
        break;
      }

      case 'send_process_input': {
        const r = backgroundProcesses.sendInput(String(args.process_id), String(args.input ?? ''));
        result = { result: r.ok ? `Sent input to ${args.process_id}.` : (r.error ?? 'Failed to send input.') };
        break;
      }

      case 'list_processes': {
        const list = backgroundProcesses.list();
        result = {
          result: list.length === 0
            ? 'No background processes.'
            : list.map((p) => `${p.id} [${p.status}${p.awaitingInput ? ' — waiting for input' : ''}] ${p.command} (${Math.round(p.uptimeMs / 1000)}s)`).join('\n'),
        };
        break;
      }

      case 'stop_process': {
        const r = backgroundProcesses.stop(String(args.process_id));
        result = { result: r.ok ? `Stopped ${args.process_id}.` : (r.error ?? 'Failed to stop.') };
        break;
      }

      case 'computer_control': {
        if (!isComputerControlEnabled()) {
          result = { result: 'Computer control is OFF. Ask the user to enable it in Settings → Safety ("Allow computer control"). Until then you cannot control the mouse/keyboard/screen.' };
          break;
        }
        // Only the per-project kill switch applies here. We deliberately do NOT
        // author a run config as a side effect of computer control: a guessed
        // config written here would silently satisfy the browser_control gate,
        // which exists precisely to force a deliberate, verified one.
        const lock = readRunConfig(workspacePath);
        if (lock.exists && !lock.enabled) {
          result = { result: `Browser/computer control is disabled for this project (see ${lock.path} — set "enabled": true to re-allow).` };
          break;
        }
        const validated = validateComputerAction(String(args.action ?? ''), args as ComputerActionParams);
        if (!validated.ok) {
          result = { result: validated.error };
          break;
        }
        const r = await runComputerAction(validated.action, validated.params);
        result = { result: r.result };
        if (r.screenshotPath) {
          if (await activeModelSupportsVision()) {
            const img = fileToToolImage(r.screenshotPath);
            if (img) result.images = [img];
          } else {
            result.result += '\n(Screenshot captured but not sent to the model — the active model has no vision support. Switch to a vision-capable model to have the agent see it.)';
          }
        }
        toolLogger.info('Computer control action', { action: validated.action, ok: r.ok });
        break;
      }

      case 'watch': {
        const action = String(args.action ?? 'wait');

        if (action === 'collect') {
          const done = watchers.collectUndelivered();
          watchers.prune();
          result = { result: done.length === 0
            ? 'No detached watchers have finished since you last checked.'
            : done.map((d) => formatWatchResult(d, d.label)).join('\n\n') };
          break;
        }
        if (action === 'list') {
          const live = watchers.list();
          result = { result: live.length === 0 ? 'No watchers.' : live.map((w) =>
            `${w.id} — ${w.label} — ${w.settled ? `settled (${w.outcome})` : `waiting ${Math.round(w.ageMs / 1000)}s`}`).join('\n') };
          break;
        }
        if (action === 'cancel') {
          const r = watchers.cancel(String(args.watcher_id ?? ''));
          result = { result: r.ok ? 'Watcher cancelled.' : `FAILED: ${r.error}` };
          break;
        }
        if (action === 'extend') {
          // "Still going — give it longer" without tearing the watcher down and
          // losing its process binding and the output it has already seen.
          const extraMs = (Number(args.timeout_seconds) || 300) * 1000;
          const r = watchers.extend(String(args.watcher_id ?? ''), extraMs);
          result = { result: r.ok
            ? `Watcher extended; it will now give up at ${new Date(r.deadlineAt!).toLocaleTimeString()}.`
            : `FAILED: ${r.error}` };
          break;
        }

        // action === 'wait' — build the condition from the flat args.
        const kind = String(args.condition ?? '');
        // process_id is meaningful for EVERY condition, not just the two that
        // require it: on a polled condition it binds the watcher to the command
        // that owes it, so a crashed dev server is reported in seconds rather
        // than as a timeout minutes later.
        const boundProcess = args.process_id ? String(args.process_id) : undefined;
        const condition: WatchCondition | null =
          kind === 'process_exit' ? { kind: 'process_exit', processId: String(args.process_id ?? '') }
          : kind === 'output_match' ? { kind: 'output_match', processId: String(args.process_id ?? ''), pattern: String(args.pattern ?? '') }
          : kind === 'url_live' ? { kind: 'url_live', url: String(args.url ?? ''), processId: boundProcess }
          : kind === 'port_open' ? { kind: 'port_open', port: Number(args.port), processId: boundProcess }
          : kind === 'file_exists' ? { kind: 'file_exists', path: path.resolve(workspacePath, String(args.path ?? '')), processId: boundProcess }
          : null;
        if (!condition) {
          result = { result: `FAILED: unknown condition "${kind}". Use one of: process_exit, output_match, url_live, port_open, file_exists.` };
          break;
        }

        // A BLOCKING wait parks the whole session, so it is hard-capped at
        // BLOCKING_WATCH_CAP_MS regardless of what was asked for. Anything
        // genuinely long must be detached — the agent ends its turn and gets
        // woken when the watcher settles, instead of holding the session (and
        // the Stop button) hostage for minutes.
        const requestedMs = args.timeout_seconds ? Number(args.timeout_seconds) * 1000 : undefined;
        const detached = args.detached === true
          || (requestedMs !== undefined && requestedMs > BLOCKING_WATCH_CAP_MS);

        const created = watchers.create(condition, {
          timeoutMs: detached ? requestedMs : Math.min(requestedMs ?? BLOCKING_WATCH_CAP_MS, BLOCKING_WATCH_CAP_MS),
          // Binding the watcher to its thread is what makes the promise below
          // ("you'll be resumed") literally true rather than aspirational.
          sessionId: ctx?.sessionId,
          detached,
        });
        if (!created.ok) { result = { result: `FAILED: ${created.error}` }; break; }

        if (detached) {
          result = { result:
            `Watcher ${created.id} is running in the background (${describeCondition(condition)}).\n` +
            `Do NOT wait for it — finish what you can and END YOUR TURN NOW. When it settles, this thread is ` +
            `automatically started again with the result, so stopping is genuinely free: you lose nothing by ` +
            `handing control back to the user in the meantime.` };
          break;
        }

        // Short, cancellable wait. Racing the abort signal is what makes Stop
        // work: previously this await ignored it entirely and the session stayed
        // frozen until the watcher's own timeout fired.
        const waited = await Promise.race([
          watchers.wait(created.id),
          new Promise<null>((resolve) => {
            if (!signal) return;
            if (signal.aborted) { resolve(null); return; }
            signal.addEventListener('abort', () => resolve(null), { once: true });
          }),
        ]);
        if (!waited) {
          watchers.cancel(created.id);
          result = { result: 'Watch cancelled.' };
          break;
        }
        result = { result: formatWatchResult(waited, describeCondition(condition)) };
        break;
      }

      case 'preview_config': {
        const action = String(args.action ?? 'show');
        if (action === 'write') {
          const w = writeRunConfig(workspacePath, {
            services: (args.services as Array<Partial<RunService>>) ?? [],
            previewUrl: args.preview_url ? String(args.preview_url) : null,
          });
          if (!w.ok) { result = { result: `FAILED: ${w.error}` }; break; }
          result = { result: `Run config saved to ${w.status.path}:\n${describeRunConfig(w.status)}\nBubbly Preview is now unblocked.` };
          break;
        }
        const status = readRunConfig(workspacePath);
        if (action === 'detect') {
          result = { result: status.suggestion.length > 0
            ? `Auto-detected services (verify these, then write them):\n${describeRunConfig({ ...status, meta: null, issues: [] })}`
            : 'Nothing auto-detected. Inspect the project (package.json scripts, subdirectories) and describe the services yourself.' };
          break;
        }
        result = { result: status.exists
          ? `Run config at ${status.path}${status.migrated ? ' (legacy single-service format — will be upgraded on next write)' : ''}:\n${describeRunConfig(status)}`
          : `No run config yet (${status.path} does not exist). Bubbly Preview is blocked until you write one.\n` +
            (status.suggestion.length > 0 ? `Detected:\n${describeRunConfig(status)}` : 'Nothing auto-detected.') };
        break;
      }

      case 'browser_control': {
        // Note: no enable-gate on the SETTING here — runBrowserAction prefers
        // the live Bubbly Preview webview (sandboxed, always allowed) and only
        // falls back to the safety-gated headless browser when no preview is
        // connected. The per-project run-config gate below still applies to both
        // paths: it's the project-scoped lock, independent of the global toggle.
        //
        // NO CONFIG => NO PREVIEW. We deliberately do NOT auto-author one here:
        // a guessed config that half-works is worse than a refusal, because the
        // agent then debugs the wrong app. Refuse, hand over the detection, and
        // let the agent author it via preview_config.
        const cfg = readRunConfig(workspacePath);
        if (!cfg.exists) {
          const detected = describeRunConfig(cfg);
          result = { result:
            'BLOCKED: this project has no run config, so Bubbly Preview cannot be used yet.\n' +
            'Learn the project first (package.json scripts, subdirectories, how the UI is served), then call ' +
            '`preview_config` with action "write" to record every runnable service.\n' +
            (cfg.suggestion.length > 0
              ? `Detected (a starting point — verify before writing it):\n${detected}`
              : 'Nothing was auto-detected; inspect the project and describe the services yourself.') };
          break;
        }
        if (!cfg.enabled) {
          result = { result: `Browser/computer control is disabled for this project (see ${cfg.path} — set "enabled": true to re-allow).` };
          break;
        }
        const blocking = cfg.issues.filter((i) => i.level === 'error');
        if (blocking.length > 0) {
          result = { result:
            `BLOCKED: the run config at ${cfg.path} is broken:\n` +
            blocking.map((i) => `  - ${i.message}`).join('\n') +
            '\nFix it with `preview_config` (action "write") before previewing.' };
          break;
        }
        const v = validateBrowserAction(String(args.action ?? ''), args as BrowserActionParams);
        if (!v.ok) { result = { result: v.error }; break; }
        // Reveal the preview panel the moment a browser tool runs, so the user
        // (and the persistent webview host) is on the Preview tab BEFORE the
        // action executes — not only after a screenshot frame arrives.
        onEvent?.({ type: 'preview_activate', content: '' });
        const r = await runBrowserAction(v.action, v.params);
        // Stream the frame into the docked Bubbly Preview (served via
        // /api/files/screenshot). Sent after every action so the user watches
        // each step. The field is `file` to match WSServerEvent + the frontend.
        if (r.screenshotPath) {
          const file = r.screenshotPath.split(/[\\/]/).pop();
          if (file) onEvent?.({ type: 'browser_screenshot', content: file });
        }
        // Make failures unambiguous so the model doesn't blindly retry the same
        // target (which burns tokens) — the result text also carries candidates.
        result = { result: r.ok ? r.result : `FAILED: ${r.result}` };
        // Non-fatal drift (a new service appeared, one lost its start command)
        // rides along rather than blocking — the agent can fix it when it's
        // relevant instead of being stopped mid-task.
        const drift = cfg.issues.filter((i) => i.level === 'warn');
        if (drift.length > 0) {
          result.result += `\n(run config: ${drift.map((i) => i.message).join(' ')})`;
        }
        // Feed the ACTUAL rendered frame to the (vision) model on an explicit
        // screenshot so it can judge the design, not just read text — but only
        // when the active model can actually read images; otherwise this would
        // either crash the request or silently get stripped several round-trips
        // later, so resolve it up front instead.
        if (v.action === 'screenshot' && r.screenshotPath) {
          if (await activeModelSupportsVision()) {
            const img = fileToToolImage(r.screenshotPath);
            if (img) result.images = [img];
          } else {
            result.result += '\n(Screenshot captured but not sent to the model — the active model has no vision support. Switch to a vision-capable model to have the agent see it.)';
          }
        }
        toolLogger.info('Browser control action', { action: v.action, ok: r.ok });
        break;
      }

      case 'create_checkpoint': {
        const r = createCheckpoint(workspacePath, String(args.label));
        result = { result: r.ok ? `Checkpoint created: ${r.id} (${r.fileCount} files) — "${args.label}". Revert with revert_to_checkpoint("${r.id}").` : `Failed: ${r.error}` };
        break;
      }

      case 'list_checkpoints': {
        const cps = listCheckpoints(workspacePath);
        result = {
          result: cps.length === 0
            ? 'No checkpoints yet.'
            : cps.map((c) => `${c.id} — "${c.label}" (${c.fileCount} files, ${new Date(c.createdAt).toLocaleString()})`).join('\n'),
        };
        break;
      }

      case 'revert_to_checkpoint': {
        const r = revertToCheckpoint(workspacePath, String(args.checkpoint_id));
        if (r.ok) {
          try {
            const { invalidateIndex } = await import('../intelligence/codeIntelligence');
            invalidateIndex(workspacePath);
          } catch { /* non-critical */ }
          result = { result: `Reverted to ${args.checkpoint_id}: restored ${r.restored} file(s), removed ${r.removed} newer file(s).` };
        } else {
          result = { result: `Revert failed: ${r.error}` };
        }
        break;
      }

      case 'rename_symbol': {
        const oldName = String(args.old_name);
        const newName = String(args.new_name);
        if (oldName === newName) {
          result = { result: `old_name and new_name are identical ("${oldName}") — nothing to rename.` };
          break;
        }
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(oldName)) {
          result = { result: `"${oldName}" is not a valid identifier. rename_symbol renames whole-word identifiers; use edit_file for arbitrary text.` };
          break;
        }
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) {
          result = { result: `"${newName}" is not a valid identifier.` };
          break;
        }
        // Collect every file that declares or references the symbol.
        const refFiles = new Set<string>();
        for (const h of findSymbol(workspacePath, oldName)) refFiles.add(h.path);
        for (const r of findReferences(workspacePath, oldName)) refFiles.add(r.path);
        if (refFiles.size === 0) {
          result = { result: `No declarations or references to "${oldName}" found.` };
          break;
        }
        const wordRe = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        const changed: FileDiff[] = [];
        let totalReplacements = 0;
        for (const rel of refFiles) {
          try {
            const content = await readFile(workspacePath, rel);
            const occurrences = (content.match(wordRe) || []).length;
            if (occurrences === 0) continue;
            const updated = content.replace(wordRe, newName);
            const { diff } = await writeFile(workspacePath, rel, updated);
            changed.push(diff);
            totalReplacements += occurrences;
          } catch { /* skip unreadable */ }
        }
        try {
          const { invalidateIndex } = await import('../intelligence/codeIntelligence');
          invalidateIndex(workspacePath);
        } catch { /* non-critical */ }
        result = {
          result: `Renamed "${oldName}" → "${newName}": ${totalReplacements} occurrence(s) across ${changed.length} file(s). Review and validate.`,
          diff: changed,
        };
        toolLogger.info('Symbol renamed', { oldName, newName, files: changed.length, replacements: totalReplacements });
        break;
      }

      case 'delete_file': {
        await deleteFile(workspacePath, String(args.path));
        result = { result: `File deleted: ${args.path}` };
        toolLogger.info('File deleted', { path: args.path });
        break;
      }

      case 'list_directory': {
        const entries = listDirectory(workspacePath, String(args.path ?? '.'));
        result = { result: entries.join('\n') || '(empty directory)' };
        break;
      }

      case 'get_file_tree': {
        const depth = Math.min(Number(args.depth ?? 3), 5);
        const tree = getFileTree(workspacePath, String(args.path ?? '.'), depth);
        result = { result: tree || '(empty)' };
        break;
      }

      // `search` replaced search_in_files, grep_search and find_files. The old
      // names are still accepted so a thread mid-conversation (or a model going
      // from memory) doesn't hit "unknown tool"; their arguments are mapped onto
      // the new shape rather than being rejected.
      case 'search':
      case 'search_in_files':
      case 'grep_search':
      case 'find_files': {
        const legacyGrep = cleanToolName === 'grep_search';
        const legacyFind = cleanToolName === 'find_files';
        const rawTarget = String(args.target ?? '');
        const searchOpts: SearchOptions = {
          query: String(args.query ?? args.pattern ?? ''),
          target: legacyFind ? 'filenames'
            : rawTarget === 'filenames' || rawTarget === 'both' ? rawTarget
            : 'content',
          mode: args.mode === 'files' || args.mode === 'count' ? args.mode : 'content',
          // grep_search was regex by definition; `search` is literal unless asked.
          regex: legacyGrep ? true : args.regex === true,
          multiline: args.multiline === true,
          wholeWord: args.whole_word === true,
          caseSensitive: typeof args.case_sensitive === 'boolean' ? args.case_sensitive : undefined,
          searchPath: args.path ? String(args.path) : undefined,
          // Patterns are normalized inside the search engine now, so a bare
          // "*.ts" or "ts" reaches nested files instead of silently matching
          // only the workspace root. `file_pattern` was the old bare-extension
          // argument and still works.
          include: (args.include ?? args.file_pattern ?? args.file_types) as string | string[] | undefined,
          exclude: args.exclude as string | string[] | undefined,
          includeHidden: args.include_hidden === true,
          includeIgnored: args.include_ignored === true,
          contextLines: args.context_lines != null ? Number(args.context_lines) : 0,
          maxResults: args.max_results != null ? Number(args.max_results)
            : args.limit != null ? Number(args.limit)
            : undefined,
        };
        const outcome = await runSearch(workspacePath, searchOpts);
        result = { result: formatSearchOutcome(searchOpts, outcome) };
        toolLogger.debug('Search completed', {
          tool: cleanToolName,
          query: searchOpts.query,
          totalHits: outcome.totalHits,
          filesScanned: outcome.filesScanned,
          timedOut: outcome.timedOut,
        });
        break;
      }

      case 'create_directory': {
        // Support creating multiple directories separated by space
        const dirPath = String(args.path);
        const dirs = dirPath.split(/\s+/).filter(Boolean);
        const results: string[] = [];
        for (const d of dirs) {
          createDirectory(workspacePath, d);
          results.push(d);
        }
        result = { result: `Directories created: ${results.join(', ')}` };
        toolLogger.info('Directories created', { paths: results });
        break;
      }

      case 'run_command': {
        const command = String(args.command);
        const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const relativeCwd = args.cwd != null ? String(args.cwd) : undefined;

        // Resolve (and validate) the working directory ONCE, up front. Both the
        // background hand-off and the foreground run need it, and a bad cwd must
        // fail loudly here rather than silently defaulting to the workspace root
        // — an install that runs in the wrong folder reports success and writes
        // its node_modules where nothing will ever look for it.
        const cwdCheck = resolveCommandCwd(workspacePath, relativeCwd);
        if (!cwdCheck.ok) {
          return { result: `FAILED: ${cwdCheck.error}` };
        }

        // Guard against the classic hang: if the model routes a dev server /
        // watcher / daemon through the one-shot path, it would block until the
        // timeout fires and then get killed. Detect those and start them in the
        // background instead, returning immediately with a process id the agent
        // can poll via get_process_output. The model can opt out with
        // foreground:true for the rare case it truly wants to await one.
        const forceForeground = args.foreground === true;
        if (!forceForeground && isLongRunningCommand(command)) {
          toolLogger.info('Long-running command detected — routing to background', { command, commandId, cwd: cwdCheck.cwd });
          const r = backgroundProcesses.start(command, cwdCheck.cwd);
          if (r.error) {
            return { result: `Failed to start background process: ${r.error}` };
          }
          const note = r.reused
            ? `An identical command is already running as background process ${r.id}.`
            : `Started "${command}" as background process ${r.id}.`;
          return {
            result:
              `${note}\n` +
              `This command does not exit on its own (it looks like a dev server / watcher), so it is running in the background and did NOT block.\n` +
              `Carry on with your work — do NOT wait on it, and do not poll get_process_output in a loop.\n` +
              `Use get_process_output for a one-off look at its logs, and stop_process to terminate it.\n` +
              `If you actually needed a one-shot run, call run_command again with foreground:true.`,
          };
        }

        toolLogger.info('Shell command started', { command, commandId });
        
        // Use streaming version if onEvent is available
        if (onEvent) {
          const result = await runShellStreaming(
            command,
            workspacePath,
            {
              onStart: (startTime) => {
                onEvent({
                  type: 'terminal_start',
                  content: JSON.stringify({ id: commandId, command, startTime }),
                });
              },
              onStdout: (data) => {
                onEvent({
                  type: 'terminal_output',
                  content: JSON.stringify({ id: commandId, stream: 'stdout', content: data }),
                });
              },
              onStderr: (data) => {
                onEvent({
                  type: 'terminal_output',
                  content: JSON.stringify({ id: commandId, stream: 'stderr', content: data }),
                });
              },
              onEnd: (exitCode, duration) => {
                onEvent({
                  type: 'terminal_end',
                  content: JSON.stringify({ id: commandId, exitCode, duration }),
                });
              },
            },
            {
              // No hardcoded default: shell.ts sizes the budget from the command
              // itself (an install/scaffold gets minutes, not 30s).
              timeoutMs: args.timeout_ms != null ? Number(args.timeout_ms) : undefined,
              cwd: relativeCwd,
            }
          );

          // stderr is clamped less aggressively than stdout: when a command
          // fails, the reason is almost always in stderr, and it's usually short.
          let out = '';
          if (result.stdout) out += `stdout:\n${clampOutput(result.stdout)}\n`;
          if (result.stderr) out += `stderr:\n${clampOutput(result.stderr)}\n`;
          out += `exit code: ${result.exitCode}`;

          // An install's exit code is not proof it landed. Check the filesystem
          // and say so plainly — a partial node_modules is the failure mode the
          // agent otherwise discovers much later, as an unresolvable import.
          const installNote = verifyInstall(command, cwdCheck.cwd, result.exitCode);
          if (installNote) out += `\n\n${installNote}`;

          toolLogger.info('Shell command completed (streaming)', { 
            command, 
            commandId,
            exitCode: result.exitCode,
            hasStdout: !!result.stdout,
            hasStderr: !!result.stderr
          });
          
          return { result: out.trim() };
        } else {
          // Fallback to non-streaming version
          const { stdout, stderr, exitCode } = runShell(
            command,
            workspacePath,
            {
              timeoutMs: args.timeout_ms != null ? Number(args.timeout_ms) : undefined,
              cwd: relativeCwd,
            }
          );
          let out = '';
          if (stdout) out += `stdout:\n${clampOutput(stdout)}\n`;
          if (stderr) out += `stderr:\n${clampOutput(stderr)}\n`;
          out += `exit code: ${exitCode}`;

          const installNote = verifyInstall(command, cwdCheck.cwd, exitCode);
          if (installNote) out += `\n\n${installNote}`;

          toolLogger.info('Shell command completed', { 
            command, 
            exitCode,
            hasStdout: !!stdout,
            hasStderr: !!stderr
          });
          
          return { result: out.trim() };
        }
      }

      case 'git_status': {
        result = { result: getGitStatus(workspacePath) };
        break;
      }

      case 'git_diff': {
        result = { result: getGitDiff(workspacePath, Boolean(args.staged)) };
        break;
      }

      case 'git_add_and_commit': {
        const files = (args.files as string[]) ?? ['.'];
        const message = String(args.message);
        toolLogger.info('Git commit started', { files, message });
        const addResult = gitAdd(workspacePath, files);
        if (!addResult.success) {
          result = { result: `git add failed: ${addResult.message}` };
        } else {
          const commitResult = gitCommit(workspacePath, message);
          result = { result: commitResult.message };
          toolLogger.info('Git commit completed', { 
            files, 
            message,
            success: commitResult.success 
          });
        }
        break;
      }

      case 'git_log': {
        result = { result: gitLog(workspacePath, Number(args.n ?? 10)) };
        break;
      }


      case 'read_config': {
        const filePath = path.join(workspacePath, String(args.path));
        
        // Auto-detect format from file extension
        const ext = path.extname(filePath).toLowerCase();
        let format: ConfigFormat;
        
        if (ext === '.json') {
          format = 'json';
        } else if (ext === '.yaml' || ext === '.yml') {
          format = 'yaml';
        } else if (ext === '.toml') {
          format = 'toml';
        } else {
          result = { 
            result: `Error: Unsupported configuration file format. Supported: .json, .yaml, .yml, .toml` 
          };
          break;
        }
        
        // Read file content
        const content = await fs.promises.readFile(filePath, 'utf-8');
        
        // Parse configuration
        const parseResult = configParser.parse(content, format);
        
        if (!parseResult.success) {
          const errorMsg = parseResult.error?.line 
            ? `Parse error at line ${parseResult.error.line}: ${parseResult.error.message}`
            : `Parse error: ${parseResult.error?.message}`;
          result = { result: `Error reading config: ${errorMsg}` };
          toolLogger.error('Config parse failed', { 
            path: args.path, 
            format,
            error: parseResult.error 
          });
        } else {
          result = { 
            result: `Configuration read successfully from ${args.path}:\n${JSON.stringify(parseResult.data, null, 2)}` 
          };
          toolLogger.info('Config read successfully', { 
            path: args.path, 
            format 
          });
        }
        break;
      }

      case 'write_config': {
        const filePath = path.join(workspacePath, String(args.path));
        
        // Auto-detect format from file extension
        const ext = path.extname(filePath).toLowerCase();
        let format: ConfigFormat;
        
        if (ext === '.json') {
          format = 'json';
        } else if (ext === '.yaml' || ext === '.yml') {
          format = 'yaml';
        } else if (ext === '.toml') {
          format = 'toml';
        } else {
          result = { 
            result: `Error: Unsupported configuration file format. Supported: .json, .yaml, .yml, .toml` 
          };
          break;
        }
        
        // Format configuration data
        const sortKeys = Boolean(args.sort_keys ?? false);
        const formattedContent = configParser.format(args.data, format, { sortKeys });
        
        // Write to file using existing writeFile function
        const { success, diff } = await writeFile(
          workspacePath,
          String(args.path),
          formattedContent
        );
        
        result = {
          result: success 
            ? `Configuration written to ${args.path} (format: ${format}, sorted: ${sortKeys})` 
            : 'Write failed',
          diff: [diff],
        };
        
        toolLogger.info('Config written', { 
          path: args.path, 
          format,
          sortKeys,
          success 
        });
        break;
      }

      case 'gather_context': {
        const taskDescription = String(args.task_description);
        const maxFiles = Math.min(Number(args.max_files ?? 20), 50);
        
        toolLogger.info('Context gathering started', { 
          taskDescription: taskDescription.slice(0, 100),
          maxFiles 
        });
        
        // Gather context using the context gatherer with progress updates
        const analysis = await gatherContext(
          workspacePath, 
          taskDescription, 
          { maxFiles },
          (status) => {
            // Send progress updates via WebSocket
            onEvent?.({ type: 'status', content: status });
          }
        );
        
        // Format the results for the agent
        let resultText = `# Context Analysis\n\n`;
        resultText += `**Project Type:** ${analysis.projectType}\n\n`;
        
        if (analysis.entryPoints.length > 0) {
          resultText += `**Entry Points:**\n`;
          analysis.entryPoints.forEach(ep => {
            resultText += `- ${ep}\n`;
          });
          resultText += `\n`;
        }
        
        resultText += `**Relevant Files (${analysis.relevantFiles.length}):**\n\n`;
        
        analysis.relevantFiles.forEach((file, index) => {
          resultText += `${index + 1}. **${file.path}** (score: ${file.score.toFixed(1)}, category: ${file.category})\n`;
          resultText += `   Reasons: ${file.reasons.join(', ')}\n`;
          
          // Show dependencies if available
          const deps = analysis.dependencyGraph.get(file.path);
          if (deps && deps.length > 0) {
            resultText += `   Dependencies: ${deps.slice(0, 3).join(', ')}${deps.length > 3 ? ` (+${deps.length - 3} more)` : ''}\n`;
          }
          
          resultText += `\n`;
        });
        
        // Add summary statistics
        const totalDeps = Array.from(analysis.dependencyGraph.values()).flat().length;
        resultText += `\n**Summary:**\n`;
        resultText += `- Total files analyzed: ${analysis.dependencyGraph.size}\n`;
        resultText += `- Total dependencies tracked: ${totalDeps}\n`;
        resultText += `- Top ${analysis.relevantFiles.length} files shown above\n`;
        
        result = { result: resultText };
        
        toolLogger.info('Context gathering completed', { 
          relevantFiles: analysis.relevantFiles.length,
          projectType: analysis.projectType,
          entryPoints: analysis.entryPoints.length
        });
        break;
      }

      case 'get_repo_map': {
        const focus = args.focus ? String(args.focus) : undefined;
        const maxFiles = args.max_files ? Math.min(Number(args.max_files), 80) : 40;
        const repoMap = buildRepoMap(workspacePath, { focus, maxFiles });
        result = { result: repoMap };
        toolLogger.info('Repo map generated', { focus: focus?.slice(0, 60), length: repoMap.length });
        break;
      }

      case 'find_symbol': {
        const name = String(args.name);
        let hits = findSymbol(workspacePath, name);
        if (hits.length === 0) {
          // Fall back to fuzzy search so the model still gets useful pointers.
          hits = searchSymbols(workspacePath, name);
        }
        if (hits.length === 0) {
          result = { result: `No symbol matching "${name}" found. Try get_repo_map, or search(query, target:"content").` };
        } else {
          const formatted = hits
            .slice(0, 25)
            .map((h) => `${h.path}:${h.line} — ${h.kind} ${h.container ? h.container + '.' : ''}${h.name} — ${h.signature}`)
            .join('\n');
          result = { result: `Found ${hits.length} declaration(s) for "${name}":\n${formatted}` };
        }
        toolLogger.info('find_symbol', { name, hits: hits.length });
        break;
      }

      case 'find_references': {
        const name = String(args.name);
        const refs = findReferences(workspacePath, name);
        if (refs.length === 0) {
          result = { result: `No references to "${name}" found across indexed code files.` };
        } else {
          const formatted = refs.map((r) => `${r.path}:${r.line}: ${r.text}`).join('\n');
          result = { result: `Found ${refs.length} reference(s) to "${name}" (declarations excluded):\n${formatted}` };
        }
        toolLogger.info('find_references', { name, refs: refs.length });
        break;
      }

      case 'get_file_outline': {
        const relPath = String(args.path);
        const outline = getFileOutline(workspacePath, relPath);
        if (!outline) {
          result = { result: `No outline available for ${relPath} (file not indexed or has no symbols). Use read_file to inspect it.` };
        } else if (outline.symbols.length === 0) {
          result = { result: `${relPath} (${outline.language}) has no top-level symbols. Imports: ${outline.imports.map((i) => i.specifier).slice(0, 10).join(', ') || 'none'}` };
        } else {
          const symLines = outline.symbols
            .map((s) => `  L${s.line} ${s.kind} ${s.container ? s.container + '.' : ''}${s.name} — ${s.signature}`)
            .join('\n');
          const imps = outline.imports.map((i) => i.specifier).slice(0, 15).join(', ');
          result = { result: `# Outline: ${relPath} (${outline.language})\n\nImports: ${imps || 'none'}\n\nSymbols (${outline.symbols.length}):\n${symLines}` };
        }
        toolLogger.info('get_file_outline', { path: relPath, symbols: outline?.symbols.length ?? 0 });
        break;
      }

      case 'validate_changes': {
        const files = Array.isArray(args.files) ? (args.files as string[]).map(String) : [];
        if (files.length === 0) {
          result = { result: 'No files specified to validate. Pass the relative paths of files you changed.' };
          break;
        }
        onEvent?.({ type: 'status', content: `Validating ${files.length} file(s)...` });
        const report = await runValidation({ workspacePath, changedFiles: files, timeoutMs: 30000 });
        // Surface structured issues to the UI's Problems panel.
        onEvent?.({ type: 'diagnostics', content: JSON.stringify(report.issues ?? []) });
        if (report.ok) {
          result = { result: `${report.summary}. No errors found in: ${files.join(', ')}` };
        } else {
          result = { result: `${formatIssuesForRepair(report)}\n\nFix these specific issues, then validate again.` };
        }
        toolLogger.info('validate_changes', { files: files.length, ok: report.ok, issues: report.issues.length });
        break;
      }

      case 'repo':
      case 'forge': {
        // Repository and forge operations run against the LOCAL clone and the
        // hosted API respectively — never over SSH, because a git remote is
        // storage rather than a machine and there is nothing to execute on.
        result = { result: await executeRepositoryTool(cleanToolName, args, workspacePath) };
        break;
      }

      case 'set_phase': {
        // Purely a narration event: nothing on disk changes, so the result is
        // deliberately terse. The value is in the transcript, not in the reply.
        const label = String(args.label ?? '').trim().replace(/[.!]+$/, '');
        if (!label) { result = { result: 'FAILED: set_phase needs a label.' }; break; }
        const detail = args.detail ? String(args.detail).trim() : undefined;
        onEvent?.({ type: 'phase', content: JSON.stringify({ label: label.slice(0, 80), detail, source: 'agent' }) });
        result = { result: `Phase set to "${label}". Carry on - do not call set_phase again until the work itself changes.` };
        break;
      }

      case 'update_plan': {
        // The plan is owned by the server (see planManager). This case only
        // translates the tool's arguments and reports back what happened —
        // including any coaching notes, which is how the model learns to use
        // set_status instead of retyping the list.
        if (!ctx?.sessionId) {
          result = { result: 'FAILED: no session is associated with this run, so there is nowhere to keep a plan.' };
          break;
        }
        const { applyPlanUpdate, renderPlanForModel, summarizePlan } = await import('../planManager');
        const outcome = applyPlanUpdate(ctx.sessionId, {
          steps: Array.isArray(args.steps) ? (args.steps as never[]) : undefined,
          setStatus: Array.isArray(args.set_status) ? (args.set_status as never[]) : undefined,
          addSteps: Array.isArray(args.add_steps) ? (args.add_steps as never[]) : undefined,
          removeSteps: Array.isArray(args.remove_steps) ? (args.remove_steps as string[]) : undefined,
          replace: args.replace === true,
          newPlan: args.new_plan === true,
        });

        // The client renders the plan widget from this event.
        onEvent?.({ type: 'plan_updated', content: JSON.stringify({ steps: outcome.steps }) });

        // Moving to a new in-progress step IS a phase change, and the agent has
        // already said what it is in the step's title. Deriving the phase from
        // it means a model that keeps a plan gets phase-labelled bursts without
        // spending a single extra call on set_phase.
        const nowActive = outcome.steps.find((st) => st.status === 'in_progress');
        if (nowActive && nowActive.title) {
          onEvent?.({ type: 'phase', content: JSON.stringify({ label: nowActive.title.slice(0, 80), source: 'plan' }) });
        }

        const body = [
          `Plan updated (${summarizePlan(outcome.steps)}):`,
          renderPlanForModel(outcome.steps),
          ...(outcome.notes.length > 0 ? ['', ...outcome.notes] : []),
        ].join('\n');
        result = { result: body };
        toolLogger.info('Plan updated', { steps: outcome.steps.length, notes: outcome.notes.length });
        break;
      }

      case 'artifact': {
        const action = String(args.action ?? 'write');

        if (action === 'list') {
          const all = listArtifacts(workspacePath);
          result = {
            result: all.length === 0
              ? 'No artifacts yet.'
              : all.map((a) => `${a.id} — "${a.title}" (${a.kind}, v${a.version}, ${a.bytes} bytes)`).join('\n'),
          };
          break;
        }

        if (action === 'read') {
          const a = readArtifact(workspacePath, String(args.id ?? ''));
          if (!a) { result = { result: `FAILED: no artifact "${String(args.id ?? '')}". Use action "list" to see what exists.` }; break; }
          const v = args.version != null ? Number(args.version) : undefined;
          const body = artifactContent(a, v);
          result = { result: body ? `"${a.title}" (${a.kind}${v ? `, v${v}` : ''}):\n\n${body}` : `FAILED: artifact "${a.id}" has no version ${v}.` };
          break;
        }

        const saved = saveArtifact(workspacePath, {
          id: String(args.id ?? args.title ?? ''),
          title: args.title != null ? String(args.title) : undefined,
          kind: args.kind as ArtifactKind | undefined,
          language: args.language != null ? String(args.language) : undefined,
          content: String(args.content ?? ''),
          note: args.note != null ? String(args.note) : undefined,
        });
        if (!saved.ok || !saved.artifact) { result = { result: `FAILED: ${saved.error}` }; break; }

        const a = saved.artifact;
        const latest = a.versions[a.versions.length - 1];
        // The card in the chat and the panel both come from this event. Sending
        // the content along means the panel can render immediately without a
        // round-trip back to the API for something we already have in hand.
        onEvent?.({
          type: 'artifact',
          content: JSON.stringify({
            id: a.id, title: a.title, kind: a.kind, language: a.language,
            version: latest.version, versionCount: a.versions.length,
            note: latest.note, body: latest.content, updatedAt: a.updatedAt,
          }),
        });
        result = {
          result: saved.created
            ? `Created artifact "${a.title}" (${a.id}, ${a.kind}). It's shown in the chat and in the Artifacts panel — don't repeat its contents in your reply.`
            : `Updated artifact "${a.title}" (${a.id}) to v${latest.version}. The user can compare it against earlier versions in the Artifacts panel.`,
        };
        toolLogger.info('Artifact written', { id: a.id, version: latest.version, created: saved.created });
        break;
      }

      case 'ask_user': {
        // The actual pause/wait is handled in the orchestrator (it has the WS
        // approval channel). Here we just format the question; the orchestrator
        // intercepts this tool before execution. This branch is a safe fallback.
        result = { result: `(awaiting user) ${String(args.question ?? '')}` };
        break;
      }

      case 'delegate_task': {
        // Normally intercepted by the orchestrator (lead agent). If a worker
        // sub-agent calls it, refuse to nest — workers do the work directly.
        result = { result: 'delegate_task is only available to the lead agent. Do the work directly with edit_file/write_file/run_command.' };
        break;
      }

      case 'delegate_parallel': {
        // Also lead-only; intercepted by the orchestrator. A worker reaching
        // here means nesting was attempted — refuse.
        result = { result: 'delegate_parallel is only available to the lead agent. Do the work directly with edit_file/write_file/run_command.' };
        break;
      }

      default: {
        toolLogger.warn('Unknown tool requested', { toolName });
        // Provide helpful correction for common mistakes
        const corrections: Record<string, string> = {
          'list_files': 'list_directory',
          'write': 'write_file',
          'read': 'read_file',
          'delete': 'delete_file',
          'mkdir': 'create_directory',
          'exec': 'run_command',
          'shell': 'run_command',
          'get_next_task_in_spec': 'get_next_task',
        };
        // Strip "function:" prefix that Ollama sometimes adds
        const cleanName = toolName.replace(/^function:/, '');
        const suggestion = corrections[cleanName] || corrections[toolName];
        
        if (suggestion) {
          result = { result: `Unknown tool: ${toolName}. Did you mean "${suggestion}"? Available tools: read_file, read_files, write_file, edit_file, delete_file, list_directory, get_file_tree, search, create_directory, run_command, run_background, watch, get_repo_map, find_symbol, find_references, gather_context` };
        } else {
          result = { result: `Unknown tool: ${toolName}. Available tools: read_file, read_files, write_file, edit_file, delete_file, list_directory, get_file_tree, search, create_directory, run_command, run_background, watch, get_repo_map, find_symbol, find_references, gather_context` };
        }
      }
    }
    
    const duration = Date.now() - startTime;
    toolLogger.debug('Tool execution completed', { 
      duration,
      resultLength: result.result.length 
    });
    
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;
    toolLogger.error('Tool execution failed', { 
      error: msg,
      duration,
      stack: err instanceof Error ? err.stack : undefined
    });
    return { result: `Error: ${msg}` };
  }
}
