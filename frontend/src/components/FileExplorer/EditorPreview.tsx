import React from 'react';
import { useStore } from '../../store';
import { MarkdownContent } from '../Shared/MarkdownContent';
import { BubblyPreview } from '../BubbleRoom/BubblyPreview';
import { Globe, Eye, ListTree, Image as ImageIcon, Table as TableIcon } from '../Shared/icons';

/** How the pane should present the file currently open in the editor. */
export type PreviewMode = 'rendered' | 'app' | 'outline';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';

/**
 * Files whose rendered form is genuinely different from their source, and
 * therefore worth a second pane. A .ts file has no "rendered" version — showing
 * one would just be the same text twice — so those default to the outline.
 */
export function hasRenderedForm(path: string): boolean {
  const e = ext(path);
  return e === 'md' || e === 'markdown' || e === 'html' || e === 'htm' || e === 'svg'
    || e === 'json' || e === 'csv' || e === 'tsv' || IMAGE_EXTS.has(e);
}

/** The default mode for a file: render it if it renders, else show its shape. */
export function defaultMode(path: string): PreviewMode {
  return hasRenderedForm(path) ? 'rendered' : 'outline';
}

/** A rough symbol outline, from source text.
 *
 *  Deliberately regex-based and deliberately labelled "approximate" in the UI.
 *  The backend has a real tree-sitter index, but it is built for the agent's
 *  retrieval path and isn't exposed per-file over HTTP; adding that round-trip
 *  to every keystroke-adjacent render would cost far more than this heuristic,
 *  which gets the top-level declarations right in every language the editor
 *  commonly opens. It is a navigation aid, not an analysis.
 */
function extractOutline(content: string, path: string): Array<{ line: number; kind: string; name: string; depth: number }> {
  const e = ext(path);
  const out: Array<{ line: number; kind: string; name: string; depth: number }> = [];
  const lines = content.split('\n');

  if (e === 'md' || e === 'markdown') {
    lines.forEach((l, i) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(l);
      if (m) out.push({ line: i + 1, kind: 'heading', name: m[2].trim(), depth: m[1].length - 1 });
    });
    return out;
  }

  if (e === 'css' || e === 'scss' || e === 'less') {
    lines.forEach((l, i) => {
      const m = /^([.#@&][^{;]{0,80}|[a-zA-Z][\w-]*(?:[^{;]{0,80})?)\s*\{\s*$/.exec(l.trim());
      if (m) out.push({ line: i + 1, kind: 'rule', name: m[1].trim(), depth: 0 });
    });
    return out;
  }

  const patterns: Array<{ re: RegExp; kind: string }> = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'function' },
    { re: /^\s*def\s+([A-Za-z_][\w]*)/, kind: 'function' },
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: 'function' },
    { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/, kind: 'function' },
    { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/, kind: 'struct' },
  ];

  lines.forEach((l, i) => {
    for (const { re, kind } of patterns) {
      const m = re.exec(l);
      if (m) {
        const indent = /^(\s*)/.exec(l)?.[1].length ?? 0;
        out.push({ line: i + 1, kind, name: m[1], depth: Math.min(2, Math.floor(indent / 2)) });
        return;
      }
    }
  });
  return out;
}

