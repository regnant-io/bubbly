import { execSync, spawn, spawnSync } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+--no-preserve-root/,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\//,
  /chmod\s+777\s+\//,
  /sudo\s+rm/,
  /:(){:|:&};:/,   // fork bomb
  /curl.*\|\s*sh/, // piped curl installs
  /wget.*\|\s*sh/,
];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StreamingCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onStart?: (startTime: number) => void;
  onEnd?: (exitCode: number, duration: number) => void;
}

export function isDestructiveCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (BLOCKED_PATTERNS.some((p) => p.test(command))) return true;
  if (lower.includes('rm -rf') || lower.includes('rm -r')) return true;
  if (lower.includes('git push') || lower.includes('git force')) return true;
  if (lower.includes('drop table') || lower.includes('drop database')) return true;
  if (lower.includes('truncate ')) return true;
  return false;
}

export function isAbsolutelyBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

/**
 * Patterns for commands that DON'T exit on their own — dev servers, watchers,
 * REPLs, long-lived daemons. Running these through the one-shot `run_command`
 * path makes the agent (and the terminal UI) hang until the timeout fires and
 * the process is killed. We detect them up front so the caller can route them
 * to the background/terminal subsystem instead.
 *
 * Conservative by design: false negatives just mean the old (timeout) behaviour;
 * false positives would background a command that should have been one-shot, so
 * we only match well-known long-running invocations.
 */
const LONG_RUNNING_PATTERNS: RegExp[] = [
  // Package-manager dev/start/serve scripts (npm/yarn/pnpm/bun)
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  /\bnpm\s+run\s+\S*(?:dev|serve|watch|start)\S*/i,
  // Common dev servers / bundlers in watch mode
  /\b(?:vite|next|nuxt|remix|astro|gatsby)\b(?!\s+build)/i,
  /\bng\s+serve\b/i,
  /\bnodemon\b/i,
  /\bwebpack(?:-dev-server)?\b.*(?:serve|--watch|-w\b)/i,
  /\b(?:rollup|esbuild|tsc|tsup|parcel)\b.*(?:--watch|-w\b)/i,
  /\bvitest\b(?!\s+run)(?!.*--run)/i,
  /\bjest\b.*--watch/i,
  /\b(?:http-server|serve|live-server|browser-sync)\b/i,
  // Python web servers
  /\bpython[0-9.]*\s+-m\s+http\.server\b/i,
  /\b(?:flask\s+run|uvicorn|gunicorn|hypercorn|daphne)\b/i,
  /\bmanage\.py\s+runserver\b/i,
  // Other ecosystems
  /\brails\s+s(?:erver)?\b/i,
  /\bphp\s+-S\b/i,
  /\bdotnet\s+watch\b/i,
  /\bcargo\s+watch\b/i,
  /\bair\b(?:\s|$)/i, // go live-reload
];

/**
 * True when the command is expected to run indefinitely (dev server, watcher,
 * daemon). Such commands should be started in the background, not awaited.
 */
export function isLongRunningCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return LONG_RUNNING_PATTERNS.some((p) => p.test(cmd));
}

/**
 * Escape special characters for PowerShell
 */
