#!/usr/bin/env node
/**
 * Generate `frontend/src/styles/themes.css` from `frontend/src/styles/palettes.ts`.
 *
 * WHY GENERATE RATHER THAN WRITE
 *
 * Every colour token needs a matching `--x-rgb` channel mirror, because
 * Tailwind's opacity modifiers (`bg-surface-1/60`) compile to
 * `rgb(var(--surface-1-rgb) / 0.6)`. Feeding that a hex produces an INVALID
 * declaration, which browsers drop silently — so a mismatched mirror doesn't
 * throw, it just renders one element transparent in one mode of one theme.
 * That is the least findable class of bug there is.
 *
 * Deriving the mirrors from the hex makes the two impossible to disagree.
 *
 * Run: `node scripts/gen-themes.js` (also wired into `npm run build:frontend`).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'frontend', 'src', 'styles', 'palettes.ts');
const OUTPUT = path.join(ROOT, 'frontend', 'src', 'styles', 'themes.css');

// --- Colour helpers ---------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Not a hex colour: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const channels = (hex) => hexToRgb(hex).join(' ');
const rgba = (hex, alpha) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Relative luminance, for the contrast check below. */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- Read the palettes ------------------------------------------------------

/**
 * The palettes are a TypeScript module, and this script runs in plain Node
 * during the build. Rather than add a TS toolchain to a 60-line generator, the
 * object literals are read out of the source directly — they are pure data with
 * no imports, expressions or computed keys, which is exactly the case where
 * this is safe and obvious.
 */
function loadPalettes() {
  const src = fs.readFileSync(SOURCE, 'utf8');

  // Strip comments and type annotations, keep the literals.
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const palettes = [];
  const declRe = /const\s+(\w+)\s*:\s*Palette\s*=\s*(\{[\s\S]*?\n\};)/g;
  let m;
  while ((m = declRe.exec(withoutComments)) !== null) {
    const body = m[2].replace(/;$/, '');
    // Quote bare keys so JSON.parse can read it, then drop trailing commas.
    const jsonish = body
      .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      palettes.push(JSON.parse(jsonish));
    } catch (err) {
      throw new Error(`Could not parse palette "${m[1]}": ${err.message}`);
    }
  }

  const orderMatch = /export const PALETTES: Palette\[\] = \[([^\]]+)\]/.exec(withoutComments);
  if (!orderMatch) throw new Error('Could not find the PALETTES export');
  const order = orderMatch[1].split(',').map((s) => s.trim()).filter(Boolean);

  // Re-order to match the declared export order, keyed by variable name.
  const byVar = new Map();
  const varRe = /const\s+(\w+)\s*:\s*Palette\s*=/g;
  let i = 0;
  let vm;
  while ((vm = varRe.exec(withoutComments)) !== null) byVar.set(vm[1], palettes[i++]);

  return order.map((name) => {
    const p = byVar.get(name);
    if (!p) throw new Error(`PALETTES lists "${name}" but no such palette is declared`);
    return p;
  });
}

// --- Emit -------------------------------------------------------------------

