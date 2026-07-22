import React, { Suspense } from 'react';
import { useStore } from '../../store';
import { fetchFileContent, saveFileContent } from '../../hooks/useApi';
import { X, FileCode } from '../Shared/icons';
import { getFileIcon } from './fileIcons';

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

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath) ?? null;
  const activeContent = activeTab ? (activeTab.content ?? openFileContent) : null;

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

      {/* Editor. A single Monaco instance whose `path` follows the active tab —
          Monaco keeps a separate model (and undo/scroll/cursor view-state) per
          path, so switching tabs never loses state. */}
      <div className="flex-1 overflow-hidden">
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
    </div>
  );
}