/** Split CSV/TSV into rows. Handles quoted fields containing the delimiter. */
function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function DataTable({ rows }: { rows: string[][] }) {
  const MAX = 500;
  const [header, ...body] = rows;
  const shown = body.slice(0, MAX);
  return (
    <div className="p-2">
      <div className="overflow-auto">
        <table className="text-[11px] border-collapse">
          <thead>
            <tr>
              {header?.map((h, i) => (
                <th key={i} className="sticky top-0 bg-surface-2 border border-border px-2 py-1 text-left font-semibold text-text whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri} className="hover:bg-surface-2/50">
                {header?.map((_, ci) => (
                  <td key={ci} className="border border-border px-2 py-0.5 text-text-muted whitespace-nowrap max-w-[280px] truncate">
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > MAX && (
        <p className="mt-2 text-[10px] text-text-dim">
          Showing the first {MAX.toLocaleString()} of {body.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

function Outline({ content, path, onJump }: { content: string; path: string; onJump: (line: number) => void }) {
  const items = React.useMemo(() => extractOutline(content, path), [content, path]);
  if (items.length === 0) {
    return <div className="p-4 text-xs text-text-dim">No symbols found in this file.</div>;
  }
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-text-dim">
        Outline · approximate
      </div>
      {items.map((s, i) => (
        <button
          key={i}
          onClick={() => onJump(s.line)}
          className="w-full flex items-baseline gap-2 px-3 py-0.5 text-left text-xs hover:bg-surface-3 transition-colors"
          style={{ paddingLeft: 12 + s.depth * 12 }}
        >
          <span className="shrink-0 text-[9px] uppercase text-text-dim/70 w-14">{s.kind}</span>
          <span className="truncate text-text-muted">{s.name}</span>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-dim/50">{s.line}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The pane beside the editor: the open file as it will actually be seen.
 *
 * Three modes, because "preview" means different things for different files.
 * A markdown file has a rendered form; a React component does not — its
 * rendered form is the running app, which is why 'app' exists and why it is the
 * default offer for source files once a dev server is up. And a file with
 * neither gets its outline, which is the only useful "overview" a source file
 * has.
 *
 * The app mode reuses the real Bubbly Preview rather than a second embedded
 * browser: one preview, one dev-server lifecycle, one thing the agent drives.
 */
export function EditorPreview({
  path,
  content,
  mode,
  onModeChange,
  onJumpToLine,
}: {
  path: string;
  content: string;
  mode: PreviewMode;
  onModeChange: (m: PreviewMode) => void;
  onJumpToLine: (line: number) => void;
}) {
  const workspacePath = useStore((s) => s.workspacePath);
  const e = ext(path);
  const renderable = hasRenderedForm(path);

  const MODES: Array<{ id: PreviewMode; label: string; icon: typeof Eye; enabled: boolean; title: string }> = [
    { id: 'rendered', label: 'Preview', icon: renderable && IMAGE_EXTS.has(e) ? ImageIcon : renderable && (e === 'csv' || e === 'tsv') ? TableIcon : Eye, enabled: renderable, title: renderable ? 'Render this file' : 'This file type has no rendered form' },
    { id: 'app', label: 'App', icon: Globe, enabled: true, title: 'The running app (Bubbly Preview)' },
    { id: 'outline', label: 'Outline', icon: ListTree, enabled: true, title: 'Symbols in this file' },
  ];

  const body = () => {
    if (mode === 'app') return <BubblyPreview />;
    if (mode === 'outline') return <Outline content={content} path={path} onJump={onJumpToLine} />;

    if (IMAGE_EXTS.has(e) || e === 'svg') {
      return (
        <div className="h-full overflow-auto p-4 flex items-start justify-center">
          <img
            src={`/api/files/raw?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(path)}`}
            alt={path}
            className="max-w-full h-auto rounded border border-border bg-white"
          />
        </div>
      );
    }
    if (e === 'md' || e === 'markdown') {
      return <div className="p-4"><MarkdownContent content={content} /></div>;
    }
    if (e === 'html' || e === 'htm') {
      // Sandboxed with no allow-same-origin: the page being edited must not be
      // able to reach Bubbly's DOM or its API just because it's open in a tab.
      return (
        <iframe
          title={path}
          srcDoc={content}
          sandbox="allow-scripts allow-forms allow-popups"
          className="w-full h-full border-0 bg-white"
        />
      );
    }
    if (e === 'json') {
      let pretty = content;
      let invalid = false;
      try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch { invalid = true; }
      return (
        <div className="p-3">
          {invalid && (
            <div className="mb-2 px-2 py-1 rounded bg-error-bg text-[11px] text-red-agent">
              Not valid JSON — showing the raw text.
            </div>
          )}
          <MarkdownContent content={'```json\n' + pretty + '\n```'} />
        </div>
      );
    }
    if (e === 'csv' || e === 'tsv') {
      return <DataTable rows={parseDelimited(content, e === 'tsv' ? '\t' : ',')} />;
    }
    return <div className="p-4 text-xs text-text-dim">Nothing to render for this file type.</div>;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-surface-0">
      <div className="flex items-center gap-0.5 px-2 h-8 border-b border-border shrink-0">
        {MODES.map(({ id, label, icon: Icon, enabled, title }) => (
          <button
            key={id}
            onClick={() => enabled && onModeChange(id)}
            disabled={!enabled}
            title={title}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors disabled:opacity-30 ${
              mode === id ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text hover:bg-surface-3'
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{body()}</div>
    </div>
  );
}