/** The token block for one palette in one mode. */
function modeBlock(m, isDark) {
  const borderAlpha = isDark ? 0.14 : 0.5;
  const borderStrongAlpha = isDark ? 0.26 : 0.85;
  const shadow = isDark
    ? `0 1px 2px rgba(${m.shadowRgb} / 0.55), 0 6px 20px rgba(${m.shadowRgb} / 0.5)`
        .replace(/rgba\(([\d\s]+) \/ ([\d.]+)\)/g, (_, c, a) => `rgba(${c.trim().split(/\s+/).join(', ')}, ${a})`)
    : `0 1px 2px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.05), 0 4px 14px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.08)`;
  const shadowRaised = isDark
    ? `0 6px 18px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.55), 0 16px 40px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.6)`
    : `0 4px 12px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.09), 0 12px 32px rgba(${m.shadowRgb.split(' ').join(', ')}, 0.13)`;

  const lines = [
    `    --bg-page: ${m.page};`,
    `    --bg-card: ${m.card};`,
    `    --bg-card-hover: ${m.hover};`,
    `    --border-color: ${rgba(m.border, borderAlpha)};`,
    `    --border-strong: ${rgba(m.border, borderStrongAlpha)};`,
    `    --shadow-card: ${shadow};`,
    `    --shadow-card-raised: ${shadowRaised};`,
    `    --text-primary: ${m.text};`,
    `    --text-secondary: ${m.textMuted};`,
    `    --text-tertiary: ${m.textDim};`,
    '',
    `    --surface-0: ${m.page};`,
    `    --surface-1: ${m.card};`,
    `    --surface-2: ${m.recessed};`,
    `    --surface-3: ${m.hover};`,
    `    --surface-4: ${m.hover};`,
    '',
    `    --border: var(--border-color);`,
    `    --border-bright: var(--border-strong);`,
    '',
    `    --text: ${m.text};`,
    `    --text-muted: ${m.textMuted};`,
    `    --text-dim: ${m.textDim};`,
    `    --text-bright: ${m.textBright};`,
    '',
    `    --primary: ${m.primary};`,
    `    --primary-hover: ${m.primaryHover};`,
    `    --primary-light: ${rgba(m.primary, isDark ? 0.15 : 0.12)};`,
    `    --secondary: ${m.secondary};`,
    `    --secondary-hover: ${m.secondaryHover};`,
    `    --secondary-light: ${rgba(m.secondary, isDark ? 0.15 : 0.1)};`,
    '',
    `    --success: ${m.success};`,
    `    --success-bg: ${rgba(m.success, 0.13)};`,
    `    --warning: ${m.warning};`,
    `    --warning-bg: ${rgba(m.warning, 0.13)};`,
    `    --error: ${m.error};`,
    `    --error-bg: ${rgba(m.error, 0.13)};`,
    `    --info: ${m.info};`,
    `    --info-bg: ${rgba(m.info, 0.13)};`,
    '',
    '    /* Channel mirrors — derived, never hand-written. See the header. */',
    `    --primary-rgb: ${channels(m.primary)};`,
    `    --primary-hover-rgb: ${channels(m.primaryHover)};`,
    `    --secondary-rgb: ${channels(m.secondary)};`,
    `    --success-rgb: ${channels(m.success)};`,
    `    --warning-rgb: ${channels(m.warning)};`,
    `    --error-rgb: ${channels(m.error)};`,
    `    --info-rgb: ${channels(m.info)};`,
    `    --text-rgb: ${channels(m.text)};`,
    `    --text-muted-rgb: ${channels(m.textMuted)};`,
    `    --text-dim-rgb: ${channels(m.textDim)};`,
    `    --text-bright-rgb: ${channels(m.textBright)};`,
    `    --surface-0-rgb: ${channels(m.page)};`,
    `    --surface-1-rgb: ${channels(m.card)};`,
    `    --surface-2-rgb: ${channels(m.recessed)};`,
    `    --surface-3-rgb: ${channels(m.hover)};`,
    `    --surface-4-rgb: ${channels(m.hover)};`,
    `    --border-rgb: ${channels(m.border)};`,
    '',
    '    /* The agent-status colours components reference by name. */',
    `    --green-agent: ${m.success};`,
    `    --red-agent: ${m.error};`,
    `    --amber-agent: ${m.warning};`,
    `    --blue-agent: ${m.info};`,
    `    --cyan-agent: ${m.info};`,
    `    --violet-agent: ${m.secondary};`,
    `    --orange-agent: ${m.secondary};`,
    `    --brown-agent: ${m.textMuted};`,
    `    --accent: ${m.primary};`,
    `    --accent-bright: ${m.primaryHover};`,
    `    --accent-rgb: ${channels(m.primary)};`,
    `    --accent-bright-rgb: ${channels(m.primaryHover)};`,
    `    --green-agent-rgb: ${channels(m.success)};`,
    `    --red-agent-rgb: ${channels(m.error)};`,
    `    --amber-agent-rgb: ${channels(m.warning)};`,
    `    --blue-agent-rgb: ${channels(m.info)};`,
    `    --cyan-agent-rgb: ${channels(m.info)};`,
    `    --violet-agent-rgb: ${channels(m.secondary)};`,
    `    --orange-agent-rgb: ${channels(m.secondary)};`,
    `    --brown-agent-rgb: ${channels(m.textMuted)};`,
    '',
    '    /* Syntax highlighting, derived so every theme is internally coherent. */',
    `    --syntax-keyword: ${m.primary};`,
    `    --syntax-string: ${m.success};`,
    `    --syntax-number: ${m.secondary};`,
    `    --syntax-comment: ${m.textDim};`,
    `    --syntax-function: ${m.info};`,
    `    --syntax-variable: ${m.text};`,
    `    --syntax-operator: ${m.warning};`,
    `    --syntax-constant: ${m.secondaryHover};`,
  ];
  return lines.join('\n');
}