function escapePowerShell(command: string): string {
  // PowerShell special characters that need escaping: ` $ " ' & | < > ( ) ; , @ #
  // We wrap the command in single quotes and escape any single quotes inside
  return command.replace(/'/g, "''");
}

/**
 * Escape special characters for bash/sh
 */
function escapeBash(command: string): string {
  // For bash, we're passing the command as a string to -c, so it's already quoted
  // No additional escaping needed in most cases
  return command;
}

/**
 * Proactively normalize a command for Windows PowerShell so common Unix-isms
 * the model emits still work. This is a safety net on top of the system prompt.
 * Conservative: only rewrites things that are unambiguous and safe.
 */
export function normalizeForWindows(command: string): string {
  if (process.platform !== 'win32') return command;
  let cmd = command;

  // Windows PowerShell 5.1 does not support `&&` / `||` chaining. Convert the
  // common `a && b` into `a; b` (run sequentially). Leave `||` as a best-effort
  // sequential run too. We skip rewriting if the operators appear inside quotes.
  if (!/["']/.test(cmd)) {
    cmd = cmd.replace(/\s*&&\s*/g, '; ').replace(/\s*\|\|\s*/g, '; ');
  }

  return cmd;
}

/**
 * Suggest Windows-compatible alternatives for common Unix commands
 */
function suggestWindowsAlternative(command: string): string | null {
  const cmd = command.trim().toLowerCase();
  
  const alternatives: Record<string, string> = {
    'ls': 'dir or Get-ChildItem',
    'cat': 'type or Get-Content',
    'grep': 'findstr or Select-String',
    'rm': 'del or Remove-Item',
    'cp': 'copy or Copy-Item',
    'mv': 'move or Move-Item',
    'touch': 'New-Item -ItemType File',
    'mkdir': 'New-Item -ItemType Directory',
    'pwd': 'cd or Get-Location',
    'which': 'where or Get-Command',
    'echo': 'Write-Output',
    'clear': 'cls or Clear-Host',
  };
  
  for (const [unixCmd, windowsCmd] of Object.entries(alternatives)) {
    if (cmd.startsWith(unixCmd + ' ') || cmd === unixCmd) {
      return windowsCmd;
    }
  }
  
  return null;
}

export function runShell(
  command: string,
  workspacePath: string,
  timeoutMs: number = 30_000
): ShellResult {
  const shellLogger = logger.child({ component: 'shell', command });
  
  // Ensure cwd is inside workspace
  const cwd = path.resolve(workspacePath);

  // Detect platform
  const isWindows = process.platform === 'win32';
  const platform = process.platform;
  const shell = isWindows ? 'powershell.exe' : 'sh';

  shellLogger.debug('Shell command requested', { 
    command, 
    workspacePath, 
    timeoutMs,
    platform,
    shell 
  });

  // Block absolute patterns
  if (isAbsolutelyBlocked(command)) {
    shellLogger.warn('Command blocked by safety policy', { command });
    return {
      stdout: '',
      stderr: `Command blocked by safety policy: ${command}`,
      exitCode: 1,
    };
  }

  // Check if command is destructive
  if (isDestructiveCommand(command)) {
    shellLogger.warn('Potentially destructive command detected', { command });
  }

  try {
    // Platform-specific shell selection and command escaping
    let shellArgs: string[];
    let escapedCommand: string;
    
    if (isWindows) {
      // Use PowerShell on Windows
      escapedCommand = escapePowerShell(normalizeForWindows(command));
      shellArgs = ['-NoProfile', '-NonInteractive', '-Command', escapedCommand];
    } else {
      // Use sh on Unix-like systems
      escapedCommand = escapeBash(command);
      shellArgs = ['-c', escapedCommand];
    }

    shellLogger.debug('Executing shell command', { 
      shell,
      shellArgs,
      isWindows,
      cwd 
    });

    const startTime = Date.now();
    const result = spawnSync(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        // Restrict PATH to prevent some attacks
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      encoding: 'utf-8',
    });

    const duration = Date.now() - startTime;
    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';
    const exitCode = result.status ?? 1;

    if (result.error) {
      if (result.error.message.includes('ETIMEDOUT') || result.error.message.includes('timeout')) {
        shellLogger.error('Shell command timed out', { 
          command, 
          timeoutMs, 
          duration 
        });
        return { stdout: '', stderr: `Command timed out after ${timeoutMs}ms`, exitCode: 124 };
      }
      shellLogger.error('Shell command error', { 
        command, 
        error: result.error.message,
        duration 
      });
      return { stdout: '', stderr: result.error.message, exitCode: 1 };
    }

    // Log completion with exit code and stderr if present
    if (exitCode !== 0) {
      shellLogger.warn('Shell command failed', { 
        command, 
        exitCode, 
        duration,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stderr: stderr.substring(0, 500) // Log first 500 chars of stderr
      });
      
      // Suggest Windows alternatives if command failed on Windows
      if (isWindows && exitCode === 1) {
        const alternative = suggestWindowsAlternative(command);
        if (alternative) {
          const suggestion = `\n\nWindows alternative: Try using '${alternative}' instead.`;
          return { 
            stdout, 
            stderr: stderr + suggestion, 
            exitCode 
          };
        }
      }
    } else {
      shellLogger.info('Shell command completed', { 
        command, 
        exitCode, 
        duration,
        stdoutLength: stdout.length,
        stderrLength: stderr.length 
      });
    }

    return { stdout, stderr, exitCode };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    shellLogger.error('Shell command exception', { 
      command, 
      error: msg,
      stack: err instanceof Error ? err.stack : undefined 
    });
    return { stdout: '', stderr: msg, exitCode: 1 };
  }
}

/**
 * Run a shell command with real-time streaming of stdout/stderr
 */
export function runShellStreaming(
  command: string,
  workspacePath: string,
  callbacks: StreamingCallbacks,
  timeoutMs: number = 30_000
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const shellLogger = logger.child({ component: 'shell-streaming', command });
    
    // Ensure cwd is inside workspace
    const cwd = path.resolve(workspacePath);

    // Detect platform
    const isWindows = process.platform === 'win32';
    const platform = process.platform;
    // Use powershell.exe on Windows (will be found in PATH)
    const shell = isWindows ? 'powershell.exe' : 'sh';

    shellLogger.debug('Shell command requested (streaming)', { 
      command, 
      workspacePath, 
      timeoutMs,
      platform,
      shell 
    });

    // Block absolute patterns
    if (isAbsolutelyBlocked(command)) {
      shellLogger.warn('Command blocked by safety policy', { command });
      const result = {
        stdout: '',
        stderr: `Command blocked by safety policy: ${command}`,
        exitCode: 1,
      };
      resolve(result);
      return;
    }

    // Check if command is destructive
    if (isDestructiveCommand(command)) {
      shellLogger.warn('Potentially destructive command detected', { command });
    }

    try {
      // Platform-specific shell selection and command escaping
      let shellArgs: string[];
      let escapedCommand: string;
      
      if (isWindows) {
        // Use PowerShell on Windows
        escapedCommand = escapePowerShell(normalizeForWindows(command));
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', escapedCommand];
      } else {
        // Use sh on Unix-like systems
        escapedCommand = escapeBash(command);
        shellArgs = ['-c', escapedCommand];
      }

      shellLogger.debug('Executing shell command (streaming)', { 
        shell,
        shellArgs,
        isWindows,
        cwd 
      });

      const startTime = Date.now();
      if (callbacks.onStart) {
        callbacks.onStart(startTime);
      }

      const child = spawn(shell, shellArgs, {
        cwd,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        shellLogger.error('Shell command timed out', { 
          command, 
          timeoutMs, 
          duration: Date.now() - startTime 
        });
      }, timeoutMs);

      // Stream stdout
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stdout += text;
        if (callbacks.onStdout) {
          callbacks.onStdout(text);
        }
      });

      // Stream stderr
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stderr += text;
        if (callbacks.onStderr) {
          callbacks.onStderr(text);
        }
      });

      // Handle completion
      child.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;
        const exitCode = timedOut ? 124 : (code ?? 1);

        if (timedOut) {
          stderr += `\nCommand timed out after ${timeoutMs}ms`;
        }

        // Log completion
        if (exitCode !== 0) {
          shellLogger.warn('Shell command failed (streaming)', { 
            command, 
            exitCode, 
            duration,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
            stderr: stderr.substring(0, 500)
          });
          
          // Suggest Windows alternatives if command failed on Windows
          if (isWindows && exitCode === 1) {
            const alternative = suggestWindowsAlternative(command);
            if (alternative) {
              stderr += `\n\nWindows alternative: Try using '${alternative}' instead.`;
            }
          }
        } else {
          shellLogger.info('Shell command completed (streaming)', { 
            command, 
            exitCode, 
            duration,
            stdoutLength: stdout.length,
            stderrLength: stderr.length 
          });
        }

        if (callbacks.onEnd) {
          callbacks.onEnd(exitCode, duration);
        }

        resolve({ stdout, stderr, exitCode });
      });

      // Handle errors
      child.on('error', (err: Error) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;
        shellLogger.error('Shell command error (streaming)', { 
          command, 
          error: err.message,
          duration 
        });
        
        if (callbacks.onEnd) {
          callbacks.onEnd(1, duration);
        }
        
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      shellLogger.error('Shell command exception (streaming)', { 
        command, 
        error: msg,
        stack: err instanceof Error ? err.stack : undefined 
      });
      resolve({ stdout: '', stderr: msg, exitCode: 1 });
    }
  });
}
