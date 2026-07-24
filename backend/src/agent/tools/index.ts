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
  searchInFiles,
  regexSearchInFiles,
  fuzzyFileSearch,
  createDirectory,
} from './filesystem';
import { backgroundProcesses } from './backgroundProcess';
import { createCheckpoint, listCheckpoints, revertToCheckpoint } from './checkpoint';
import { runShell, runShellStreaming, isDestructiveCommand, isLongRunningCommand } from './shell';
import { runComputerAction, validateComputerAction, isComputerControlEnabled, type ComputerActionParams } from './computerControl';
import {
  runBrowserAction, validateBrowserAction, isBrowserControlEnabled,
  readRunConfig, writeRunConfig, describeRunConfig,
  type BrowserActionParams, type RunService,
} from './browserControl';
import { watchers, describeCondition, type WatchCondition, type WatchResult } from './watchers';
import { getSetting } from '../../db/index';
import { supportsVision } from '../../models/capabilities';
import { resolveModelVision } from '../../models/ollama';
import { getGitStatus, getGitDiff, gitAdd, gitCommit, gitLog } from './git';
import { 
  createSpec, 
  readSpec, 
  listSpecs, 
  updateSpec, 
  addTaskToSpec,
  updateTaskStatus,
  getNextTask,
  setSpecDesign,
  approveSpecPhase,
  addSubTasks,
} from './specs';
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
    name: 'search_in_files',
    description: 'Search for a text pattern across files in the workspace. Returns matching lines with file and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive)' },
        path: { type: 'string', description: 'Subdirectory to search in. Defaults to workspace root.' },
        file_pattern: { type: 'string', description: 'Optional file name pattern to filter (e.g. ".ts", ".py")' },
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
    description: 'Run a one-shot shell command in the workspace directory (tests, installs, builds, linting). Commands are sandboxed to the workspace and time-bounded. Dev servers, watchers and other commands that never exit are detected automatically and started in the background instead of blocking — read their logs with get_process_output. Set foreground:true only if you truly need to await a normally-long-running command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
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
    name: 'create_spec',
    description: 'Create a new spec (feature, bugfix, refactor, or research) with requirements AND tasks. Always include tasks when creating a spec so they can be tracked and executed. Requirements are automatically converted into testable EARS-style acceptance properties. For best results, provide rich tasks (with target files and acceptance criteria) via the "task_details" parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the spec' },
        type: {
          type: 'string',
          enum: ['feature', 'bugfix', 'refactor', 'research'],
          description: 'Type of spec',
        },
        requirements: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of requirements or acceptance criteria. Each becomes a testable EARS property.',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Simple ordered list of task titles. Use this OR task_details, not both.',
        },
        task_details: {
          type: 'array',
          description: 'Rich ordered tasks. Preferred over "tasks". Each task can declare target files, dependencies, satisfied properties, and a concrete acceptance criterion.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title (a single implementable unit)' },
              target_files: { type: 'array', items: { type: 'string' }, description: 'Files this task will create or modify (relative paths)' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'Titles of tasks that must finish first (matched loosely)' },
              acceptance: { type: 'string', description: 'Concrete, checkable definition of done' },
            },
            required: ['title'],
          },
        },
        notes: { type: 'string', description: 'Optional additional notes' },
        staged: { type: 'boolean', description: 'When true, use the staged three-document workflow: the spec starts at the requirements phase and you must get user approval before authoring design, then tasks. Do NOT pass tasks when staged — add them after the design is approved. Strongly preferred for non-trivial features.' },
        start_phase: { type: 'string', description: 'Staged start point: "requirements" (default) or "design" for a user-chosen design-first flow. Only meaningful when staged is true.' },
      },
      required: ['title', 'type', 'requirements'],
    },
  },
  {
    name: 'read_spec',
    description: 'Read an existing spec by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID to read' },
      },
      required: ['spec_id'],
    },
  },
  {
    name: 'list_specs',
    description: 'List all specs in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_spec_status',
    description: 'Update the status of a spec.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        status: {
          type: 'string',
          enum: ['draft', 'in_progress', 'done', 'cancelled'],
          description: 'New status',
        },
      },
      required: ['spec_id', 'status'],
    },
  },
  {
    name: 'add_spec_task',
    description: 'Add a task to an existing spec.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        task_title: { type: 'string', description: 'Task title' },
      },
      required: ['spec_id', 'task_title'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Update the status of a specific task in a spec. Use this to mark tasks as in_progress or done as you work on them.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        task_id: { type: 'string', description: 'Task ID' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: 'New task status',
        },
      },
      required: ['spec_id', 'task_id', 'status'],
    },
  },
  {
    name: 'get_next_task',
    description: 'Get the next task to execute from a spec (first task with status "todo"). Use this in Spec Session threads to know what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
      },
      required: ['spec_id'],
    },
  },
  {
    name: 'set_spec_design',
    description: 'Save the design document for a spec programmatically. NOTE: in a normal Spec Session you do NOT need this — just WRITE the design as markdown in your reply and it is captured automatically. Only use this tool if you specifically need to set/replace the design text directly. Requires that requirements were approved first.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        design: { type: 'string', description: 'The full design document in markdown.' },
      },
      required: ['spec_id', 'design'],
    },
  },
  {
    name: 'approve_spec_phase',
    description: 'Record the USER\'s approval of the current spec phase and advance to the next (requirements → design → tasks → ready). Only call this AFTER you have presented the document for that phase and the user has explicitly approved it. Never approve on the user\'s behalf. Returns the next phase you may author.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        phase: { type: 'string', enum: ['requirements', 'design', 'tasks'], description: 'The phase the user just approved' },
      },
      required: ['spec_id', 'phase'],
    },
  },
  {
    name: 'add_sub_tasks',
    description: 'Break a task into smaller ordered sub-tasks. Use when a task is too big to implement and verify as one unit. Each sub-task should be independently checkable.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_id: { type: 'string', description: 'Spec ID' },
        task_id: { type: 'string', description: 'The parent task ID' },
        sub_tasks: {
          type: 'array',
          description: 'Ordered sub-tasks',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Sub-task title' },
              acceptance: { type: 'string', description: 'Concrete definition of done' },
            },
            required: ['title'],
          },
        },
      },
      required: ['spec_id', 'task_id', 'sub_tasks'],
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
    description: 'Find where a function, class, interface, type, or method is DECLARED by name. Returns file path, line number, and signature. Use this instead of grepping when you know the name of something. Much more precise than search_in_files.',
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
    name: 'update_plan',
    description: 'Maintain your working plan / todo list. Call this to lay out the steps you intend to take, and again to mark steps done or revise the plan as you learn more. This is YOUR scratchpad — you decide the steps and change them freely. The UI shows it as live progress. Use it for any non-trivial task so the user can follow along, but you are NOT forced to follow it rigidly.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The ordered list of steps. Provide the FULL list each time (it replaces the previous plan).',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short description of the step' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done'], description: 'Step status' },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
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
    name: 'grep_search',
    description: 'Search file contents with a REGEX pattern (Rust/JS-style). Returns file:line matches with optional surrounding context. Much more powerful than search_in_files: supports anchors (^import), quantifiers (function\\s+\\w+), case sensitivity, include/exclude globs, and context lines. Use this to find code by pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Subdirectory to search in (default workspace root)' },
        include: { type: 'string', description: 'Glob of files to include, e.g. "**/*.ts"' },
        exclude: { type: 'string', description: 'Glob of files to exclude, e.g. "**/*.test.ts"' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' },
        context_lines: { type: 'number', description: 'Lines of context around each match (0-5)' },
        max_results: { type: 'number', description: 'Max matches to return (default 100)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description: 'Fuzzy-find files by name/path when you know roughly what the file is called but not its exact location (e.g. "scraper" or "userModel"). Returns ranked relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fuzzy filename/path query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_background',
    description: 'Start a LONG-RUNNING command (dev server, test watcher, build) as a background process and return immediately with a process id. Use this for anything that does not exit on its own — NOT run_command (which is one-shot and times out). After starting, use get_process_output to read its logs and stop_process to terminate it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the background (e.g. "npm run dev", "uvicorn main:app")' },
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
      'Be told when something finishes, WITHOUT polling. Use sparingly — only when you genuinely cannot continue until the outcome is known.\n' +
      'DO NOT call this just because you started a background process. Starting a dev server or a build does not require waiting on it; carry on with other work.\n' +
      'TWO MODES:\n' +
      '  • Short gate (default): blocks, but is HARD-CAPPED AT 60 SECONDS because it freezes the session. Only for a quick precondition, e.g. a port opening before you load the page.\n' +
      '  • detached:true — registers the watcher and returns immediately. Use this for anything slow (builds, installs, test suites). Then FINISH YOUR TURN; you will be resumed with the result when it settles. Requesting a timeout over 60s automatically becomes detached.\n' +
      'Detached results survive the end of the run that created them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['wait', 'collect', 'list', 'cancel'],
          description: '"wait" (default) creates a watcher. "collect" returns any detached watchers that have since finished. "list" shows active watchers. "cancel" stops one.',
        },
        condition: {
          type: 'string',
          enum: ['process_exit', 'output_match', 'url_live', 'port_open', 'file_exists'],
          description: 'What to wait for. process_exit = a run_background command finishes. output_match = a regex appears in its output (best for dev servers that never exit, e.g. "compiled successfully"). url_live = an HTTP URL responds. port_open = a TCP port accepts connections. file_exists = a path appears.',
        },
        process_id: { type: 'string', description: 'For process_exit / output_match: the id from run_background.' },
        pattern: { type: 'string', description: 'For output_match: a regex, case-insensitive. e.g. "ready in|compiled successfully|listening on".' },
        url: { type: 'string', description: 'For url_live: e.g. "http://localhost:5173".' },
        port: { type: 'number', description: 'For port_open: e.g. 5173.' },
        path: { type: 'string', description: 'For file_exists: absolute or workspace-relative path.' },
        timeout_seconds: { type: 'number', description: 'How long to wait before giving up. Default 300, max 1800. Use a realistic figure — a big build deserves 900.' },
        detached: { type: 'boolean', description: 'If true, return immediately and collect the result later instead of blocking.' },
        watcher_id: { type: 'string', description: 'For cancel: the watcher id.' },
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
const BLOCKING_WATCH_CAP_MS = 60_000;

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
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  // Clean up tool name - Ollama sometimes prefixes with "function:"
  const cleanToolName = toolName.replace(/^function:/, '');
  const toolLogger = logger.child({ tool: cleanToolName, component: 'tool-execution' });
  
  toolLogger.debug('Tool execution started', { args, originalName: toolName });
  const startTime = Date.now();
  
  try {
    let result: ToolExecutionResult;
    
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

      case 'grep_search': {
        const r = regexSearchInFiles(workspacePath, String(args.pattern), {
          searchPath: args.path ? String(args.path) : undefined,
          includeGlob: args.include ? String(args.include) : undefined,
          excludeGlob: args.exclude ? String(args.exclude) : undefined,
          caseSensitive: args.case_sensitive === true,
          contextLines: args.context_lines ? Number(args.context_lines) : 0,
          maxResults: args.max_results ? Number(args.max_results) : 100,
        });
        if (r.error) {
          result = { result: r.error };
        } else if (r.matches.length === 0) {
          result = { result: `No matches for /${args.pattern}/.` };
        } else {
          const body = r.matches
            .map((m) => (m.context ? `${m.file}:${m.line}\n${m.context}` : `${m.file}:${m.line}: ${m.text}`))
            .join(r.matches[0].context ? '\n\n' : '\n');
          result = { result: body + (r.truncated ? '\n\n[truncated: too many matches — narrow your pattern]' : '') };
        }
        toolLogger.debug('Regex search', { pattern: args.pattern, matches: r.matches.length });
        break;
      }

      case 'find_files': {
        const hits = fuzzyFileSearch(workspacePath, String(args.query), args.limit ? Number(args.limit) : 20);
        result = { result: hits.length > 0 ? hits.map((h) => h.path).join('\n') : `No files matching "${args.query}".` };
        break;
      }

      case 'run_background': {
        const r = backgroundProcesses.start(String(args.command), workspacePath, (url) => {
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

        // action === 'wait' — build the condition from the flat args.
        const kind = String(args.condition ?? '');
        const condition: WatchCondition | null =
          kind === 'process_exit' ? { kind: 'process_exit', processId: String(args.process_id ?? '') }
          : kind === 'output_match' ? { kind: 'output_match', processId: String(args.process_id ?? ''), pattern: String(args.pattern ?? '') }
          : kind === 'url_live' ? { kind: 'url_live', url: String(args.url ?? '') }
          : kind === 'port_open' ? { kind: 'port_open', port: Number(args.port) }
          : kind === 'file_exists' ? { kind: 'file_exists', path: path.resolve(workspacePath, String(args.path ?? '')) }
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
        });
        if (!created.ok) { result = { result: `FAILED: ${created.error}` }; break; }

        if (detached) {
          result = { result:
            `Watcher ${created.id} is running in the background (${describeCondition(condition)}).\n` +
            `Do NOT wait for it — finish what you can and end your turn. You'll be resumed with the result when it settles.` };
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

      case 'search_in_files': {
        const matches = searchInFiles(
          workspacePath,
          String(args.query),
          String(args.path ?? '.'),
          args.file_pattern ? String(args.file_pattern) : undefined
        );
        if (matches.length === 0) {
          result = { result: 'No matches found.' };
        } else {
          const formatted = matches
            .map((m) => `${m.file}:${m.line}: ${m.content}`)
            .join('\n');
          result = { result: formatted };
        }
        toolLogger.debug('Search completed', { 
          query: args.query, 
          matchCount: matches.length 
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

        // Guard against the classic hang: if the model routes a dev server /
        // watcher / daemon through the one-shot path, it would block until the
        // timeout fires and then get killed. Detect those and start them in the
        // background instead, returning immediately with a process id the agent
        // can poll via get_process_output. The model can opt out with
        // foreground:true for the rare case it truly wants to await one.
        const forceForeground = args.foreground === true;
        if (!forceForeground && isLongRunningCommand(command)) {
          toolLogger.info('Long-running command detected — routing to background', { command, commandId });
          const r = backgroundProcesses.start(command, workspacePath);
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
            Number(args.timeout_ms ?? 30000)
          );
          
          // stderr is clamped less aggressively than stdout: when a command
          // fails, the reason is almost always in stderr, and it's usually short.
          let out = '';
          if (result.stdout) out += `stdout:\n${clampOutput(result.stdout)}\n`;
          if (result.stderr) out += `stderr:\n${clampOutput(result.stderr)}\n`;
          out += `exit code: ${result.exitCode}`;

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
            Number(args.timeout_ms ?? 30000)
          );
          let out = '';
          if (stdout) out += `stdout:\n${clampOutput(stdout)}\n`;
          if (stderr) out += `stderr:\n${clampOutput(stderr)}\n`;
          out += `exit code: ${exitCode}`;
          
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

      case 'create_spec': {
        const spec = createSpec(workspacePath, {
          title: String(args.title),
          type: (args.type as 'feature' | 'bugfix' | 'refactor' | 'research') ?? 'feature',
          requirements: args.requirements,
          notes: args.notes ? String(args.notes) : undefined,
          staged: args.staged === true || args.staged === 'true',
          startPhase: args.start_phase === 'design' ? 'design' : undefined,
        });

        // STAGED WORKFLOW: when staged, the spec begins at the requirements
        // phase and tasks are NOT created up front. The agent presents
        // requirements, gets approval, authors design, gets approval, THEN adds
        // tasks. So if staged, ignore any tasks passed in this call.
        const staged = spec.phase === 'requirements';
        if (staged) {
          const propList = (spec.properties ?? []).map((p) => `  - ${p.id}: ${p.statement}`).join('\n');
          result = {
            result: `Spec created (staged): ${spec.id} — "${spec.title}"\nPhase: requirements\n\nAcceptance properties (${(spec.properties ?? []).length}):\n${propList || '  (none)'}\n\nNEXT: Present these requirements to the user for review. When they approve, call approve_spec_phase("${spec.id}", "requirements"), then author the design with set_spec_design. Do NOT create tasks yet.`,
            spec,
          };
          toolLogger.info('Staged spec created (requirements phase)', { specId: spec.id, title: spec.title });
          break;
        }

        // Rich task details take precedence; fall back to simple titles.
        const richTasks = (args.task_details as Array<{
          title: string;
          target_files?: string[];
          depends_on?: string[];
          acceptance?: string;
        }>) ?? [];
        const taskTitles = (args.tasks as string[]) ?? [];

        let updatedSpec = spec;

        if (richTasks.length > 0) {
          // First pass: create tasks (so we can resolve depends_on titles → ids).
          const titleToId = new Map<string, string>();
          for (const rt of richTasks) {
            const s = addTaskToSpec(workspacePath, spec.id, rt.title, {
              targetFiles: rt.target_files,
              acceptance: rt.acceptance,
            });
            if (s) {
              updatedSpec = s;
              const created = s.tasks[s.tasks.length - 1];
              if (created) titleToId.set(rt.title.toLowerCase(), created.id);
            }
          }
          // Second pass: resolve dependencies by matching titles loosely.
          const withDeps = updatedSpec.tasks.map((t) => {
            const rt = richTasks.find((r) => r.title.toLowerCase() === t.title.toLowerCase());
            if (rt?.depends_on && rt.depends_on.length > 0) {
              const depIds = rt.depends_on
                .map((d) => {
                  const exact = titleToId.get(d.toLowerCase());
                  if (exact) return exact;
                  const fuzzy = updatedSpec.tasks.find(
                    (x) => x.title.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(x.title.toLowerCase())
                  );
                  return fuzzy?.id;
                })
                .filter((x): x is string => !!x && x !== t.id);
              return { ...t, dependsOn: depIds.length > 0 ? depIds : undefined };
            }
            return t;
          });
          const s = updateSpec(workspacePath, spec.id, { tasks: withDeps, status: 'in_progress' });
          if (s) updatedSpec = s;
        } else if (taskTitles.length > 0) {
          for (const taskTitle of taskTitles) {
            const s = addTaskToSpec(workspacePath, spec.id, taskTitle);
            if (s) updatedSpec = s;
          }
          const s = updateSpec(workspacePath, spec.id, { status: 'in_progress' });
          if (s) updatedSpec = s;
        }

        const taskList = updatedSpec.tasks.map((t, i) => {
          const deps = t.dependsOn && t.dependsOn.length > 0 ? ` (after ${t.dependsOn.join(', ')})` : '';
          const files = t.targetFiles && t.targetFiles.length > 0 ? ` → ${t.targetFiles.join(', ')}` : '';
          return `  ${i + 1}. [${t.id}] ${t.title}${files}${deps}`;
        }).join('\n');
        const propList = (updatedSpec.properties ?? []).map((p) => `  - ${p.id}: ${p.statement}`).join('\n');
        result = {
          result: `Spec created: ${updatedSpec.id} — "${updatedSpec.title}"\n\nAcceptance properties (${(updatedSpec.properties ?? []).length}):\n${propList || '  (none)'}\n\nTasks (${updatedSpec.tasks.length}):\n${taskList}\n\nUse get_next_task("${updatedSpec.id}") to start executing.`,
          spec: updatedSpec,
        };
        toolLogger.info('Spec created with tasks', { specId: updatedSpec.id, title: updatedSpec.title, taskCount: updatedSpec.tasks.length, propertyCount: (updatedSpec.properties ?? []).length });
        break;
      }

      case 'read_spec': {
        const spec = readSpec(workspacePath, String(args.spec_id));
        if (!spec) {
          result = { result: `Spec not found: ${args.spec_id}` };
        } else {
          result = { result: JSON.stringify(spec, null, 2), spec };
        }
        break;
      }

      case 'list_specs': {
        const specs = listSpecs(workspacePath);
        if (specs.length === 0) {
          result = { result: 'No specs found.' };
        } else {
          const summary = specs.map((s) => `[${s.status}] ${s.id}: ${s.title}`).join('\n');
          result = { result: summary };
        }
        break;
      }

      case 'update_spec_status': {
        const spec = updateSpec(workspacePath, String(args.spec_id), {
          status: args.status as 'draft' | 'in_progress' | 'done' | 'cancelled',
        });
        if (!spec) {
          result = { result: `Spec not found: ${args.spec_id}` };
        } else {
          result = { result: `Spec status updated: ${spec.id} → ${spec.status}`, spec };
          toolLogger.info('Spec status updated', { 
            specId: spec.id, 
            status: spec.status 
          });
        }
        break;
      }

      case 'add_spec_task': {
        const spec = addTaskToSpec(workspacePath, String(args.spec_id), String(args.task_title));
        if (!spec) {
          result = { result: `Spec not found: ${args.spec_id}` };
        } else {
          result = { result: `Task added to spec ${spec.id}: "${args.task_title}"`, spec };
          toolLogger.info('Task added to spec', { 
            specId: spec.id, 
            taskTitle: args.task_title 
          });
        }
        break;
      }

      case 'update_task_status': {
        let specIdForUpdate = String(args.spec_id);
        let taskIdForUpdate = String(args.task_id);
        
        // Try exact match first
        let specForUpdate = readSpec(workspacePath, specIdForUpdate);
        
        // If not found, try to find spec by partial ID match
        if (!specForUpdate) {
          const allSpecs = listSpecs(workspacePath);
          const partialMatch = allSpecs.find(s => 
            s.id.includes(specIdForUpdate) || specIdForUpdate.includes(s.id)
          );
          if (partialMatch) {
            specForUpdate = partialMatch;
            specIdForUpdate = partialMatch.id;
            toolLogger.info('Resolved partial spec_id', { original: args.spec_id, resolved: specIdForUpdate });
          }
        }
        
        if (!specForUpdate) {
          result = { result: `Spec not found: ${args.spec_id}. Use list_specs to see available specs.` };
          break;
        }
        
        // Try exact task_id match first
        let taskMatch = specForUpdate.tasks.find(t => t.id === taskIdForUpdate);
        
        // If not found, try partial task_id match
        if (!taskMatch) {
          taskMatch = specForUpdate.tasks.find(t => 
            t.id.includes(taskIdForUpdate) || taskIdForUpdate.includes(t.id)
          );
          if (taskMatch) {
            taskIdForUpdate = taskMatch.id;
            toolLogger.info('Resolved partial task_id', { original: args.task_id, resolved: taskIdForUpdate });
          }
        }
        
        if (!taskMatch) {
          // Show available tasks to help the model
          const taskList = specForUpdate.tasks.map(t => `  - ${t.id}: ${t.title} (${t.status})`).join('\n');
          result = { result: `Task not found: ${args.task_id} in spec ${specIdForUpdate}.\n\nAvailable tasks:\n${taskList}` };
          break;
        }
        
        // Enforce a single in-progress task, but NEVER mark another task 'done'
        // without verification. If the model starts a new task while another is
        // in_progress, revert the old one to 'todo' (clearly unfinished) rather
        // than silently (and falsely) completing it.
        if (args.status === 'in_progress') {
          for (const other of specForUpdate.tasks) {
            if (other.id !== taskIdForUpdate && other.status === 'in_progress') {
              updateTaskStatus(workspacePath, specIdForUpdate, other.id, 'todo');
              toolLogger.info('Reverted previously in_progress task to todo (not verified done)', {
                specId: specIdForUpdate, taskId: other.id, taskTitle: other.title,
              });
            }
          }
        }

        const updatedSpecResult = updateTaskStatus(
          workspacePath, 
          specIdForUpdate, 
          taskIdForUpdate,
          args.status as 'todo' | 'in_progress' | 'done'
        );
        if (!updatedSpecResult) {
          result = { result: `Failed to update task status` };
        } else {
          result = { 
            result: `Task "${taskMatch.title}" -> ${args.status}`, 
            spec: updatedSpecResult 
          };
          toolLogger.info('Task status updated', { 
            specId: specIdForUpdate, 
            taskId: taskIdForUpdate,
            status: args.status 
          });
        }
        break;
      }

      case 'get_next_task': {
        const specIdStr = String(args.spec_id);
        const spec = readSpec(workspacePath, specIdStr);
        if (!spec) {
          result = { result: `Spec not found: ${specIdStr}` };
          break;
        }

        // IMPORTANT: never auto-complete an in_progress task. A task is only
        // 'done' after it is genuinely implemented AND verified. If one is
        // already in_progress, return THAT task so work resumes on it instead
        // of silently (and falsely) marking it complete.
        const inProgress = spec.tasks.find((t) => t.status === 'in_progress');
        if (inProgress) {
          const done = spec.tasks.filter((t) => t.status === 'done').length;
          result = {
            result: `Task [${inProgress.id}] "${inProgress.title}" is still in progress (${done}/${spec.tasks.length} done). Finish and verify it, then mark it done with update_task_status(status="done"). Do NOT start another task until this one is verified complete.`,
            spec,
          };
          break;
        }

        const nextTask = getNextTask(workspacePath, specIdStr);
        if (!nextTask) {
          const done = spec.tasks.filter(t => t.status === 'done').length;
          result = { result: `All ${done} tasks complete in spec "${spec.title}". Nice work!` };
        } else {
          const done = spec.tasks.filter(t => t.status === 'done').length;
          const total = spec.tasks.length;

          let taskInfo = `Progress: ${done}/${total} tasks done\n\n`;
          taskInfo += `**Next task:** [${nextTask.id}] ${nextTask.title}\n`;
          if (nextTask.acceptance) taskInfo += `Done when: ${nextTask.acceptance}\n`;
          if (nextTask.subTasks && nextTask.subTasks.length > 0) {
            taskInfo += `Sub-tasks:\n` + nextTask.subTasks.map((s) => `  - [${s.status === 'done' ? 'x' : ' '}] ${s.title}`).join('\n') + '\n';
          }
          taskInfo += `\nTo execute this task:\n`;
          taskInfo += `1. Call update_task_status with spec_id="${specIdStr}", task_id="${nextTask.id}", status="in_progress"\n`;
          taskInfo += `2. Delegate the implementation with delegate_task (give the instruction, target files, and the acceptance criterion). The worker writes/edits/validates.\n`;
          taskInfo += `3. When the worker reports done, mark it done. It will be verified before the next task starts.\n`;

          result = { result: taskInfo, spec };
          toolLogger.info('Next task retrieved', {
            specId: specIdStr,
            taskId: nextTask.id,
            taskTitle: nextTask.title,
            progress: `${done}/${total}`
          });
        }
        break;
      }

      case 'set_spec_design': {
        const r = setSpecDesign(workspacePath, String(args.spec_id), String(args.design));
        if (!r.ok) {
          result = { result: r.error ?? 'Failed to set design.' };
        } else {
          result = {
            result: `Design saved for "${r.spec!.title}" (design.md). NEXT: present the design to the user. When they approve, call approve_spec_phase("${r.spec!.id}", "design"), then break the work into tasks with create_spec task_details or add_spec_task / add_sub_tasks.`,
            spec: r.spec,
          };
          toolLogger.info('Spec design saved', { specId: r.spec!.id });
        }
        break;
      }

      case 'approve_spec_phase': {
        const r = approveSpecPhase(workspacePath, String(args.spec_id), args.phase as 'requirements' | 'design' | 'tasks');
        if (!r.ok) {
          result = { result: r.error ?? 'Failed to approve phase.' };
        } else if (r.alreadyAdvanced) {
          // Redundant approval — tell the agent the truth and the real next action.
          result = { result: r.error ?? `Already advanced to ${r.nextPhase}.`, spec: r.spec };
          toolLogger.warn('Redundant approve_spec_phase call', { specId: String(args.spec_id), phase: args.phase, currentPhase: r.nextPhase });
        } else {
          const next = r.nextPhase;
          const guidance = next === 'design'
            ? 'Now write the design: read requirements if needed, then write the full design document directly in your reply as markdown. The app saves it automatically — do not call a tool and do not stop after only announcing it.'
            : next === 'tasks'
            ? 'Now break the design into concrete tasks (add_spec_task / create task_details). Use add_sub_tasks for any task that needs decomposition. When the task list is ready, present it for approval.'
            : next === 'ready'
            ? 'The spec is fully approved and ready to execute. Begin implementing tasks in dependency order.'
            : '';
          result = { result: `Approved "${args.phase}". Phase advanced to "${next}". ${guidance}`, spec: r.spec };
          toolLogger.info('Spec phase approved', { specId: String(args.spec_id), approved: args.phase, nextPhase: next });
        }
        break;
      }

      case 'add_sub_tasks': {
        const subs = (args.sub_tasks as Array<{ title: string; acceptance?: string }>) ?? [];
        const spec = addSubTasks(workspacePath, String(args.spec_id), String(args.task_id), subs);
        if (!spec) {
          result = { result: `Could not add sub-tasks: spec or task not found (${args.spec_id} / ${args.task_id}).` };
        } else {
          result = { result: `Added ${subs.length} sub-task(s) to task ${args.task_id}.`, spec };
          toolLogger.info('Sub-tasks added', { specId: String(args.spec_id), taskId: String(args.task_id), count: subs.length });
        }
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
          result = { result: `No symbol matching "${name}" found. Try get_repo_map or search_in_files.` };
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

      case 'update_plan': {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        const normalized = steps.map((s: any) => ({
          title: String(s.title ?? ''),
          status: (['todo', 'in_progress', 'done'].includes(s.status) ? s.status : 'todo') as 'todo' | 'in_progress' | 'done',
        }));
        // Surface the plan to the UI as a live progress list.
        onEvent?.({ type: 'plan_updated', content: JSON.stringify({ steps: normalized }) });
        const done = normalized.filter((s) => s.status === 'done').length;
        const summary = normalized.map((s) => `${s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '○'} ${s.title}`).join('\n');
        result = { result: `Plan updated (${done}/${normalized.length} done):\n${summary}` };
        toolLogger.info('Plan updated', { steps: normalized.length, done });
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
          result = { result: `Unknown tool: ${toolName}. Did you mean "${suggestion}"? Available tools: read_file, write_file, delete_file, list_directory, get_file_tree, search_in_files, create_directory, run_command, create_spec, read_spec, list_specs, add_spec_task, update_task_status, get_next_task, gather_context` };
        } else {
          result = { result: `Unknown tool: ${toolName}. Available tools: read_file, write_file, delete_file, list_directory, get_file_tree, search_in_files, create_directory, run_command, create_spec, read_spec, list_specs, add_spec_task, update_task_status, get_next_task, gather_context` };
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
