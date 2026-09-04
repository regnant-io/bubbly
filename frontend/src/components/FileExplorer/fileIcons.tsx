import React from 'react';
import {
  FileCode, FileText, FileJson, FileImage, FileTerminal,
  FileCog, FileLock, File, Folder, FolderOpen, Database,
  Palette, Package, BookOpen, Settings, GitBranch, Globe, Box,
} from 'lucide-react';

/**
 * VS Code-style file/folder iconography with color.
 *
 * We map by extension (and some well-known filenames) to a lucide icon plus a
 * brand-ish color, approximating the Seti/VS Code icon theme without shipping a
 * full SVG icon font. Folders get special icons for common framework dirs.
 */

interface IconSpec {
  icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }> | any;
  color: string;
}

// Per-extension icon + color. Colors chosen to match each ecosystem's brand.
const EXT_MAP: Record<string, IconSpec> = {
  // Web / JS / TS
  ts: { icon: FileCode, color: '#3178c6' },
  tsx: { icon: FileCode, color: '#3178c6' },
  js: { icon: FileCode, color: '#f1e05a' },
  jsx: { icon: FileCode, color: '#f1e05a' },
  mjs: { icon: FileCode, color: '#f1e05a' },
  cjs: { icon: FileCode, color: '#f1e05a' },
  vue: { icon: FileCode, color: '#42b883' },
  svelte: { icon: FileCode, color: '#ff3e00' },
  astro: { icon: FileCode, color: '#ff5d01' },
  // Styles
  css: { icon: Palette, color: '#563d7c' },
  scss: { icon: Palette, color: '#c6538c' },
  sass: { icon: Palette, color: '#c6538c' },
  less: { icon: Palette, color: '#1d365d' },
  // Markup / data
  html: { icon: Globe, color: '#e34c26' },
  htm: { icon: Globe, color: '#e34c26' },
  xml: { icon: FileCode, color: '#e37933' },
  svg: { icon: FileImage, color: '#ffb13b' },
  json: { icon: FileJson, color: '#cbcb41' },
  jsonc: { icon: FileJson, color: '#cbcb41' },
  yaml: { icon: FileCog, color: '#cb171e' },
  yml: { icon: FileCog, color: '#cb171e' },
  toml: { icon: FileCog, color: '#9c4221' },
  ini: { icon: Settings, color: '#6d8086' },
  env: { icon: FileLock, color: '#ecd53f' },
  // Markdown / docs
  md: { icon: FileText, color: '#519aba' },
  mdx: { icon: FileText, color: '#519aba' },
  txt: { icon: FileText, color: '#9aa0a6' },
  pdf: { icon: BookOpen, color: '#e03e2f' },
  // Backend languages
  py: { icon: FileCode, color: '#3572A5' },
  rb: { icon: FileCode, color: '#701516' },
  go: { icon: FileCode, color: '#00ADD8' },
  rs: { icon: FileCode, color: '#dea584' },
  java: { icon: FileCode, color: '#b07219' },
  kt: { icon: FileCode, color: '#A97BFF' },
  c: { icon: FileCode, color: '#555555' },
  h: { icon: FileCode, color: '#555555' },
  cpp: { icon: FileCode, color: '#f34b7d' },
  cc: { icon: FileCode, color: '#f34b7d' },
  cs: { icon: FileCode, color: '#178600' },
  php: { icon: FileCode, color: '#4F5D95' },
  swift: { icon: FileCode, color: '#F05138' },
  dart: { icon: FileCode, color: '#00B4AB' },
  lua: { icon: FileCode, color: '#000080' },
  r: { icon: FileCode, color: '#198CE7' },
  scala: { icon: FileCode, color: '#c22d40' },
  ex: { icon: FileCode, color: '#6e4a7e' },
  exs: { icon: FileCode, color: '#6e4a7e' },
  // Shell / scripts
  sh: { icon: FileTerminal, color: '#89e051' },
  bash: { icon: FileTerminal, color: '#89e051' },
  zsh: { icon: FileTerminal, color: '#89e051' },
  ps1: { icon: FileTerminal, color: '#012456' },
  bat: { icon: FileTerminal, color: '#C1F12E' },
  cmd: { icon: FileTerminal, color: '#C1F12E' },
  // Data / db
  sql: { icon: Database, color: '#e38c00' },
  db: { icon: Database, color: '#dad8d8' },
  sqlite: { icon: Database, color: '#003B57' },
  csv: { icon: FileText, color: '#89e051' },
  // Images
  png: { icon: FileImage, color: '#a074c4' },
  jpg: { icon: FileImage, color: '#a074c4' },
  jpeg: { icon: FileImage, color: '#a074c4' },
  gif: { icon: FileImage, color: '#a074c4' },
  webp: { icon: FileImage, color: '#a074c4' },
  ico: { icon: FileImage, color: '#a074c4' },
  // Misc config
  lock: { icon: FileLock, color: '#8b949e' },
  log: { icon: FileText, color: '#6d8086' },
};

