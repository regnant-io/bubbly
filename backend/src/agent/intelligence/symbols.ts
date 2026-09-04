/**
 * Symbol Extraction — the foundation of Bubbly's code intelligence.
 *
 * Per dream.md ("ASTs are everything"), the agent must understand code as
 * STRUCTURE, not text. Extraction is therefore tree-sitter FIRST — see
 * treeSitter.ts, which parses real syntax trees from WASM grammars (no native
 * build step, so desktop packaging stays simple).
 *
 * The multi-language heuristic extractor below is now the FALLBACK, used when
 * tree-sitter hasn't finished initializing, has no grammar for the language, or
 * fails on a given file. It pulls out the same shapes — functions, classes,
 * methods, interfaces, types, enums, and the import/export edges between files —
 * just less precisely (it misreads generics, decorators and multi-line
 * signatures, which is exactly why tree-sitter takes precedence).
 *
 * The output feeds three things:
 *   1. The repo map (compressed structural overview ranked by relevance)
 *   2. The symbol index (find_symbol / find_references)
 *   3. Per-task context packing (give weak models exactly the right signatures)
 */

import path from 'path';
import { extractSymbolsWithTreeSitter } from './treeSitter';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'struct'
  | 'module';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-indexed line where the symbol is declared. */
  line: number;
  /** A compact, single-line signature used in the repo map. */
  signature: string;
  /** Whether the symbol is exported / public. */
  exported: boolean;
  /** Enclosing symbol name (e.g. the class a method belongs to). */
  container?: string;
}

export interface ImportEdge {
  /** The raw import specifier as written in source (e.g. "./auth", "react"). */
  specifier: string;
  /** 1-indexed line of the import. */
  line: number;
}

export interface FileSymbols {
  path: string;
  language: SupportedLanguage;
  symbols: CodeSymbol[];
  imports: ImportEdge[];
}

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'other';

const EXT_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
};

export function detectLanguage(filePath: string): SupportedLanguage {
  return EXT_LANGUAGE[path.extname(filePath).toLowerCase()] ?? 'other';
}

