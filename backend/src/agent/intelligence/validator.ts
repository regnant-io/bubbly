/**
 * Deterministic Validation Layer (dream.md "Validation Engine").
 *
 * Before relying on an LLM to judge correctness, we run cheap, deterministic
 * checks that catch the most common breakage: unbalanced brackets, obvious
 * syntax errors, and — when a real toolchain is available — actual compiler /
 * linter output. This feeds the repair loop with concrete, grounded errors,
 * which is exactly what weak models need (they can fix a specific error far
 * more reliably than they can self-assess "is this correct?").
 *
 * All checks are best-effort and fail-open: if a tool isn't installed we skip
 * it rather than blocking the agent.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from '../../utils/logger';
import { detectLanguage } from './symbols';

export interface ValidationIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning';
  message: string;
  source: 'syntax' | 'typescript' | 'build' | 'lint';
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  checkedWith: string[];
  summary: string;
}

/** Quick structural check: balanced brackets/quotes for a single file's text. */
export function checkBalancedDelimiters(filePath: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lang = detectLanguage(filePath);
  // Only meaningful for brace languages.
  if (!['typescript', 'javascript', 'go', 'rust', 'java', 'csharp', 'php'].includes(lang)) {
    return issues;
  }

  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const open = new Set(['(', '[', '{']);
  const stack: Array<{ ch: string; line: number }> = [];

  let line = 1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let prev = '';
  // Last non-space, non-comment significant char — used to decide whether a
  // '/' begins a regex literal (vs division). Regexes can contain (){}[] that
  // would otherwise be miscounted as unbalanced delimiters.
  let prevSig = '';

  const regexAllowedBefore = new Set(['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^', 'return']);

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1] ?? '';

    if (ch === '\n') {
      line++;
      inLineComment = false;
      prev = ch;
      continue;
    }
    if (inLineComment) { prev = ch; continue; }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      prev = ch;
      continue;
    }
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      prev = ch;
      continue;
    }
    // Not in string/comment.
    if (ch === '/' && next === '/') { inLineComment = true; i++; prev = ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; prev = ch; continue; }
    // Regex literal: a '/' in an expression position. Skip to the closing
    // unescaped '/', ignoring any brackets inside it.
    if (ch === '/' && (lang === 'typescript' || lang === 'javascript') && regexAllowedBefore.has(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < content.length) {
        const rc = content[j];
        if (rc === '\\') { j += 2; continue; }
        if (rc === '\n') break; // unterminated on this line — bail, treat as not-regex
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { i = j; prevSig = '/'; prev = '/'; continue; }
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; prev = ch; prevSig = ch; continue; }

    if (open.has(ch)) {
      stack.push({ ch, line });
    } else if (pairs[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        issues.push({
          file: filePath,
          line,
          severity: 'error',
          message: `Unbalanced '${ch}' — no matching '${pairs[ch]}'`,
          source: 'syntax',
        });
        return issues; // first structural error is enough
      }
    }
    prev = ch;
    if (!/\s/.test(ch)) prevSig = ch;
  }

  if (stack.length > 0) {
    const last = stack[stack.length - 1];
    issues.push({
      file: filePath,
      line: last.line,
      severity: 'error',
      message: `Unclosed '${last.ch}' opened on line ${last.line}`,
      source: 'syntax',
    });
  }
  if (inString) {
    issues.push({ file: filePath, severity: 'error', message: `Unterminated string literal (${inString})`, source: 'syntax' });
  }

  return issues;
}

/** Validate a set of just-edited files structurally (no toolchain needed). */
export function validateFilesSyntax(workspacePath: string, relPaths: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const rel of relPaths) {
    const full = path.resolve(workspacePath, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      issues.push(...checkBalancedDelimiters(rel, content));
    } catch {
      /* skip */
    }
  }
  return issues;
}

// --- toolchain detection -----------------------------------------------------

