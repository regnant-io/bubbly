#!/usr/bin/env node
'use strict';

/**
 * Builds both halves of Bubbly (backend + frontend) so the desktop shell has
 * everything it needs to package. Run from the repo root or the desktop dir.
 *
 * Steps:
 *   1. backend:  npm run build   (tsc → backend/dist)
 *   2. frontend: npm run build   (tsc + vite → frontend/dist)
 *
 * NODE_ENV is cleared for the child installs/builds so devDependencies and
 * type-checking work even when the parent shell sets NODE_ENV=production.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, cwd, args) {
  console.log(`\n=== ${label} ===`);
  console.log(`> ${npmCmd} ${args.join(' ')}  (cwd: ${cwd})`);
  const env = { ...process.env };
  // Ensure dev dependencies are available for building.
  delete env.NODE_ENV;
  const res = spawnSync(npmCmd, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
  console.log(`✓ ${label} done.`);
}

function ensureDeps(label, dir) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run(`${label} (install deps)`, dir, ['install', '--include=dev', '--no-audit', '--no-fund']);
  }
}

const backendDir = path.join(ROOT, 'backend');
const frontendDir = path.join(ROOT, 'frontend');

ensureDeps('backend', backendDir);
run('backend build', backendDir, ['run', 'build']);

ensureDeps('frontend', frontendDir);
run('frontend build', frontendDir, ['run', 'build']);

// Sanity-check the build outputs the desktop shell depends on.
const backendEntry = path.join(backendDir, 'dist', 'index.js');
const frontendIndex = path.join(frontendDir, 'dist', 'index.html');
for (const [label, p] of [
  ['backend/dist/index.js', backendEntry],
  ['frontend/dist/index.html', frontendIndex],
]) {
  if (!fs.existsSync(p)) {
    console.error(`\n✗ Expected build output missing: ${label} (${p})`);
    process.exit(1);
  }
}

// Regenerate the multi-resolution Windows .ico from the source PNG so the
// packaged app always ships a proper taskbar/Explorer icon (a single 256px
// frame makes Windows fall back to a generic icon). Windows-only; best-effort.
if (process.platform === 'win32') {
  const icoScript = path.join(ROOT, 'scripts', 'make-ico.ps1');
  if (fs.existsSync(icoScript)) {
    console.log('\n=== desktop icon (multi-res .ico) ===');
    const res = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', icoScript], {
      stdio: 'inherit',
      shell: false,
    });
    if (res.status !== 0) {
      console.warn('⚠ Icon generation failed; continuing with existing icon.ico.');
    } else {
      console.log('✓ desktop icon regenerated.');
    }
  }
}

console.log('\n✓ All builds complete. Bubbly is ready to package or run.');