// Well-known full filenames → icon + color (override extension).
const NAME_MAP: Record<string, IconSpec> = {
  'package.json': { icon: Package, color: '#cb3837' },
  'package-lock.json': { icon: Package, color: '#cb3837' },
  'yarn.lock': { icon: Package, color: '#2c8ebb' },
  'pnpm-lock.yaml': { icon: Package, color: '#f9ad00' },
  'tsconfig.json': { icon: FileCog, color: '#3178c6' },
  'dockerfile': { icon: Box, color: '#0db7ed' },
  'docker-compose.yml': { icon: Box, color: '#0db7ed' },
  'docker-compose.yaml': { icon: Box, color: '#0db7ed' },
  '.gitignore': { icon: GitBranch, color: '#f1502f' },
  '.gitattributes': { icon: GitBranch, color: '#f1502f' },
  '.env': { icon: FileLock, color: '#ecd53f' },
  'readme.md': { icon: BookOpen, color: '#519aba' },
  'license': { icon: FileText, color: '#cb9a3d' },
  'vite.config.ts': { icon: FileCog, color: '#646cff' },
  'vite.config.js': { icon: FileCog, color: '#646cff' },
  'tailwind.config.js': { icon: Palette, color: '#38bdf8' },
  'tailwind.config.ts': { icon: Palette, color: '#38bdf8' },
};

// Special folder names → icon + color.
const FOLDER_MAP: Record<string, string> = {
  src: '#dcb67a',
  components: '#42b883',
  node_modules: '#6d8086',
  '.git': '#f1502f',
  public: '#519aba',
  assets: '#a074c4',
  dist: '#6d8086',
  build: '#6d8086',
  test: '#cbcb41',
  tests: '#cbcb41',
  __tests__: '#cbcb41',
  styles: '#c6538c',
  hooks: '#61dafb',
  utils: '#dcb67a',
  api: '#00ADD8',
  pages: '#42b883',
  routes: '#00ADD8',
};


/**
 * Make a language colour legible against the CURRENT theme.
 *
 * THE BUG
 *
 * These are the conventional per-language colours — TypeScript blue, Ruby's
 * dark red, LESS's navy — and several of them are extremely dark, because they
 * were chosen for a white page. `#1d365d` on a `#16151b` background is very
 * nearly invisible: in dark mode a third of the file tree's icons simply
 * disappeared, which reads as icons failing to load rather than as a colour
 * problem.
 *
 * Rather than maintaining a second hand-picked palette that would drift from
 * the first, the colour is adjusted toward legibility: too dark for a dark
 * theme gets lightened, too light for a light theme gets darkened, and anything
 * already comfortable is left exactly as it is. The language stays recognisable
 * — TypeScript is still blue — while always clearing the background.
 */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Blend a hex colour toward white or black by `amount` (0..1). */
function blend(hex: string, toward: 'white' | 'black', amount: number): string {
  const h = hex.replace('#', '');
  const target = toward === 'white' ? 255 : 0;
  const mixed = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.round(v + (target - v) * amount);
  });
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function legibleColor(hex: string, isDark: boolean): string {
  try {
    const lum = relativeLuminance(hex);
    if (isDark) {
      // Below this a colour is lost against a dark surface. The blend amount
      // scales with how dark it is, so a nearly-black colour is lifted a lot and
      // a merely-dim one is barely touched.
      if (lum < 0.22) return blend(hex, 'white', Math.min(0.62, (0.22 - lum) * 2.4));
      return hex;
    }
    if (lum > 0.72) return blend(hex, 'black', Math.min(0.45, (lum - 0.72) * 2.0));
    return hex;
  } catch {
    return hex;
  }
}

/** Read the resolved theme from the document, so this needs no React context. */
function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

export function getFileIcon(name: string, size = 14): React.ReactNode {
  const dark = isDarkTheme();
  const lower = name.toLowerCase();

  const byName = NAME_MAP[lower];
  if (byName) {
    const Icon = byName.icon;
    return <Icon size={size} style={{ color: legibleColor(byName.color, dark) }} className="shrink-0" />;
  }

  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  const spec = EXT_MAP[ext];
  if (spec) {
    const Icon = spec.icon;
    return <Icon size={size} style={{ color: legibleColor(spec.color, dark) }} className="shrink-0" />;
  }

  return <File size={size} className="text-text-dim shrink-0" />;
}

export function getFolderIcon(name: string, open: boolean, size = 14): React.ReactNode {
  const color = FOLDER_MAP[name.toLowerCase()] ?? (open ? '#dcb67a' : '#c8a05a');
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} style={{ color: legibleColor(color, isDarkTheme()) }} className="shrink-0" />;
}
