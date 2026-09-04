/**
 * Bubbly's colour palettes — the single source of truth.
 *
 * WHY THIS IS DATA AND NOT CSS
 *
 * A theme is about twenty tokens, and every one of them needs an `-rgb` channel
 * mirror as well, because Tailwind's opacity modifiers (`bg-surface-1/60`)
 * compile to `rgb(<channels> / 0.6)` and silently produce an INVALID
 * declaration when handed a hex through `var()`. Written by hand that is forty
 * lines per palette, times two modes, times nine palettes — 700 lines of CSS in
 * which a single mistyped channel produces a colour that is subtly wrong in one
 * mode of one theme and is essentially undiscoverable.
 *
 * So palettes are declared here as data, `scripts/gen-themes.js` derives the
 * mirrors and writes `themes.css`, and the two can never drift.
 *
 * WHAT A PALETTE HAS TO GET RIGHT
 *
 *  - Contrast. `text` on `card` must clear 7:1, `textMuted` 4.5:1. A palette
 *    that only looks nice in a swatch grid is not a palette, it is a mood board.
 *  - A single confident accent. Two competing accents make every UI decision an
 *    argument.
 *  - Surfaces that step in ONE direction. page → card → recessed → hover, each
 *    a visible but small step, so depth reads without borders doing all the work.
 */

export interface PaletteMode {
  /** Flat page background, behind every card. */
  page: string;
  /** Primary card surface. */
  card: string;
  /** Recessed control surface: inputs, chips, code blocks. */
  recessed: string;
  /** Hover / nested surface. */
  hover: string;
  /** Border, as a solid colour (alpha is derived). */
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  textBright: string;
  /** The one accent. */
  primary: string;
  primaryHover: string;
  /** Used sparingly: destructive-adjacent highlights, secondary emphasis. */
  secondary: string;
  secondaryHover: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  /** Shadow tint — warm palettes want warm shadows. */
  shadowRgb: string;
}

export interface Palette {
  id: string;
  name: string;
  /** One line, shown in Settings. Says what it is FOR, not what it looks like. */
  description: string;
  light: PaletteMode;
  dark: PaletteMode;
}

/**
 * SLATE — the default.
 *
 * Built from the cool slate/lavender family (#464655 #94958B #B7B6C1 #D5CFE1
 * #EDDFEF). Chosen as the default because it is the only one of these families
 * that is equally convincing in both modes: the light mode reads as paper with a
 * faint lilac cast rather than as grey, and the dark mode keeps the same hue
 * relationship instead of becoming a different theme wearing the same name.
 * Low chroma everywhere except the accent, which is what makes a long session
 * comfortable.
 */
const slate: Palette = {
  id: 'slate',
  name: 'Slate',
  description: 'Cool lavender-grey. Low contrast noise, one confident accent — built for long sessions.',
  light: {
    page: '#f2f0f5', card: '#fdfcfe', recessed: '#eae7f0', hover: '#e3dfec',
    border: '#c9c5d6',
    text: '#26242e', textMuted: '#5c5869', textDim: '#8d8899', textBright: '#141219',
    primary: '#6d5f9e', primaryHover: '#5b4e89',
    secondary: '#a06a8c', secondaryHover: '#8b5878',
    success: '#4a7c59', warning: '#a67c2e', error: '#b3453c', info: '#4a6fa5',
    shadowRgb: '38 36 46',
  },
  dark: {
    page: '#16151b', card: '#1f1e26', recessed: '#262533', hover: '#2e2c3a',
    border: '#3a384a',
    text: '#e6e3ee', textMuted: '#a9a4bb', textDim: '#6f6b80', textBright: '#ffffff',
    primary: '#a89bd8', primaryHover: '#bcb1e4',
    secondary: '#d19ab8', secondaryHover: '#e0b0c9',
    success: '#7fb08c', warning: '#d9b165', error: '#e0796f', info: '#7fa3d9',
    shadowRgb: '0 0 0',
  },
};