/** Strip a trailing comment and clamp a signature to a single tidy line. */
function cleanSignature(raw: string, max = 160): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Drop an opening brace / colon block starter for compactness.
  s = s.replace(/\s*\{\s*$/, '').replace(/:\s*$/, '');
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/**
 * Extract symbols + imports from a source file.
 * Dispatches to a language-specific extractor with a generic fallback.
 */
export function extractSymbols(filePath: string, content: string): FileSymbols {
  const language = detectLanguage(filePath);

  // Prefer a real parse tree. Returns null when tree-sitter isn't initialized
  // yet, the language has no grammar, or the parse failed — in which case we
  // fall through to the heuristics below so indexing degrades instead of
  // breaking. See treeSitter.ts for the initialization model.
  const parsed = extractSymbolsWithTreeSitter(filePath, content, language);
  if (parsed) return parsed;

  let symbols: CodeSymbol[] = [];
  let imports: ImportEdge[] = [];

  switch (language) {
    case 'typescript':
    case 'javascript':
      ({ symbols, imports } = extractJsTs(content));
      break;
    case 'python':
      ({ symbols, imports } = extractPython(content));
      break;
    case 'go':
      ({ symbols, imports } = extractGo(content));
      break;
    case 'rust':
      ({ symbols, imports } = extractRust(content));
      break;
    case 'java':
    case 'csharp':
      ({ symbols, imports } = extractCLike(content));
      break;
    default:
      symbols = [];
      imports = [];
  }

  return { path: filePath.replace(/\\/g, '/'), language, symbols, imports };
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

function extractJsTs(content: string): { symbols: CodeSymbol[]; imports: ImportEdge[] } {
  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const lines = content.split('\n');

  // Track class scope by brace depth so we can attribute methods to a container.
  let classStack: Array<{ name: string; depth: number }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Imports (ES + require + dynamic).
    const imp =
      /^\s*import\b[^'"]*['"]([^'"]+)['"]/.exec(line) ||
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line) ||
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line) ||
      /^\s*export\b[^'"]*\bfrom\s+['"]([^'"]+)['"]/.exec(line);
    if (imp) imports.push({ specifier: imp[1], line: lineNo });

    const exported = /^\s*export\b/.test(line);
    const currentClass = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;

    // class / interface / enum / type
    let m: RegExpExecArray | null;
    if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'class', line: lineNo, signature: cleanSignature(trimmed), exported });
      classStack.push({ name: m[1], depth });
    } else if ((m = /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'interface', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if ((m = /^\s*(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'enum', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if ((m = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/.exec(line))) {
      symbols.push({ name: m[1], kind: 'type', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'function', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if (
      (m = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(line))
    ) {
      // Arrow function / function expression assigned to a binding.
      symbols.push({ name: m[1], kind: 'function', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if (
      (m = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/.exec(line))
    ) {
      // SCREAMING_CASE const → treat as a meaningful constant.
      symbols.push({ name: m[1], kind: 'constant', line: lineNo, signature: cleanSignature(trimmed), exported });
    } else if (
      currentClass &&
      (m = /^\s*(?:public|private|protected|static|readonly|async|get|set|override|\*|\s)*\b([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*(?:\{|$)/.exec(line)) &&
      !/\b(if|for|while|switch|catch|return|function|await|new)\b/.test(m[1])
    ) {
      // Method inside a class body.
      symbols.push({
        name: m[1],
        kind: 'method',
        line: lineNo,
        signature: cleanSignature(trimmed),
        exported: false,
        container: currentClass,
      });
    }

    // Track brace depth and pop class scopes as they close.
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (classStack.length > 0 && depth < classStack[classStack.length - 1].depth + 1) {
          classStack.pop();
        }
      }
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPython(content: string): { symbols: CodeSymbol[]; imports: ImportEdge[] } {
  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const lines = content.split('\n');

  // Indentation stack to attribute methods to their class.
  const classStack: Array<{ name: string; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const indent = line.length - line.trimStart().length;

    // Pop classes whose block we've exited.
    while (classStack.length > 0 && line.trim() !== '' && indent <= classStack[classStack.length - 1].indent) {
      classStack.pop();
    }

    let m: RegExpExecArray | null;
    if ((m = /^\s*from\s+([.\w]+)\s+import\b/.exec(line))) {
      imports.push({ specifier: m[1], line: lineNo });
    } else if ((m = /^\s*import\s+([.\w]+)/.exec(line))) {
      imports.push({ specifier: m[1], line: lineNo });
    }

    if ((m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line))) {
      symbols.push({ name: m[1], kind: 'class', line: lineNo, signature: cleanSignature(line.trim()), exported: !m[1].startsWith('_') });
      classStack.push({ name: m[1], indent });
    } else if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line))) {
      const container = classStack.length > 0 ? classStack[classStack.length - 1].name : undefined;
      symbols.push({
        name: m[1],
        kind: container ? 'method' : 'function',
        line: lineNo,
        signature: cleanSignature(line.trim()),
        exported: !m[1].startsWith('_'),
        container,
      });
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function extractGo(content: string): { symbols: CodeSymbol[]; imports: ImportEdge[] } {
  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const lines = content.split('\n');
  let inImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (/^import\s*\(/.test(trimmed)) { inImportBlock = true; continue; }
    if (inImportBlock) {
      if (/^\)/.test(trimmed)) { inImportBlock = false; continue; }
      const im = /"([^"]+)"/.exec(trimmed);
      if (im) imports.push({ specifier: im[1], line: lineNo });
      continue;
    }
    const single = /^import\s+"([^"]+)"/.exec(trimmed);
    if (single) imports.push({ specifier: single[1], line: lineNo });

    let m: RegExpExecArray | null;
    if ((m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'function', line: lineNo, signature: cleanSignature(trimmed), exported: /^[A-Z]/.test(m[1]) });
    } else if ((m = /^type\s+([A-Za-z_]\w*)\s+struct/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'struct', line: lineNo, signature: cleanSignature(trimmed), exported: /^[A-Z]/.test(m[1]) });
    } else if ((m = /^type\s+([A-Za-z_]\w*)\s+interface/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'interface', line: lineNo, signature: cleanSignature(trimmed), exported: /^[A-Z]/.test(m[1]) });
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function extractRust(content: string): { symbols: CodeSymbol[]; imports: ImportEdge[] } {
  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNo = i + 1;
    let m: RegExpExecArray | null;

    if ((m = /^use\s+([\w:]+)/.exec(trimmed))) imports.push({ specifier: m[1], line: lineNo });

    if ((m = /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'function', line: lineNo, signature: cleanSignature(trimmed), exported: /^pub\b/.test(trimmed) });
    } else if ((m = /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'struct', line: lineNo, signature: cleanSignature(trimmed), exported: /^pub\b/.test(trimmed) });
    } else if ((m = /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'enum', line: lineNo, signature: cleanSignature(trimmed), exported: /^pub\b/.test(trimmed) });
    } else if ((m = /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/.exec(trimmed))) {
      symbols.push({ name: m[1], kind: 'interface', line: lineNo, signature: cleanSignature(trimmed), exported: /^pub\b/.test(trimmed) });
    }
  }

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Java / C#
// ---------------------------------------------------------------------------

function extractCLike(content: string): { symbols: CodeSymbol[]; imports: ImportEdge[] } {
  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const lines = content.split('\n');
  const classStack: Array<{ name: string; depth: number }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;
    let m: RegExpExecArray | null;

    if ((m = /^\s*(?:import|using)\s+([\w.]+)/.exec(line))) {
      imports.push({ specifier: m[1], line: lineNo });
    }

    if ((m = /\b(?:public|private|protected|internal|static|abstract|final|sealed|\s)*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/.exec(line))) {
      const kind: SymbolKind = /interface/.test(line) ? 'interface' : /enum/.test(line) ? 'enum' : /struct/.test(line) ? 'struct' : 'class';
      symbols.push({ name: m[1], kind, line: lineNo, signature: cleanSignature(trimmed), exported: /\bpublic\b/.test(line) });
      classStack.push({ name: m[1], depth });
    } else if (
      classStack.length > 0 &&
      (m = /^\s*(?:public|private|protected|internal|static|virtual|override|async|final|abstract|\s)+[\w<>\[\],\s.]+\s+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{?\s*$/.exec(line)) &&
      !/\b(if|for|while|switch|catch|return|new)\b/.test(m[1])
    ) {
      symbols.push({
        name: m[1],
        kind: 'method',
        line: lineNo,
        signature: cleanSignature(trimmed),
        exported: /\bpublic\b/.test(line),
        container: classStack[classStack.length - 1].name,
      });
    }

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (classStack.length > 0 && depth < classStack[classStack.length - 1].depth + 1) classStack.pop();
      }
    }
  }

  return { symbols, imports };
}