function hasFile(workspacePath: string, ...names: string[]): boolean {
  return names.some((n) => fs.existsSync(path.resolve(workspacePath, n)));
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (err: any) {
    const output = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}`.trim() || String(err?.message ?? err);
    return { ok: false, output };
  }
}

/** Parse `tsc --noEmit` style diagnostics into structured issues. */
function parseTscOutput(output: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // e.g. src/foo.ts(12,5): error TS2345: message
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    issues.push({
      file: m[1].replace(/\\/g, '/'),
      line: parseInt(m[2], 10),
      severity: m[4] === 'error' ? 'error' : 'warning',
      message: m[5].trim(),
      source: 'typescript',
    });
  }
  return issues;
}

/**
 * Run a deterministic, project-appropriate validation pass. Best-effort:
 *  - TypeScript projects: `tsc --noEmit` (fast, no build artifacts)
 *  - Python projects: `python -m py_compile` on changed files
 *  - Always: structural delimiter checks on changed files
 *
 * Returns within `timeoutMs`; skips checks whose tools aren't present.
 */
export async function runValidation(params: {
  workspacePath: string;
  changedFiles: string[];
  timeoutMs?: number;
  enableToolchain?: boolean;
}): Promise<ValidationReport> {
  const { workspacePath, changedFiles } = params;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const enableToolchain = params.enableToolchain !== false;
  const checkedWith: string[] = [];
  const issues: ValidationIssue[] = [];

  // Normalize changed-file paths for comparison (forward slashes, no leading ./).
  const changedSet = new Set(changedFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
  const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');

  // 1. Structural checks (always, instant). These are a HEURISTIC — they can
  //    false-positive on regex literals etc. — so they are authoritative only
  //    for files that won't get a real compiler check below.
  const syntaxIssues = validateFilesSyntax(workspacePath, changedFiles);
  checkedWith.push('syntax');

  if (!enableToolchain) {
    issues.push(...syntaxIssues);
    return finalize(issues, checkedWith);
  }

  // Track which changed files a real compiler authoritatively validated, so we
  // can discard heuristic structural issues for them.
  const compilerCovered = new Set<string>();

  // 2. TypeScript projects.
  const tsChanged = changedFiles.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
  if (tsChanged.length > 0 && hasFile(workspacePath, 'tsconfig.json')) {
    const localTsc = path.resolve(workspacePath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    const tscCmd = fs.existsSync(localTsc) ? localTsc : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
    const tscArgs = fs.existsSync(localTsc) ? ['--noEmit'] : ['tsc', '--noEmit'];
    logger.info('Validation: running tsc --noEmit', { workspacePath });
    const res = runCmd(tscCmd, tscArgs, workspacePath, timeoutMs);
    const tscIssues = parseTscOutput(res.output);
    // tsc "ran" if it exited cleanly (no errors) or produced real diagnostics.
    const tscRan = res.ok || tscIssues.length > 0;
    if (tscRan) {
      checkedWith.push('typescript');
      for (const f of tsChanged) compilerCovered.add(norm(f));
      // Scope: errors in files the agent CHANGED block (severity error); errors
      // elsewhere in the project are pre-existing/unrelated → keep as warnings
      // so they inform without failing this task's validation.
      for (const issue of tscIssues) {
        if (changedSet.has(norm(issue.file))) {
          issues.push(issue);
        } else {
          issues.push({ ...issue, severity: 'warning' });
        }
      }
    } else {
      logger.warn('Validation: tsc could not run; falling back to structural checks', { output: res.output.slice(0, 200) });
    }
  }

  // 3. Python projects — compile changed files (authoritative per file).
  const pyChanged = changedFiles.filter((f) => f.endsWith('.py'));
  if (pyChanged.length > 0) {
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    let pyRanAny = false;
    for (const f of pyChanged.slice(0, 20)) {
      const res = runCmd(pyCmd, ['-m', 'py_compile', f], workspacePath, 10_000);
      // py_compile prints a SyntaxError on failure; absence of that + nonzero
      // for a missing interpreter shouldn't be treated as a syntax failure.
      const looksLikeSyntaxError = /SyntaxError|IndentationError|line \d+/.test(res.output);
      if (res.ok) { pyRanAny = true; compilerCovered.add(norm(f)); continue; }
      if (looksLikeSyntaxError) {
        pyRanAny = true;
        compilerCovered.add(norm(f));
        const lineMatch = /line (\d+)/.exec(res.output);
        issues.push({
          file: f,
          line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
          severity: 'error',
          message: res.output.split('\n').filter(Boolean).slice(-1)[0] || 'py_compile failed',
          source: 'build',
        });
      }
    }
    if (pyRanAny && !checkedWith.includes('build')) checkedWith.push('build');
  }

  // 4. Keep structural issues ONLY for changed files that no compiler covered
  //    (so a regex-bracket false positive can't block a tsc-clean file).
  for (const issue of syntaxIssues) {
    if (!compilerCovered.has(norm(issue.file))) issues.push(issue);
  }

  return finalize(issues, checkedWith);
}

function finalize(issues: ValidationIssue[], checkedWith: string[]): ValidationReport {
  const errors = issues.filter((i) => i.severity === 'error');
  const ok = errors.length === 0;
  const summary = ok
    ? `Validation passed (${checkedWith.join(', ')})`
    : `${errors.length} error(s) found by ${checkedWith.join(', ')}`;
  return { ok, issues, checkedWith, summary };
}

/** Render issues as a compact, model-friendly repair brief. */
export function formatIssuesForRepair(report: ValidationReport, maxIssues = 12): string {
  const errors = report.issues.filter((i) => i.severity === 'error').slice(0, maxIssues);
  if (errors.length === 0) return report.summary;
  const lines = errors.map((i) => {
    const loc = i.line ? `${i.file}:${i.line}` : i.file;
    return `- [${i.source}] ${loc} — ${i.message}`;
  });
  return `${report.summary}\n${lines.join('\n')}`;
}
