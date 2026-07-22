/**
 * Write-integrity / truncation detection.
 *
 * The dominant cause of "corrupted files" is NOT the model writing wrong code —
 * it's the generation getting CUT OFF mid-file when it hits the context-window
 * ceiling (num_ctx) while emitting file content inside a tool-call argument. We
 * then write the truncated partial content with no detection. This is model
 * independent: any model on a bounded window hits it on a large file.
 *
 * This module inspects written content for the tell-tale signs of truncation so
 * the orchestrator can SELF-HEAL the file (append the missing remainder) instead
 * of silently leaving it broken.
 *
 * A vibecoding app emits far more than C-style source: stylesheets, HTML, JSON,
 * config and markdown all get cut off too. So detection is FORMAT-AWARE — each
 * family has its own structural notion of "obviously incomplete":
 *   - code   (braces/parens/brackets + comments + strings)
 *   - style  (CSS/SCSS/LESS — brace balance; '#' is NOT a comment here)
 *   - markup (HTML/XML/Vue/Svelte — unterminated tag / unclosed elements)
 *   - json   (must be fully closed; net-open braces ⇒ incomplete)
 *   - config (YAML/TOML — unterminated string / open flow collection)
 *   - markdown (unbalanced ``` code fence)
 *
 * It stays conservative to avoid false positives on intentionally-partial files
 * being built incrementally: it only flags content that is BOTH structurally
 * open AND ends abruptly (for the error-prone grammars), while the simpler,
 * always-fully-closed grammars (JSON/CSS) can flag a net-open structure alone.
 */

export interface TruncationFinding {
  truncated: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Language / format classification
// ---------------------------------------------------------------------------

type Category = 'code' | 'style' | 'markup' | 'json' | 'config' | 'markdown';

interface CodeProfile {
  /** Line-comment tokens (e.g. ['//'], ['#'], ['--']). */
  line: string[];
  /** Block comment delimiters, if any. */
  block?: [string, string];
  /** String delimiters. */
  strings: string[];
}

interface Classification {
  category: Category;
  code?: CodeProfile;
  /** JSON-with-comments (jsonc/json5) allows // and /* *​/ and trailing data. */
  jsonc?: boolean;
}

const C_STYLE: CodeProfile = { line: ['//'], block: ['/*', '*/'], strings: ['"', "'", '`'] };
const HASH_STYLE: CodeProfile = { line: ['#'], strings: ['"', "'", '`'] };
const DASH_STYLE: CodeProfile = { line: ['--'], block: ['/*', '*/'], strings: ['"', "'"] };
const LUA_STYLE: CodeProfile = { line: ['--'], block: ['--[[', ']]'], strings: ['"', "'"] };

// Extension → classification. Kept generous so virtually any file a vibecoding
// session emits is covered. Unknown extensions fall through to "no detection"
// (we never want to risk corrupting a format we don't understand).
const EXT_MAP: Record<string, Classification> = {};

const register = (exts: string[], c: Classification) => {
  for (const e of exts) EXT_MAP[e] = c;
};

// --- Code: C-style comments ---
register(
  [
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'cjsx',
    'java', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'pde',
    'cs', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'sc', 'php', 'phtml',
    'dart', 'groovy', 'gradle', 'm', 'mm', 'hlsl', 'glsl', 'frag', 'vert',
    'proto', 'sol', 'zig', 'v', 'd', 'cu', 'cuh', 'as', 'haxe', 'hx', 'fs', 'fsx',
  ],
  { category: 'code', code: C_STYLE }
);

// --- Code: hash-comment ---
register(
  [
    'py', 'pyw', 'pyi', 'rb', 'rake', 'gemspec', 'sh', 'bash', 'zsh', 'fish',
    'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'nim', 'cr', 'tcl', 'awk', 'ps1', 'psm1',
    'coffee',
  ],
  { category: 'code', code: HASH_STYLE }
);

// --- Code: dash-comment ---
register(['sql', 'hs', 'elm', 'lhs', 'ada', 'adb', 'vhd', 'vhdl'], { category: 'code', code: DASH_STYLE });
register(['lua'], { category: 'code', code: LUA_STYLE });

// --- Style ---
register(['css', 'scss', 'sass', 'less', 'pcss', 'postcss', 'styl'], { category: 'style' });

// --- Markup ---
register(
  ['html', 'htm', 'xhtml', 'xml', 'svg', 'vue', 'svelte', 'astro', 'rss', 'atom', 'plist', 'xaml', 'wxml', 'axml', 'resx', 'csproj', 'targets', 'props'],
  { category: 'markup' }
);

// --- JSON (strict + jsonc/json5) ---
register(['json', 'geojson', 'webmanifest', 'ipynb', 'arb', 'avsc', 'har'], { category: 'json' });
register(['jsonc', 'json5'], { category: 'json', jsonc: true });

// --- Config (YAML/TOML) ---
register(['yaml', 'yml', 'toml'], { category: 'config' });

// --- Markdown ---
register(['md', 'mdx', 'markdown', 'mdown', 'mkd', 'mkdn'], { category: 'markdown' });

function classify(filePath: string): Classification | null {
  const m = /\.([a-z0-9]+)$/i.exec(filePath);
  if (!m) return null;
  return EXT_MAP[m[1].toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The last non-empty line, trimmed at the end. */
function lastNonEmptyLine(content: string): string {
  const lines = content.split('\n');
  let i = lines.length - 1;
  while (i > 0 && lines[i].trim() === '') i--;
  return lines[i].trimEnd();
}

function endsWithoutNewline(content: string): boolean {
  return !content.endsWith('\n');
}

interface Balance {
  paren: number;
  bracket: number;
  brace: number;
  inString: boolean;
}

/**
 * Count delimiter balance for a given comment/string profile, ignoring anything
 * inside (rough) strings and comments.
 */
function delimiterBalance(content: string, profile: CodeProfile): Balance {
  let paren = 0, bracket = 0, brace = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlock = false;
  let prev = '';
  const { line, block, strings } = profile;
  const blockOpen = block?.[0];
  const blockClose = block?.[1];

  const startsWith = (tok: string, i: number) => content.startsWith(tok, i);

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === '\n') { inLineComment = false; prev = ch; continue; }
    if (inLineComment) { prev = ch; continue; }

    if (inBlock) {
      if (blockClose && startsWith(blockClose, i)) { inBlock = false; i += blockClose.length - 1; }
      prev = ch;
      continue;
    }

    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      prev = ch;
      continue;
    }

    // Line comment?
    let matchedLine = false;
    for (const tok of line) {
      if (startsWith(tok, i)) { inLineComment = true; i += tok.length - 1; matchedLine = true; break; }
    }
    if (matchedLine) { prev = ch; continue; }

    // Block comment open?
    if (blockOpen && startsWith(blockOpen, i)) { inBlock = true; i += blockOpen.length - 1; prev = ch; continue; }

    // String open?
    if (strings.includes(ch)) { inString = ch; prev = ch; continue; }

    if (ch === '(') paren++; else if (ch === ')') paren--;
    else if (ch === '[') bracket++; else if (ch === ']') bracket--;
    else if (ch === '{') brace++; else if (ch === '}') brace--;
    prev = ch;
  }

