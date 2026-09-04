/**
 * The chain-operator regression, pinned.
 *
 * `&&` was being rewritten to `;` on Windows unconditionally. That is right for
 * Windows PowerShell 5.1 (which has no chain operators) and catastrophic for
 * cmd.exe (where `;` is not a separator at all, so `cd app; npm install` becomes
 * a single `cd` into a directory named "app; npm install"). Since the shell is
 * cmd.exe, the rewrite has to be a function of the dialect — these tests exist
 * so it can never drift back to being unconditional.
 */

import { normalizeForDialect, needsVerbatimArguments, resolveShell, shellArgv } from './shellDialect';

const cmd = { file: 'C:\\Windows\\System32\\cmd.exe', args: [], dialect: 'cmd' as const, name: 'cmd.exe' };
const ps5 = {
  file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  args: [], dialect: 'powershell' as const, name: 'powershell.exe',
};
const pwsh7 = { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], dialect: 'powershell' as const, name: 'pwsh.exe' };
const posix = { file: '/bin/bash', args: [], dialect: 'posix' as const, name: 'bash' };

describe('cmd.exe keeps its native chain operators', () => {
  it('leaves && exactly alone', () => {
    expect(normalizeForDialect('cd app && npm install', cmd).command).toBe('cd app && npm install');
  });

  it('leaves || alone', () => {
    expect(normalizeForDialect('npm run build || echo failed', cmd).command).toBe('npm run build || echo failed');
  });

  it('leaves a quoted path chain intact', () => {
    expect(normalizeForDialect('cd "my project" && npm install', cmd).command)
      .toBe('cd "my project" && npm install');
  });

  it('leaves a three-part chain intact', () => {
    expect(normalizeForDialect('cd a && npm i && npm run build', cmd).command)
      .toBe('cd a && npm i && npm run build');
  });
});

describe('cmd.exe translates unambiguous Unix command names', () => {
  it('rewrites a bare ls', () => {
    const r = normalizeForDialect('ls', cmd);
    expect(r.command.trim()).toBe('dir');
    expect(r.notes.join(' ')).toContain('ls → dir');
  });

  it('rewrites ls after a chain operator too', () => {
    expect(normalizeForDialect('cd src && ls', cmd).command.trim()).toBe('cd src && dir');
  });

  it('does NOT touch a word that merely starts with a translated name', () => {
    expect(normalizeForDialect('lsof -i :3000', cmd).command).toBe('lsof -i :3000');
  });

  it('does NOT touch the name when it is an argument', () => {
    expect(normalizeForDialect('npm install cat-names', cmd).command).toBe('npm install cat-names');
    expect(normalizeForDialect('git ls-files', cmd).command).toBe('git ls-files');
  });
});

describe('PowerShell 5.1 still gets the sequential rewrite it needs', () => {
  it('rewrites && to ;', () => {
    expect(normalizeForDialect('cd app && npm install', ps5).command).toBe('cd app; npm install');
  });

  it('does not rewrite inside quotes', () => {
    expect(normalizeForDialect('node -e "console.log(1 && 2)"', ps5).command)
      .toBe('node -e "console.log(1 && 2)"');
  });

  it('handles a doubled quote escape without losing the operator after it', () => {
    expect(normalizeForDialect('echo "say ""hi""" && echo done', ps5).command)
      .toBe('echo "say ""hi"""; echo done');
  });
});

describe('PowerShell 7 and POSIX need no rewriting at all', () => {
  it('pwsh understands && natively', () => {
    expect(normalizeForDialect('cd app && npm install', pwsh7).command).toBe('cd app && npm install');
  });

  it('posix is untouched', () => {
    expect(normalizeForDialect('cd app && npm install', posix).command).toBe('cd app && npm install');
  });
});

describe('argv construction', () => {
  it('wraps the cmd command in its own quote pair, which /s then strips', () => {
    // This pairing (outer quotes + windowsVerbatimArguments at the spawn site)
    // is what stops Node escaping the command's own quotes into a form cmd
    // cannot read — the bug that reported every failing command as exit 0.
    expect(shellArgv(cmd, 'npm run build')).toEqual(['/d', '/s', '/c', '"npm run build"']);
  });

  it('marks cmd — and only cmd — as needing verbatim arguments', () => {
    expect(needsVerbatimArguments(cmd)).toBe(true);
    expect(needsVerbatimArguments(ps5)).toBe(false);
    expect(needsVerbatimArguments(posix)).toBe(false);
  });

  it('runs PowerShell non-interactively with no profile', () => {
    expect(shellArgv(ps5, 'Get-Location')).toContain('-NonInteractive');
    expect(shellArgv(ps5, 'Get-Location')).toContain('-NoProfile');
  });

  it('uses -c for posix', () => {
    expect(shellArgv(posix, 'ls -la')).toEqual(['-c', 'ls -la']);
  });
});

describe('per-command routing', () => {
  const onWindows = process.platform === 'win32';

  (onWindows ? it : it.skip)('routes obvious PowerShell syntax to PowerShell', () => {
    const r = resolveShell('Get-ChildItem | Where-Object { $_.Length -gt 10 }');
    // Only assert the routing when a PowerShell is actually installed.
    if (r.dialect === 'powershell') expect(r.reason).toMatch(/PowerShell syntax/);
  });

  (onWindows ? it : it.skip)('leaves ordinary npm commands on cmd.exe', () => {
    expect(resolveShell('npm run build').dialect).toBe('cmd');
  });

  (onWindows ? it.skip : it)('always uses a POSIX shell off Windows', () => {
    expect(resolveShell('npm run build').dialect).toBe('posix');
  });
});
