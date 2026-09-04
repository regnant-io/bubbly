/**
 * Tree-sitter backed symbol extraction.
 *
 * Replaces the regex/heuristic extractor in symbols.ts with real parse trees.
 * The heuristics silently misread anything with a non-trivial shape — generics,
 * decorators, multi-line signatures, nested classes — and those errors then
 * propagate invisibly into repo maps and task context, which is far worse than
 * a missing symbol because the model trusts them.
 *
 * WHY WASM AND NOT NATIVE BINDINGS
 * --------------------------------
 * The native `tree-sitter` packages need node-gyp per grammar and an ABI rebuild
 * for Electron — on a Windows-first desktop app that's a standing packaging
 * hazard (we already hit a privilege error shipping native tooling). Grammars
 * here are plain `.wasm` files loaded at runtime by `web-tree-sitter`, so there
 * is nothing to compile and packaging just copies files.
 *
 * INITIALIZATION MODEL
 * --------------------
 * Loading the WASM runtime + grammars is async, but the indexer (`buildIndex`)
 * is synchronous and hot. So: `initTreeSitter()` is awaited ONCE at startup and
 * grammars are cached; after that `extractSymbolsWithTreeSitter()` is fully
 * synchronous. Before init completes — or for a language/edge case we can't
 * handle — it returns null and the caller falls back to the heuristics, so code
 * intelligence degrades rather than breaks.
 */

import path from 'path';
// web-tree-sitter is pinned to 0.20.x to match the ABI the prebuilt grammars in
// `tree-sitter-wasms` were compiled against (that package builds with
// tree-sitter-cli ^0.20.8). Newer runtimes reject those .wasm files outright
// with a dylink metadata error, so DO NOT bump this without also replacing the
// grammar source. It exports a single CJS class, hence the default import.
import Parser from 'web-tree-sitter';
import { logger } from '../../utils/logger';
import type { CodeSymbol, FileSymbols, ImportEdge, SupportedLanguage, SymbolKind } from './symbols';

/**
 * Grammar wasm filename per supported language (tree-sitter-wasms package).
 *
 * RUBY IS DELIBERATELY ABSENT. Its grammar relies on an external scanner that
 * traps inside this WASM build ("Cannot read properties of undefined (reading
 * 'apply')") the moment you parse with it. The failure is caught and contained —
 * verified that a Ruby attempt does NOT corrupt the shared parser, TS and Go
 * still parse fine afterwards — but there's no point paying for a guaranteed
 * throw on every .rb file, so Ruby stays on the heuristic extractor. Re-add it
 * if a future grammar build fixes the scanner.
 */
const GRAMMAR_FILE: Partial<Record<SupportedLanguage, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
};

let _ready = false;
let _initPromise: Promise<boolean> | null = null;
const _languages = new Map<SupportedLanguage, Parser.Language>();
let _parser: Parser | null = null;

function grammarDir(): string {
  // Resolve through package.json so it works from src/ and dist/ alike, and
  // survives being copied into the packaged app's resources.
  const pkg = require.resolve('tree-sitter-wasms/package.json');
  return path.join(path.dirname(pkg), 'out');
}

/**
 * Load the WASM runtime and every grammar once. Idempotent and never throws —
 * a failure just leaves tree-sitter disabled and the heuristics in charge.
 */
