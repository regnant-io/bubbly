import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger';

export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

function git(args: string[], cwd: string): { stdout: string; stderr: string; ok: boolean; notInstalled?: boolean } {
  const gitLogger = logger.child({ component: 'git' });

  gitLogger.debug('Git command executing', { args, cwd });

  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

  // git not on PATH (or not executable) → spawn error with ENOENT. Surface a
  // clear, actionable message instead of an empty stderr the caller can't read.
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const notInstalled = code === 'ENOENT';
    gitLogger.warn('Git command could not run', { args, error: result.error.message, code });
    return {
      stdout: '',
      stderr: notInstalled
        ? 'git is not installed or not on PATH. Install Git to use version-control features.'
        : result.error.message,
      ok: false,
      notInstalled,
    };
  }

  const ok = result.status === 0;

  if (!ok) {
    gitLogger.warn('Git command failed', {
      args,
      exitCode: result.status,
      stderr: result.stderr,
    });
  } else {
    gitLogger.debug('Git command succeeded', { args });
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok,
  };
}

export function getGitStatus(workspacePath: string): string {
  logger.debug('Getting git status', { workspacePath });
  
  const statusResult = git(['status', '--porcelain=v1', '-b'], workspacePath);
  if (!statusResult.ok && statusResult.stderr.includes('not a git repository')) {
    logger.debug('Not a git repository', { workspacePath });
    return 'Not a git repository';
  }
  
  logger.info('Git status retrieved', { workspacePath });
  return statusResult.stdout || 'Working tree clean';
}

export function getGitDiff(workspacePath: string, staged: boolean = false): string {
  logger.debug('Getting git diff', { workspacePath, staged });
  
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const result = git(args, workspacePath);
  
  logger.info('Git diff retrieved', { 
    workspacePath, 
    staged,
    hasChanges: !!result.stdout 
  });
  
  return result.stdout || 'No changes';
}

export function gitAdd(workspacePath: string, files: string[]): { success: boolean; message: string } {
  logger.info('Git add files', { workspacePath, fileCount: files.length, files });

  // Validate input — an empty/blank file list to `git add` is a no-op at best
  // and `git add` with no args errors; default to "." only if explicitly asked.
  const clean = (files ?? []).filter((f) => typeof f === 'string' && f.trim() !== '');
  if (clean.length === 0) {
    return { success: false, message: 'No files specified to stage.' };
  }

  // The `--` separator stops git from treating a filename that begins with "-"
  // (e.g. a file literally named "-rf") as an option.
  const result = git(['add', '--', ...clean], workspacePath);

  if (result.ok) {
    logger.info('Git add succeeded', { workspacePath, fileCount: clean.length });
  } else {
    logger.error('Git add failed', { workspacePath, files: clean, stderr: result.stderr });
  }

  return { success: result.ok, message: result.ok ? 'Files staged' : (result.stderr || 'git add failed') };
}

export function gitCommit(workspacePath: string, message: string): { success: boolean; message: string } {
  logger.info('Git commit', { workspacePath, commitMessage: message });

  if (!message || message.trim() === '') {
    return { success: false, message: 'A non-empty commit message is required.' };
  }

  const result = git(['commit', '-m', message], workspacePath);

  if (result.ok) {
    logger.info('Git commit succeeded', { workspacePath, commitMessage: message });
  } else {
    logger.error('Git commit failed', { workspacePath, commitMessage: message, stderr: result.stderr });
  }

  // "nothing to commit" and similar notices come back on stdout, so fall back
  // to it when stderr is empty — never return an empty message.
  return {
    success: result.ok,
    message: result.ok ? (result.stdout || 'Committed') : (result.stderr || result.stdout || 'git commit failed'),
  };
}

export function gitLog(workspacePath: string, n: number = 10): string {
  logger.debug('Getting git log', { workspacePath, commitCount: n });
  
  const result = git(
    ['log', `--oneline`, `-${n}`, '--decorate'],
    workspacePath
  );
  
  logger.info('Git log retrieved', { workspacePath, commitCount: n });
  return result.stdout || 'No commits';
}

export function isGitRepo(workspacePath: string): boolean {
  logger.debug('Checking if git repository', { workspacePath });
  
  const result = git(['rev-parse', '--is-inside-work-tree'], workspacePath);
  
  logger.debug('Git repository check result', { workspacePath, isRepo: result.ok });
  return result.ok;
}