/**
 * PAPER — maximum legibility, minimum decoration.
 *
 * The near-white family (#FFFFF3 #F9F8F8) with a single vivid green accent
 * (#00DC00, pulled back from neon so it can carry text). For people who want the
 * editor to disappear.
 */
const paper: Palette = {
  id: 'paper',
  name: 'Paper',
  description: 'Near-white and quiet, with one vivid green accent. The editor gets out of the way.',
  light: {
    page: '#f9f8f8', card: '#fffff3', recessed: '#f1f0e8', hover: '#e9e8df',
    border: '#d8d7cc',
    text: '#1a1a17', textMuted: '#57574f', textDim: '#8a8a80', textBright: '#000000',
    primary: '#12923a', primaryHover: '#0d7a2f',
    secondary: '#3a6ea5', secondaryHover: '#2d5a8a',
    success: '#12923a', warning: '#9a7412', error: '#b03030', info: '#3a6ea5',
    shadowRgb: '30 30 24',
  },
  dark: {
    page: '#12130f', card: '#1a1c17', recessed: '#22241d', hover: '#2a2d24',
    border: '#383b30',
    text: '#eceee4', textMuted: '#a3a698', textDim: '#6c6f62', textBright: '#ffffff',
    primary: '#3ce05c', primaryHover: '#5eea79',
    secondary: '#6fa8dc', secondaryHover: '#8cbce8',
    success: '#3ce05c', warning: '#d9b165', error: '#e0796f', info: '#6fa8dc',
    shadowRgb: '0 0 0',
  },
};

/**
 * MINT — the soft green family (#D7FCD4 #B6CCA1 #545454).
 * Calm and slightly organic; the accent is a deepened sage so it stays readable.
 */
const mint: Palette = {
  id: 'mint',
  name: 'Mint',
  description: 'Soft greens over neutral grey. Calm without being sleepy.',
  light: {
    page: '#eef7ec', card: '#fbfefa', recessed: '#e2f0de', hover: '#d7ecd4',
    border: '#bcd4b6',
    text: '#22291f', textMuted: '#54604f', textDim: '#87927f', textBright: '#101410',
    primary: '#4f7a3f', primaryHover: '#406530',
    secondary: '#5d7f8a', secondaryHover: '#4a6a74',
    success: '#4f7a3f', warning: '#9c7a24', error: '#b04a40', info: '#4a7ba5',
    shadowRgb: '30 40 28',
  },
  dark: {
    page: '#131711', card: '#1b201a', recessed: '#232a21', hover: '#2b3328',
    border: '#38412f',
    text: '#e3ecdf', textMuted: '#a2ad9c', textDim: '#6b7566', textBright: '#ffffff',
    primary: '#98c98a', primaryHover: '#aed99f',
    secondary: '#8fb3bd', secondaryHover: '#a5c5cf',
    success: '#98c98a', warning: '#d4b168', error: '#df8074', info: '#84aed4',
    shadowRgb: '0 0 0',
  },
};

/**
 * LIME — a dark terminal palette on near-black green (#040F06) with a lime
 * accent. The only palette whose light mode is a deliberate compromise: it
 * exists so the theme does not break if the system flips, but the theme is
 * meant to be used dark.
 */
const lime: Palette = {
  id: 'lime',
  name: 'Lime',
  description: 'Near-black green with a lime accent. A terminal that happens to be an IDE.',
  light: {
    page: '#f2f6f0', card: '#ffffff', recessed: '#e7ede4', hover: '#dde6d9',
    border: '#c3d0bd',
    text: '#111a12', textMuted: '#4a564b', textDim: '#7d887d', textBright: '#000000',
    primary: '#3f7d1f', primaryHover: '#336618',
    secondary: '#2f6f5f', secondaryHover: '#255b4d',
    success: '#3f7d1f', warning: '#96731f', error: '#a94436', info: '#3a6f9a',
    shadowRgb: '16 24 16',
  },
  dark: {
    page: '#040f06', card: '#0b1a0e', recessed: '#122414', hover: '#182e1b',
    border: '#223d26',
    text: '#dcf0dd', textMuted: '#93a894', textDim: '#5f7261', textBright: '#ffffff',
    primary: '#7dd93f', primaryHover: '#95e65c',
    secondary: '#3fd9b0', secondaryHover: '#5ee6c3',
    success: '#7dd93f', warning: '#d9c23f', error: '#e0705f', info: '#5aa9e0',
    shadowRgb: '0 0 0',
  },
};

