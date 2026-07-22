'use strict';

/**
 * electron-builder afterPack hook — embed Bubbly's icon + version metadata into
 * the packaged Bubbly.exe.
 *
 * WHY THIS EXISTS
 * ---------------
 * electron-builder normally does this itself, but only when
 * `win.signAndEditExecutable` is true — and that ALSO makes it download the
 * `winCodeSign` bundle, whose macOS symlinks cannot be extracted on Windows
 * without Developer Mode or elevation ("Cannot create symbolic link : A
 * required privilege is not held by the client"). That failure is why the flag
 * was turned off, and turning it off silently skipped the icon step too — so
 * the shipped exe kept Electron's default atom icon (which reads as the React
 * logo) on the desktop shortcut and in Explorer.
 *
 * So we keep signing disabled and run `rcedit` ourselves. rcedit already lives
 * inside the winCodeSign cache that electron-builder has downloaded, so no new
 * dependency is required.
 *
 * This is best-effort: if rcedit genuinely can't be found we warn loudly rather
 * than failing the build, because a build with a wrong icon still beats no
 * build at all — but the warning must be impossible to miss.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/** Locate an rcedit binary: explicit override, then the electron-builder cache. */
function findRcedit() {
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
  let entries = [];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  // Newest cache dir first, so we prefer the most recent toolchain.
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(cacheRoot, e.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

exports.default = async function afterPack(context) {
  // Only meaningful for Windows builds.
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.warn(`\n[after-pack] WARNING: ${exePath} not found — skipping icon embed.\n`);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.warn(`\n[after-pack] WARNING: ${iconPath} not found — run "npm run icons" first.\n`);
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn(
      '\n[after-pack] ============================================================\n' +
      '[after-pack] WARNING: rcedit not found — the app icon was NOT embedded.\n' +
      '[after-pack] The shipped exe will show Electron\'s default icon.\n' +
      '[after-pack] Set RCEDIT_PATH, or run a build once with network access so\n' +
      '[after-pack] electron-builder populates its winCodeSign cache.\n' +
      '[after-pack] ============================================================\n'
    );
    return;
  }

  const version = context.packager.appInfo.version;
  const args = [
    exePath,
    '--set-icon', iconPath,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', 'Bubbly',
    '--set-version-string', 'FileDescription', 'Bubbly — local-first AI coding agent',
    '--set-version-string', 'CompanyName', 'Bubbly',
    '--set-version-string', 'OriginalFilename', exeName,
  ];

  try {
    execFileSync(rcedit, args, { stdio: 'pipe' });
    console.log(`  • embedded icon + version metadata into ${exeName}  rcedit=${path.basename(path.dirname(rcedit))}`);
  } catch (err) {
    const detail = err && err.stderr ? String(err.stderr).trim() : String(err);
    console.warn(`\n[after-pack] WARNING: rcedit failed, icon NOT embedded: ${detail}\n`);
  }
};
