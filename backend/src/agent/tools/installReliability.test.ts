/**
 * Regression tests for the three ways an install could fail on an EXISTING
 * project while working fine on a brand-new one.
 *
 * 1. Deprecation warnings read as interactive prompts (the killer).
 * 2. `&&` surviving into PowerShell whenever the command contained a quote.
 * 3. Installs reporting success without actually landing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectInputPrompt } from '../../terminal/inputDetection';
import { normalizeForWindows, resolveCommandCwd, verifyInstall, installedPackageNames } from './shell';

describe('install output is not mistaken for an interactive prompt', () => {
  // Every one of these is real npm/yarn output, cut at a stream-chunk boundary
  // so the buffer ends mid-line with no trailing newline — exactly the shape
  // that used to get a healthy install killed.
  const NOT_PROMPTS = [
    'npm warn deprecated inflight@1.0.6:',
    'npm WARN deprecated har-validator@5.1.5:',
    'npm warn deprecated @babel/plugin-proposal-class-properties@7.18.6:',
    'npm notice New major version of npm available:',
    'npm ERR! code ERESOLVE',
    'npm error While resolving:',
    'warning eslint > file-entry-cache > flat-cache:',
    'added 1247 packages, and audited 1248 packages in 2m',
    'Installing dependencies:',
    'Resolving:',
    'info There appears to be trouble with your network connection. Retrying:',
    '[3/4] Linking dependencies:',
    'at Module._compile (node:internal/modules/cjs/loader:1105',
    'src/components/Button.tsx:42',
  ];

  it.each(NOT_PROMPTS)('does not treat %j as a question', (line) => {
    expect(detectInputPrompt(`some earlier output\n${line}`)).toBeNull();
  });

  // The guard must not cost us the real detections it exists to protect.
  const REAL_PROMPTS: Array<[string, string]> = [
    ['Ok to proceed? (y)', 'confirm'],
    ['? Project name:', 'question'],
    ['Password:', 'password'],
    ['Press any key to continue', 'pause'],
    ['? Select a framework: (Use arrow keys)', 'selection'],
    ['Overwrite files? [y/N]', 'confirm'],
  ];

  it.each(REAL_PROMPTS)('still detects %j', (line, kind) => {
    const d = detectInputPrompt(`some earlier output\n${line}`);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe(kind);
  });

  it('ignores a pointer glyph that scrolled far out of view', () => {
    // A `›` thousands of characters ago says nothing about right now. It used to
    // be matched against the whole 4KB tail.
    const stale = '❯ pick one\n' + 'building module\n'.repeat(400) + 'done building';
    expect(detectInputPrompt(stale)).toBeNull();
  });
});

describe('normalizeForWindows rewrites && even when the command is quoted', () => {
  const originalPlatform = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

  it('rewrites a chain containing a quoted path (the case that always failed)', () => {
    expect(normalizeForWindows('cd "my project" && npm install')).toBe('cd "my project"; npm install');
  });

  it('rewrites unquoted chains as before', () => {
    expect(normalizeForWindows('cd app && npm install')).toBe('cd app; npm install');
    expect(normalizeForWindows('npm run build || echo failed')).toBe('npm run build; echo failed');
  });

  it('leaves operators INSIDE quotes alone', () => {
    expect(normalizeForWindows('node -e "console.log(1 && 2)"')).toBe('node -e "console.log(1 && 2)"');
    expect(normalizeForWindows("git commit -m 'a && b'")).toBe("git commit -m 'a && b'");
  });

  it('handles a doubled quote escape without losing quote state', () => {
    expect(normalizeForWindows('echo "say ""hi""" && echo done')).toBe('echo "say ""hi"""; echo done');
  });

  it('handles several chains in one command', () => {
    expect(normalizeForWindows('cd a && npm i && npm run build')).toBe('cd a; npm i; npm run build');
  });
});

describe('resolveCommandCwd', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-cwd-'));
    fs.mkdirSync(path.join(root, 'frontend'));
    fs.writeFileSync(path.join(root, 'notadir.txt'), 'x');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves a subdirectory', () => {
    const r = resolveCommandCwd(root, 'frontend');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe(path.join(root, 'frontend'));
  });

  it('defaults to the workspace root', () => {
    for (const v of [undefined, '.', './']) {
      const r = resolveCommandCwd(root, v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cwd).toBe(path.resolve(root));
    }
  });

  it('refuses to escape the workspace', () => {
    const r = resolveCommandCwd(root, '../elsewhere');
    expect(r.ok).toBe(false);
  });

  it('refuses a directory that does not exist rather than silently using the root', () => {
    const r = resolveCommandCwd(root, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });

  it('refuses a path that is a file', () => {
    expect(resolveCommandCwd(root, 'notadir.txt').ok).toBe(false);
  });
});

describe('installedPackageNames', () => {
  it('reads explicit packages, stripping versions but keeping scopes', () => {
    expect(installedPackageNames('npm install react react-dom@18.2.0 -D')).toEqual(['react', 'react-dom']);
    expect(installedPackageNames('npm i @tailwindcss/vite@latest')).toEqual(['@tailwindcss/vite']);
    expect(installedPackageNames('pnpm add -w zod')).toEqual(['zod']);
  });

  it('returns nothing for a bare manifest install', () => {
    expect(installedPackageNames('npm install')).toEqual([]);
    expect(installedPackageNames('npm ci')).toEqual([]);
  });

  it('stops at a chained command', () => {
    expect(installedPackageNames('npm install react; npm run build')).toEqual(['react']);
  });
});

describe('verifyInstall catches an install that did not land', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-install-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const modules = () => path.join(dir, 'node_modules');

  it('says nothing for commands that are not installs', () => {
    expect(verifyInstall('npm run build', dir, 0)).toBeNull();
    expect(verifyInstall('npx tsc --noEmit', dir, 1)).toBeNull();
  });

  it('flags "success" with no node_modules at all', () => {
    const note = verifyInstall('npm install', dir, 0);
    expect(note).toMatch(/INSTALL DID NOT LAND/);
  });

  it('flags an interrupted npm install (no completion marker)', () => {
    fs.mkdirSync(modules());
    fs.mkdirSync(path.join(modules(), 'react'));
    expect(verifyInstall('npm install react', dir, 0)).toMatch(/INSTALL INCOMPLETE/);
  });

  it('passes a complete npm install', () => {
    fs.mkdirSync(modules());
    fs.writeFileSync(path.join(modules(), '.package-lock.json'), '{}');
    fs.mkdirSync(path.join(modules(), 'react'));
    expect(verifyInstall('npm install react', dir, 0)).toBeNull();
  });

  it('names the packages that are still missing', () => {
    fs.mkdirSync(modules());
    fs.writeFileSync(path.join(modules(), '.package-lock.json'), '{}');
    fs.mkdirSync(path.join(modules(), 'react'));
    const note = verifyInstall('npm install react zustand', dir, 0);
    expect(note).toMatch(/zustand/);
    expect(note).not.toMatch(/\breact\b,/);
  });

  it('resolves scoped packages as nested directories', () => {
    fs.mkdirSync(path.join(modules(), '@tailwindcss', 'vite'), { recursive: true });
    fs.writeFileSync(path.join(modules(), '.package-lock.json'), '{}');
    expect(verifyInstall('npm install @tailwindcss/vite', dir, 0)).toBeNull();
  });
});