/**
 * EMBER — the warm family (#E1CE7A #FBFFB9 #FDD692 #EC7357 #754744).
 * Bright and warm; the orange is the accent, the brick is the secondary.
 */
const ember: Palette = {
  id: 'ember',
  name: 'Ember',
  description: 'Warm sand and terracotta. Bright, high energy, still readable at 2am.',
  light: {
    page: '#fbf6ea', card: '#fffdf4', recessed: '#f5ecd9', hover: '#efe3c9',
    border: '#dccdae',
    text: '#2b201a', textMuted: '#61503f', textDim: '#948270', textBright: '#160f0b',
    primary: '#c8542f', primaryHover: '#ab4324',
    secondary: '#754744', secondaryHover: '#5f3836',
    success: '#5b7d3a', warning: '#a8791c', error: '#b8402f', info: '#3f6f96',
    shadowRgb: '60 40 24',
  },
  dark: {
    page: '#1a1310', card: '#241a15', recessed: '#2e211a', hover: '#392920',
    border: '#4a352a',
    text: '#f2e4d2', textMuted: '#b8a48d', textDim: '#7d6c5b', textBright: '#ffffff',
    primary: '#ec7357', primaryHover: '#f28d74',
    secondary: '#e1ce7a', secondaryHover: '#ebdc96',
    success: '#a3c46a', warning: '#e1ce7a', error: '#e8695a', info: '#7fb0d9',
    shadowRgb: '0 0 0',
  },
};

/**
 * MOSS — the muted olive/taupe family (#667761 #545E56 #917C78).
 * The most restrained palette here; nothing in it competes for attention.
 */
const moss: Palette = {
  id: 'moss',
  name: 'Moss',
  description: 'Muted olive and taupe. Nothing competes for attention.',
  light: {
    page: '#f2f3ef', card: '#fcfdfa', recessed: '#e7e9e2', hover: '#dee1d8',
    border: '#c5c9bd',
    text: '#232620', textMuted: '#545e56', textDim: '#8a9084', textBright: '#12140f',
    primary: '#5a6b54', primaryHover: '#485643',
    secondary: '#917c78', secondaryHover: '#7a6764',
    success: '#5a6b54', warning: '#95772a', error: '#a9483d', info: '#4d6f85',
    shadowRgb: '34 38 32',
  },
  dark: {
    page: '#151714', card: '#1d201b', recessed: '#252923', hover: '#2d322b',
    border: '#3a3f37',
    text: '#e4e7df', textMuted: '#a3a99b', textDim: '#6d7367', textBright: '#ffffff',
    primary: '#9fb097', primaryHover: '#b4c3ac',
    secondary: '#c2a7a2', secondaryHover: '#d3bcb7',
    success: '#9fb097', warning: '#cfb073', error: '#dd8175', info: '#8aabc0',
    shadowRgb: '0 0 0',
  },
};

/**
 * INDIGO — a deep blue-violet with high contrast. For people who want an
 * unmistakably "night" theme rather than a dimmed day theme.
 */