  return { paren, bracket, brace, inString: inString !== null };
}

function openDescriptor(b: Balance): string {
  if (b.brace > 0) return `${b.brace} unclosed '{'`;
  if (b.paren > 0) return `${b.paren} unclosed '('`;
  if (b.bracket > 0) return `${b.bracket} unclosed '['`;
  return 'unclosed delimiters';
}

// ---------------------------------------------------------------------------
// Per-category detectors
// ---------------------------------------------------------------------------

const CODE_DANGLING = /[=({[,.:+\-*/%&|<>]$|\b(return|const|let|var|import|from|def|class|function|async|await|if|else|elif|for|while|new|export|public|private|protected|fn|func|struct|impl|match|case|switch)$/;

function detectCode(content: string, profile: CodeProfile): TruncationFinding {
  const bal = delimiterBalance(content, profile);

  if (bal.inString) {
    return { truncated: true, reason: 'ends inside an unterminated string literal' };
  }

  const structurallyOpen = bal.paren > 0 || bal.bracket > 0 || bal.brace > 0;
  const lastLine = lastNonEmptyLine(content);
  const dangling = CODE_DANGLING.test(lastLine);
  const noNewline = endsWithoutNewline(content);

  // Conservative: the rough string/comment scan can mis-count (regex literals,
  // template-literal interpolation, private '#fields'), so require BOTH an open
  // structure AND an abrupt ending before flagging.
  if (structurallyOpen && (dangling || noNewline)) {
    return { truncated: true, reason: `appears cut off mid-file (${openDescriptor(bal)}; last line: "${lastLine.slice(-60)}")` };
  }
  if (dangling && noNewline) {
    return { truncated: true, reason: `ends mid-statement ("${lastLine.slice(-60)}")` };
  }
  return { truncated: false };
}

const STYLE_PROFILE_BLOCKONLY: CodeProfile = { line: [], block: ['/*', '*/'], strings: ['"', "'"] };
const STYLE_PROFILE_WITHLINE: CodeProfile = { line: ['//'], block: ['/*', '*/'], strings: ['"', "'"] };

function detectStyle(filePath: string, content: string): TruncationFinding {
  // SCSS/LESS support // line comments; plain CSS does not. '#' is NEVER a
  // comment in any of them (it's IDs / hex colors), so it must not be stripped.
  const usesLine = /\.(scss|sass|less)$/i.test(filePath);
  const bal = delimiterBalance(content, usesLine ? STYLE_PROFILE_WITHLINE : STYLE_PROFILE_BLOCKONLY);

  if (bal.inString) {
    return { truncated: true, reason: 'ends inside an unterminated string literal' };
  }
  // A complete stylesheet always closes every block. Net-open braces/parens are
  // a reliable, low-false-positive signal of truncation.
  if (bal.brace > 0 || bal.paren > 0) {
    return { truncated: true, reason: `stylesheet cut off mid-rule (${openDescriptor(bal)})` };
  }
  // Even when balanced, a dangling declaration with no trailing newline is suspect.
  const lastLine = lastNonEmptyLine(content);
  if (/[:{(,]$/.test(lastLine) && endsWithoutNewline(content)) {
    return { truncated: true, reason: `ends mid-declaration ("${lastLine.slice(-60)}")` };
  }
  return { truncated: false };
}

const JSON_PROFILE: CodeProfile = { line: [], strings: ['"'] };
const JSONC_PROFILE: CodeProfile = { line: ['//'], block: ['/*', '*/'], strings: ['"', "'"] };

function detectJson(content: string, jsonc: boolean): TruncationFinding {
  const bal = delimiterBalance(content, jsonc ? JSONC_PROFILE : JSON_PROFILE);
  if (bal.inString) {
    return { truncated: true, reason: 'JSON ends inside an unterminated string' };
  }
  // Valid JSON is always fully closed.
  if (bal.brace > 0 || bal.bracket > 0) {
    return { truncated: true, reason: `JSON cut off — ${openDescriptor(bal)}` };
  }
  const lastLine = lastNonEmptyLine(content);
  if (/[{[,:]$/.test(lastLine)) {
    return { truncated: true, reason: `JSON ends mid-value ("${lastLine.slice(-60)}")` };
  }
  return { truncated: false };
}

// HTML void elements + declarations that never need a closing tag.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input',
  'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function detectMarkup(content: string): TruncationFinding {
  // Unterminated comment is a clear cut-off.
  const lastCommentOpen = content.lastIndexOf('<!--');
  if (lastCommentOpen !== -1 && content.indexOf('-->', lastCommentOpen) === -1) {
    return { truncated: true, reason: 'ends inside an unterminated <!-- comment -->' };
  }

  // Strip comments, CDATA and the doctype/processing-instructions so they don't
  // confuse tag scanning.
  const cleaned = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<![^>]*>/g, '')      // doctype
    .replace(/<\?[\s\S]*?\?>/g, ''); // <?xml ... ?>

  // Ends mid-tag: an opening '<' with no closing '>' after it.
  const lastLt = cleaned.lastIndexOf('<');
  const lastGt = cleaned.lastIndexOf('>');
  if (lastLt > lastGt) {
    return { truncated: true, reason: 'ends inside an unterminated tag' };
  }

  // Tag balance: net-open block elements ⇒ document was cut off before closing.
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = m[3] === '/';
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === name) { stack.length = i; break; }
      }
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    return { truncated: true, reason: `unclosed <${stack[stack.length - 1]}> element` };
  }
  return { truncated: false };
}

const CONFIG_PROFILE: CodeProfile = { line: ['#'], strings: ['"', "'"] };

function detectConfig(content: string): TruncationFinding {
  // YAML/TOML are whitespace/line oriented — structural truncation is hard to
  // judge without false positives, so only flag the unambiguous signals:
  // an unterminated quoted string, or an open inline/flow collection.
  const bal = delimiterBalance(content, CONFIG_PROFILE);
  if (bal.inString) {
    return { truncated: true, reason: 'ends inside an unterminated quoted string' };
  }
  if (bal.bracket > 0 || bal.brace > 0) {
    return { truncated: true, reason: `cut off inside a flow collection (${openDescriptor(bal)})` };
  }
  return { truncated: false };
}

function detectMarkdown(content: string): TruncationFinding {
  // An odd number of ``` fences means a code block was opened but never closed.
  const fences = (content.match(/^[ \t]*```/gm) ?? []).length;
  if (fences % 2 !== 0) {
    return { truncated: true, reason: 'ends inside an unclosed ``` code fence' };
  }
  return { truncated: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether `content` written to `filePath` looks truncated. Dispatches to
 * a format-aware detector based on the file extension. Unknown/extension-less
 * files are never flagged (we don't risk healing a format we can't reason about).
 */
export function detectTruncatedWrite(filePath: string, content: string): TruncationFinding {
  if (content.trim().length === 0) return { truncated: false };

  const cls = classify(filePath);
  if (!cls) return { truncated: false };

  switch (cls.category) {
    case 'code': return detectCode(content, cls.code ?? C_STYLE);
    case 'style': return detectStyle(filePath, content);
    case 'markup': return detectMarkup(content);
    case 'json': return detectJson(content, !!cls.jsonc);
    case 'config': return detectConfig(content);
    case 'markdown': return detectMarkdown(content);
    default: return { truncated: false };
  }
}
