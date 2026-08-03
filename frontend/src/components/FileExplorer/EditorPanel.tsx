import React, { Suspense } from 'react';
import { useStore } from '../../store';
import { fetchFileContent, saveFileContent } from '../../hooks/useApi';
import { X, FileCode, Search, Wrench, Columns2, PanelRightClose, ChevronRight, Save } from '../Shared/icons';
import { getFileIcon } from './fileIcons';
import { ResizablePanel } from '../Shared/ResizablePanel';
import { EditorPreview, defaultMode, hasRenderedForm, type PreviewMode } from './EditorPreview';
import { useAppContextMenu } from '../Shared/ContextMenu';

// Lazy load Monaco to avoid blocking initial render
const MonacoEditor = React.lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default }))
);

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    c: 'c', cpp: 'cpp', cs: 'csharp', swift: 'swift', kt: 'kotlin',
    php: 'php', html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sh: 'shell', bash: 'shell',
    sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
  };
  return (ext && map[ext]) ?? 'plaintext';
}

export function EditorPanel() {
  const {
    editorTabs, activeEditorPath, openFileContent, workspacePath, settings, resolvedTheme,
    setActiveEditorTab, closeEditorTab, updateTabContent, setTabDirtyContent, markTabSaved, setEditorStatus,
  } = useStore();
  const [saving, setSaving] = React.useState<string | null>(null);
  const autoSaveTimers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { bind } = useAppContextMenu();
  // The live Monaco instance, so the toolbar can drive its built-in commands
  // (find, format) rather than reimplementing them.
  const editorRef = React.useRef<any>(null);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath) ?? null;
  const activeContent = activeTab ? (activeTab.content ?? openFileContent) : null;

  // --- The preview pane ------------------------------------------------------
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewMode, setPreviewMode] = React.useState<PreviewMode>('outline');
  // Both the mode AND whether the pane is open follow the file — but only until
  // the user decides for themselves. Opening a README should show the rendered
  // README without being asked; having that same automation slam the pane shut
  // on someone who deliberately opened it would be worse than never opening it.
  const modePinned = React.useRef(false);
  const openPinned = React.useRef(false);
  React.useEffect(() => {
    if (!activeEditorPath) return;
    if (!modePinned.current) setPreviewMode(defaultMode(activeEditorPath));
    // Auto-open only for files whose rendered form is genuinely different from
    // their source. A .ts file's "preview" would be the same text twice.
    if (!openPinned.current) setPreviewOpen(hasRenderedForm(activeEditorPath));
  }, [activeEditorPath]);

  const chooseMode = (m: PreviewMode) => { modePinned.current = true; setPreviewMode(m); };
  const togglePreview = () => { openPinned.current = true; setPreviewOpen((o) => !o); };

  const jumpToLine = React.useCallback((line: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter?.(line);
    ed.setPosition?.({ lineNumber: line, column: 1 });
    ed.focus?.();
  }, []);

  const runEditorAction = (id: string) => {
    const ed = editorRef.current;
    ed?.getAction?.(id)?.run?.();
    ed?.focus?.();
  };

  /**
   * Point the explorer at a folder from a breadcrumb: expand every ancestor
   * (not just the clicked one — an expanded folder whose parent is collapsed is
   * still invisible) and bring the tree to the front.
   */
  const expandFolderPath = (dir: string) => {
    const store = useStore.getState();
    const parts = dir.split('/').filter(Boolean);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    const next = new Set([...store.expandedFolders, ...ancestors]);
    store.setExpandedFolders([...next]);
    store.setActivePanel('files');
    store.setLeftHidden(false);
  };

  const saveTab = React.useCallback(async (path: string) => {
    const store = useStore.getState();
    const tab = store.editorTabs.find((t) => t.path === path);
    if (!tab || tab.content === null || !workspacePath) return;
    setSaving(path);
    try {
      await saveFileContent(workspacePath, path, tab.content);
      store.markTabSaved(path);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving((s) => (s === path ? null : s));
    }
  }, [workspacePath]);

  // Ctrl/Cmd+S saves the active tab.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (activeEditorPath) { e.preventDefault(); void saveTab(activeEditorPath); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeEditorPath, saveTab]);

  const onEditorChange = React.useCallback((v: string | undefined) => {
    if (!activeEditorPath || typeof v !== 'string') return;
    setTabDirtyContent(activeEditorPath, v);
    // Auto-save (debounced) when enabled.
    if (settings?.autoSave === 'true') {
      const timers = autoSaveTimers.current;
      if (timers[activeEditorPath]) clearTimeout(timers[activeEditorPath]);
      timers[activeEditorPath] = setTimeout(() => void saveTab(activeEditorPath), 1000);
    }
  }, [activeEditorPath, setTabDirtyContent, settings, saveTab]);

  // Lazily rehydrate content for any tab missing it (e.g. after a refresh where
  // we persisted only the open paths). Keeps tabs alive across reloads.
  React.useEffect(() => {
    if (!workspacePath) return;
    for (const t of editorTabs) {
      if (t.content === null) {
        fetchFileContent(workspacePath, t.path)
          .then((data) => updateTabContent(t.path, data.content))
          .catch(() => { /* file may have been deleted; leave empty */ });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTabs.map((t) => t.path).join('|'), workspacePath]);

  // Reset the status-bar editor info when no file is open.
  React.useEffect(() => {
    if (!activeEditorPath) setEditorStatus(null);
    return () => setEditorStatus(null);
  }, [activeEditorPath, setEditorStatus]);

  const handleMount = React.useCallback((editor: any) => {
    editorRef.current = editor;
    const lang = activeEditorPath ? getLanguage(activeEditorPath) : 'plaintext';
    const model = editor.getModel?.();
    const eol: 'LF' | 'CRLF' = model && model.getEOL?.() === '\r\n' ? 'CRLF' : 'LF';
    const indent = Number(settings?.tabSize ?? '2') || 2;
    const report = () => {
      const pos = editor.getPosition?.();
      setEditorStatus({ language: lang, line: pos?.lineNumber ?? 1, col: pos?.column ?? 1, eol, indent });
    };
    report();
    editor.onDidChangeCursorPosition?.(report);
  }, [activeEditorPath, setEditorStatus, settings]);

  if (editorTabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <FileCode size={36} className="text-text-dim mb-3 opacity-30" />
        <p className="text-sm text-text-dim">No file open</p>
        <p className="text-xs text-text-dim mt-1">Click a file in the explorer</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar — one tab per open file, horizontally scrollable. */}
      <div className="flex items-stretch border-b border-border shrink-0 bg-surface-1 overflow-x-auto">
        {editorTabs.map((t) => {
          const name = t.path.split('/').pop() ?? t.path;
          const active = t.path === activeEditorPath;
          return (
            <div
              key={t.path}
              onClick={() => setActiveEditorTab(t.path)}
              className={`group flex items-center gap-1.5 px-3 h-9 cursor-pointer text-xs whitespace-nowrap border-r border-border transition-colors ${
                active ? 'bg-surface-0 text-text' : 'bg-surface-1 text-text-dim hover:bg-surface-2'
              }`}
              title={t.path}
              {...bind(() => [
                { label: 'Close', onSelect: () => closeEditorTab(t.path) },
                { label: 'Close Others', onSelect: () => editorTabs.filter((o) => o.path !== t.path).forEach((o) => closeEditorTab(o.path)) },
                { label: 'Close All', onSelect: () => editorTabs.forEach((o) => closeEditorTab(o.path)), separatorAfter: true },
                { label: 'Copy Path', onSelect: () => navigator.clipboard?.writeText(`${workspacePath}/${t.path}`.replace(/\\/g, '/')) },
                { label: 'Copy Relative Path', onSelect: () => navigator.clipboard?.writeText(t.path) },
              ])}
            >
              <span className="shrink-0">{getFileIcon(name)}</span>
              <span className="truncate max-w-[160px]">{name}</span>
              {saving === t.path
                ? <span className="w-1.5 h-1.5 rounded-full bg-accent-bright animate-pulse shrink-0" title="Saving…" />
                : t.dirty
                ? <span className="w-1.5 h-1.5 rounded-full bg-text-muted shrink-0" title="Unsaved changes (Ctrl+S)" />
                : null}
              <button
                onClick={(e) => { e.stopPropagation(); closeEditorTab(t.path); }}
                className={`ml-0.5 hover:text-red-agent transition-opacity shrink-0 ${t.dirty ? '' : 'opacity-0 group-hover:opacity-100'}`}
                title="Close"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Breadcrumbs + editor actions. The path is the one thing a tab label
          can't show — "index.ts" is meaningless in a repo with nine of them —
          and each crumb is clickable so the tree can be pointed at the folder
          the file actually lives in. */}
      {activeEditorPath && (
        <div className="flex items-center gap-1 px-3 h-7 border-b border-border shrink-0 text-[11px] overflow-x-auto">
          <div className="flex items-center gap-0.5 min-w-0 flex-1">
            {activeEditorPath.split('/').map((seg, i, all) => {
              const isLast = i === all.length - 1;
              const upto = all.slice(0, i + 1).join('/');
              return (
                <React.Fragment key={upto}>
                  {i > 0 && <ChevronRight size={10} className="shrink-0 text-text-dim/50" />}
                  <button
                    onClick={() => { if (!isLast) expandFolderPath(upto); }}
                    className={`shrink-0 truncate px-0.5 rounded ${
                      isLast ? 'text-text-muted' : 'text-text-dim hover:text-text hover:bg-surface-3'
                    }`}
                    title={isLast ? activeEditorPath : `Reveal ${upto} in the explorer`}
                  >
                    {seg}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          <div className="flex items-center gap-0.5 shrink-0 pl-2">
            <button onClick={() => runEditorAction('actions.find')} title="Find (Ctrl+F)" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
              <Search size={12} />
            </button>
            <button onClick={() => runEditorAction('editor.action.formatDocument')} title="Format document (Shift+Alt+F)" className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors">
              <Wrench size={12} />
            </button>
            <button
              onClick={() => void saveTab(activeEditorPath)}
              disabled={!activeTab?.dirty}
              title="Save (Ctrl+S)"
              className="p-1 rounded text-text-dim hover:text-text hover:bg-surface-3 transition-colors disabled:opacity-30"
            >
              <Save size={12} />
            </button>
            <button
              onClick={togglePreview}
              title={previewOpen ? 'Hide the preview pane' : 'Show the preview pane'}
              className={`p-1 rounded transition-colors ${previewOpen ? 'text-accent-bright bg-surface-3' : 'text-text-dim hover:text-text hover:bg-surface-3'}`}
            >
              {previewOpen ? <PanelRightClose size={12} /> : <Columns2 size={12} />}
            </button>
          </div>
        </div>
      )}

      {/* Editor + preview. A single Monaco instance whose `path` follows the
          active tab — Monaco keeps a separate model (and undo/scroll/cursor
          view-state) per path, so switching tabs never loses state. */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
      <div className="flex-1 min-w-0 overflow-hidden">
        <Suspense fallback={
          <div className="flex items-center justify-center h-full text-text-dim text-sm">Loading editor…</div>
        }>
          {activeEditorPath && activeContent !== null ? (
            <MonacoEditor
              path={activeEditorPath}
              value={activeContent}
              language={getLanguage(activeEditorPath)}
              // Follow the app theme — a hardcoded dark editor looked broken
              // against the light UI.
              theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
              keepCurrentModel
              onMount={handleMount}
              onChange={onEditorChange}
              options={{
                readOnly: false,
                minimap: { enabled: false },
                fontSize: Number(settings?.editorFontSize ?? '13') || 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 12, bottom: 12 },
                renderLineHighlight: 'line',
                scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-dim text-sm">Loading {activeEditorPath?.split('/').pop()}…</div>
          )}
        </Suspense>
      </div>

      {previewOpen && activeEditorPath && (
        <ResizablePanel
          defaultWidth={420}
          minWidth={260}
          maxWidthPercent={60}
          storageKey="editor-preview-width"
          position="left"
          className="shrink-0 border-l border-border overflow-hidden flex flex-col"
        >
          <EditorPreview
            path={activeEditorPath}
            content={activeContent ?? ''}
            mode={previewMode}
            onModeChange={chooseMode}
            onJumpToLine={jumpToLine}
          />
        </ResizablePanel>
      )}
      </div>
    </div>
  );
}