const indigo: Palette = {
  id: 'indigo',
  name: 'Indigo',
  description: 'Deep blue-violet with crisp contrast. An unmistakably night theme.',
  light: {
    page: '#f1f3fa', card: '#ffffff', recessed: '#e6eaf6', hover: '#dbe1f1',
    border: '#c2cae2',
    text: '#1b1f2e', textMuted: '#4e5670', textDim: '#828aa4', textBright: '#0b0e18',
    primary: '#4257b2', primaryHover: '#35479a',
    secondary: '#7b4fb8', secondaryHover: '#663e9d',
    success: '#3f7d55', warning: '#96741d', error: '#b03f42', info: '#4257b2',
    shadowRgb: '24 30 56',
  },
  dark: {
    page: '#0e1119', card: '#161a26', recessed: '#1d2231', hover: '#252b3d',
    border: '#31384d',
    text: '#e2e6f2', textMuted: '#a0a7bf', textDim: '#666d85', textBright: '#ffffff',
    primary: '#7d8ff0', primaryHover: '#96a5f5',
    secondary: '#b18cf0', secondaryHover: '#c4a5f5',
    success: '#6fbb8a', warning: '#dcb45f', error: '#ea7a7d', info: '#7d8ff0',
    shadowRgb: '0 0 0',
  },
};

/**
 * GRAPHITE — pure neutral, no hue at all. The control: if a UI looks right
 * here, its hierarchy is carried by contrast and spacing rather than by colour.
 */
const graphite: Palette = {
  id: 'graphite',
  name: 'Graphite',
  description: 'Pure neutral greys. Hierarchy carried by contrast, not colour.',
  light: {
    page: '#f4f4f5', card: '#ffffff', recessed: '#ebebed', hover: '#e2e2e5',
    border: '#cbcbd0',
    text: '#1f1f22', textMuted: '#56565c', textDim: '#8a8a92', textBright: '#0a0a0c',
    primary: '#3f6ad8', primaryHover: '#3358bd',
    secondary: '#6b7280', secondaryHover: '#565c68',
    success: '#3f7d55', warning: '#96741d', error: '#b03f42', info: '#3f6ad8',
    shadowRgb: '24 24 27',
  },
  dark: {
    page: '#121214', card: '#1a1a1d', recessed: '#212125', hover: '#292930',
    border: '#35353c',
    text: '#e8e8ea', textMuted: '#a1a1a8', textDim: '#6a6a72', textBright: '#ffffff',
    primary: '#7c9df5', primaryHover: '#95b1f8',
    secondary: '#9ca3af', secondaryHover: '#b4bac4',
    success: '#6fbb8a', warning: '#dcb45f', error: '#ea7a7d', info: '#7c9df5',
    shadowRgb: '0 0 0',
  },
};

/**
 * CLASSIC — what Bubbly looked like before this system existed.
 *
 * Kept exactly as it was and listed last, so nobody who liked it loses it. Every
 * value here is lifted from the original theme.css rather than re-derived.
 */
const classic: Palette = {
  id: 'classic',
  name: 'Classic',
  description: 'The original warm paper and spice-gold. Kept exactly as it was.',
  light: {
    page: '#f6f5f2', card: '#fffffe', recessed: '#f4f2ee', hover: '#eeece7',
    border: '#dad5cc',
    text: '#1b1a16', textMuted: '#6a655c', textDim: '#9a958a', textBright: '#0c0c0f',
    primary: '#bd7d1c', primaryHover: '#a56a12',
    secondary: '#cb4b16', secondaryHover: '#b33f0f',
    success: '#859900', warning: '#b58900', error: '#dc322f', info: '#268bd2',
    shadowRgb: '30 26 20',
  },
  dark: {
    page: '#100f0c', card: '#1a1815', recessed: '#201d19', hover: '#24211c',
    border: '#332f28',
    text: '#ece6da', textMuted: '#a39c8c', textDim: '#726b5c', textBright: '#ffffff',
    primary: '#e0a94a', primaryHover: '#efbb63',
    secondary: '#cb4b16', secondaryHover: '#e55a1f',
    success: '#8a9a2b', warning: '#d9a441', error: '#dc4a3f', info: '#4a9fd4',
    shadowRgb: '0 0 0',
  },
};

/**
 * The order here is the order shown in Settings. Slate first because it is the
 * default; Classic last because it is the legacy option.
 */
export const PALETTES: Palette[] = [slate, paper, mint, lime, ember, moss, indigo, graphite, classic];

export const DEFAULT_PALETTE_ID = 'slate';

export type PaletteId = string;

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