export function initTreeSitter(): Promise<boolean> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const t0 = Date.now();
    try {
      await Parser.init();
      _parser = new Parser();
      const dir = grammarDir();
      let loaded = 0;
      for (const [lang, file] of Object.entries(GRAMMAR_FILE) as Array<[SupportedLanguage, string]>) {
        try {
          _languages.set(lang, await Parser.Language.load(path.join(dir, file)));
          loaded++;
        } catch (err) {
          logger.warn('Tree-sitter grammar failed to load; that language falls back to heuristics', {
            language: lang,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      _ready = loaded > 0;
      logger.info('Tree-sitter initialized', { grammars: loaded, durationMs: Date.now() - t0 });
      return _ready;
    } catch (err) {
      logger.warn('Tree-sitter unavailable — falling back to heuristic symbol extraction', {
        error: err instanceof Error ? err.message : String(err),
      });
      _ready = false;
      return false;
    }
  })();
  return _initPromise;
}

export function isTreeSitterReady(): boolean {
  return _ready;
}

/** Test seam: forget initialization so a test can re-init. */
export function _resetTreeSitterForTests(): void {
  _ready = false;
  _initPromise = null;
  _languages.clear();
  _parser = null;
}

// --- node-type tables -------------------------------------------------------

/**
 * Declaration node types → symbol kind, per language. Anything not listed is
 * ignored, which is deliberate: a missing symbol is recoverable, a WRONG one
 * quietly poisons the repo map.
 */
const DECLARATIONS: Record<string, Record<string, SymbolKind>> = {
  typescript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
    method_definition: 'method',
    method_signature: 'method',
  },
  javascript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    method_definition: 'method',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  rust: {
    function_item: 'function',
    struct_item: 'struct',
    enum_item: 'enum',
    trait_item: 'interface',
    mod_item: 'module',
    type_item: 'type',
  },
  java: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    method_declaration: 'method',
    record_declaration: 'struct',
  },
  csharp: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    struct_declaration: 'struct',
    enum_declaration: 'enum',
    method_declaration: 'method',
    record_declaration: 'struct',
  },
  ruby: {
    class: 'class',
    module: 'module',
    method: 'method',
    singleton_method: 'method',
  },
  php: {
    function_definition: 'function',
    class_declaration: 'class',
    interface_declaration: 'interface',
    trait_declaration: 'interface',
    enum_declaration: 'enum',
    method_declaration: 'method',
  },
};

/** Node types that establish a container (methods inside get its name). */
const CONTAINERS = new Set([
  'class_declaration', 'abstract_class_declaration', 'class_definition', 'class',
  'interface_declaration', 'struct_declaration', 'trait_item', 'impl_item',
  'enum_declaration', 'module', 'mod_item', 'record_declaration', 'trait_declaration',
]);

/** Import node types → the field/child holding the specifier. */
const IMPORTS: Record<string, string[]> = {
  typescript: ['import_statement'],
  javascript: ['import_statement'],
  python: ['import_statement', 'import_from_statement'],
  go: ['import_spec'],
  rust: ['use_declaration'],
  java: ['import_declaration'],
  csharp: ['using_directive'],
  ruby: ['call'],
  php: ['namespace_use_declaration'],
};

// --- extraction -------------------------------------------------------------

function nodeName(node: any): string | null {
  // Most grammars expose the declared name on a `name` field.
  const named = node.childForFieldName?.('name');
  if (named?.text) return named.text;
  // Go type_spec / Rust items sometimes nest it; fall back to the first
  // identifier-ish child.
  for (const child of node.namedChildren ?? []) {
    if (/identifier|type_identifier|field_identifier|constant|name/.test(child.type)) {
      return child.text;
    }
  }
  return null;
}

/** Is this declaration publicly visible? Language-specific notion of "exported". */
function isExported(node: any, language: SupportedLanguage, name: string): boolean {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      // An explicitly private/protected member is not public API, even when the
      // class around it is exported.
      const access = (node.namedChildren ?? []).find((c: any) => c.type === 'accessibility_modifier');
      if (access && /private|protected/.test(access.text)) return false;
      if (String(node.childForFieldName?.('name')?.text ?? '').startsWith('#')) return false; // #private field
      // `export function f()` wraps the declaration in an export_statement.
      let p = node.parent;
      while (p) {
        if (p.type === 'export_statement') return true;
        if (p.type === 'program') break;
        p = p.parent;
      }
      return false;
    }
    case 'python':
      return !name.startsWith('_');
    case 'go':
      return /^[A-Z]/.test(name); // Go exports by capitalization
    case 'rust':
      return (node.namedChildren ?? []).some((c: any) => c.type === 'visibility_modifier');
    case 'java':
    case 'csharp':
    case 'php':
      return /\bpublic\b/.test(node.childForFieldName?.('modifiers')?.text ?? node.text.slice(0, 80));
    case 'ruby':
      return true; // Ruby methods are public unless explicitly marked otherwise
    default:
      return false;
  }
}