function checkContrast(palette) {
  const problems = [];
  for (const mode of ['light', 'dark']) {
    const m = palette[mode];
    const pairs = [
      ['text on card', m.text, m.card, 7],
      ['textMuted on card', m.textMuted, m.card, 4.5],
      ['textDim on card', m.textDim, m.card, 2.6],
      ['primary on card', m.primary, m.card, 3],
      ['text on page', m.text, m.page, 7],
    ];
    for (const [label, fg, bg, min] of pairs) {
      const ratio = contrast(fg, bg);
      if (ratio < min) {
        problems.push(`  ${palette.id}/${mode}: ${label} is ${ratio.toFixed(2)}:1 (want ${min}:1)`);
      }
    }
  }
  return problems;
}

function main() {
  const palettes = loadPalettes();

  const header = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by scripts/gen-themes.js from frontend/src/styles/palettes.ts.
 * Edit the palette data there and re-run \`node scripts/gen-themes.js\`.
 *
 * Selection model:
 *   data-palette="<id>"  chooses the palette
 *   data-theme="dark"    chooses the mode (absent/"light" means light)
 *
 * The two are independent on purpose: every palette ships both modes, so
 * switching to dark never silently changes which theme you are using.
 */

`;

  const blocks = [];
  const allProblems = [];

  for (const p of palettes) {
    allProblems.push(...checkContrast(p));

    // The default palette also answers to a bare :root, so the app is correctly
    // themed before any attribute has been applied — no flash of wrong colour.
    const lightSelectors = p.id === palettes[0].id
      ? `:root,\n  :root[data-palette="${p.id}"]`
      : `:root[data-palette="${p.id}"]`;
    const darkSelectors =
      p.id === palettes[0].id
        ? `:root[data-theme="dark"],\n  html.dark,\n  :root[data-palette="${p.id}"][data-theme="dark"]`
        : `:root[data-palette="${p.id}"][data-theme="dark"],\n  html.dark:root[data-palette="${p.id}"]`;

    blocks.push(
      `/* ===== ${p.name} — ${p.description} ===== */\n` +
      `${lightSelectors} {\n${modeBlock(p.light, false)}\n}\n\n` +
      `${darkSelectors} {\n${modeBlock(p.dark, true)}\n}\n`
    );
  }

  fs.writeFileSync(OUTPUT, header + blocks.join('\n'), 'utf8');

  const rel = path.relative(ROOT, OUTPUT).replace(/\\/g, '/');
  console.log(`Wrote ${rel} — ${palettes.length} palettes, ${palettes.length * 2} modes.`);

  if (allProblems.length > 0) {
    // A warning, not a failure: a palette can legitimately trade a little
    // contrast for character, and blocking the build over it would just teach
    // people to delete the check.
    console.warn('\nContrast below target (readability warning, not an error):');
    for (const p of allProblems) console.warn(p);
  } else {
    console.log('All palettes clear their contrast targets.');
  }
}

main();