/** First line of the declaration, tidied into a compact signature. */
function signatureOf(node: any): string {
  const firstLine = String(node.text ?? '').split('\n')[0];
  return firstLine.replace(/\s*[{:]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function specifierOf(node: any, language: SupportedLanguage): string | null {
  const unquote = (s: string) => s.replace(/^['"]|['"]$/g, '');

  if (language === 'ruby') {
    // Only `require`/`require_relative` calls count as imports.
    const fn = node.childForFieldName?.('method')?.text;
    if (fn !== 'require' && fn !== 'require_relative') return null;
    const arg = node.childForFieldName?.('arguments')?.namedChildren?.[0];
    return arg ? unquote(String(arg.text)) : null;
  }

  if (language === 'python') {
    // `from X import Y` — the EDGE is to module X, not to symbol Y. The generic
    // `name` field would hand back Y, which points the dependency graph at the
    // wrong node entirely.
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName?.('module_name');
      return mod ? String(mod.text).trim() : null;
    }
    const name = node.childForFieldName?.('name');
    return name ? String(name.text).trim() : null;
  }

  const source = node.childForFieldName?.('source') ?? node.childForFieldName?.('name');
  const raw = source?.text ?? node.text;
  const m = /['"]([^'"]+)['"]/.exec(String(raw));
  if (m) return m[1];
  // Non-quoted specifiers (Rust `use a::b`, Java/C# imports).
  return String(raw).replace(/^(use|import|using)\s+/, '').replace(/;$/, '').trim() || null;
}

/**
 * Extract symbols + imports using a real parse tree.
 * Returns null when tree-sitter can't handle this file, so the caller falls
 * back to the heuristic extractor rather than losing the file entirely.
 */
export function extractSymbolsWithTreeSitter(
  filePath: string,
  content: string,
  language: SupportedLanguage,
): FileSymbols | null {
  if (!_ready || !_parser) return null;
  const lang = _languages.get(language);
  const decls = DECLARATIONS[language];
  if (!lang || !decls) return null;

  let tree;
  try {
    _parser.setLanguage(lang);
    tree = _parser.parse(content);
  } catch (err) {
    logger.debug('Tree-sitter parse failed; falling back', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!tree) return null;

  const symbols: CodeSymbol[] = [];
  const imports: ImportEdge[] = [];
  const importTypes = new Set(IMPORTS[language] ?? []);

  const visit = (node: any, container?: string): void => {
    const kind = decls[node.type];

    if (importTypes.has(node.type)) {
      const spec = specifierOf(node, language);
      if (spec) imports.push({ specifier: spec, line: node.startPosition.row + 1 });
    }

    let nextContainer = container;
    if (kind) {
      const name = nodeName(node);
      if (name) {
        symbols.push({
          name,
          // A function nested in a class reads as a method regardless of the
          // grammar's node name (Python/Ruby use the same node for both).
          kind: container && (kind === 'function' || kind === 'method') ? 'method' : kind,
          line: node.startPosition.row + 1,
          signature: signatureOf(node),
          exported: isExported(node, language, name),
          ...(container ? { container } : {}),
        });
        if (CONTAINERS.has(node.type)) nextContainer = name;
      }
    } else if (CONTAINERS.has(node.type)) {
      const name = nodeName(node);
      if (name) nextContainer = name;
    }

    for (const child of node.namedChildren ?? []) visit(child, nextContainer);
  };

  try {
    visit(tree.rootNode);
  } catch (err) {
    logger.debug('Tree-sitter walk failed; falling back', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    tree.delete?.();
  }

  return { path: filePath, language, symbols, imports };
}
