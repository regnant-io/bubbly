import React, { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { isDesktop } from '../../hooks/useDesktop';
import { HardDrive, Plus, Trash2, Check, AlertCircle, Folder } from '../Shared/icons';

interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt: string;
}

export function WorkspacePanel() {
  const { workspacePath, setWorkspacePath, settings } = useStore();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Load saved workspaces from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('bubbly-workspaces');
    if (stored) {
      try {
        setWorkspaces(JSON.parse(stored));
      } catch {
        setWorkspaces([]);
      }
    }
    // Ensure current workspace is in the list
    if (workspacePath) {
      setWorkspaces(prev => {
        if (prev.some(w => w.path === workspacePath)) return prev;
        const updated = [...prev, {
          path: workspacePath,
          name: workspacePath.split(/[/\\]/).filter(Boolean).pop() || workspacePath,
          addedAt: new Date().toISOString(),
        }];
        localStorage.setItem('bubbly-workspaces', JSON.stringify(updated));
        return updated;
      });
    }
  }, [workspacePath]);

  const handleAdd = async () => {
    const trimmed = newPath.trim();
    if (!trimmed) {
      setError('Please enter a workspace path');
      return;
    }

    // Check if already exists
    if (workspaces.some(w => w.path === trimmed)) {
      setError('This workspace is already added');
      return;
    }

    const entry: WorkspaceEntry = {
      path: trimmed,
      name: trimmed.split(/[/\\]/).filter(Boolean).pop() || trimmed,
      addedAt: new Date().toISOString(),
    };

    const updated = [...workspaces, entry];
    setWorkspaces(updated);
    localStorage.setItem('bubbly-workspaces', JSON.stringify(updated));
    setNewPath('');
    setShowAdd(false);
    setError(null);
  };

  const handleSelect = async (path: string) => {
    try {
      // Save to backend settings
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: path }),
      });

      if (!response.ok) throw new Error('Failed to save workspace');

      setWorkspacePath(path);
      // Ensure it is registered in the saved list too
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === path)) return prev;
        const updated = [
          ...prev,
          {
            path,
            name: path.split(/[/\\]/).filter(Boolean).pop() || path,
            addedAt: new Date().toISOString(),
          },
        ];
        localStorage.setItem('bubbly-workspaces', JSON.stringify(updated));
        return updated;
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set workspace');
    }
  };

  // Native OS folder picker (desktop shell only). Selecting a folder both adds
  // it to the list and activates it as the current workspace.
  const handleBrowse = async () => {
    if (!window.bubblyDesktop) return;
    try {
      const folder = await window.bubblyDesktop.pickFolder();
      if (folder) {
        setError(null);
        await handleSelect(folder);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open folder picker');
    }
  };

  const handleDelete = (path: string) => {
    const updated = workspaces.filter(w => w.path !== path);
    setWorkspaces(updated);
    localStorage.setItem('bubbly-workspaces', JSON.stringify(updated));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-accent-bright" />
          <span className="text-sm font-medium text-text">Workspaces</span>
        </div>
        <div className="flex items-center gap-2">
          {isDesktop() && (
            <button
              onClick={handleBrowse}
              className="btn-ghost flex items-center gap-1.5 text-xs"
              title="Open a folder using the native picker"
            >
              <Folder size={13} />
              Browse…
            </button>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="btn-ghost flex items-center gap-1.5 text-xs"
            title="Add workspace"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </div>

      {/* Content - centered */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg mx-auto space-y-4">
          {/* Current workspace indicator */}
          {workspacePath && (
            <div className="p-3 rounded-lg bg-accent/10 border border-accent/30">
              <p className="text-xs text-text-dim mb-1">Active Workspace</p>
              <p className="text-sm font-mono text-accent-bright truncate">{workspacePath}</p>
            </div>
          )}

          {saved && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-agent/10 border border-green-agent/20">
              <Check size={14} className="text-green-agent" />
              <p className="text-sm text-green-agent">Workspace activated</p>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-agent/10 border border-red-agent/20">
              <AlertCircle size={14} className="text-red-agent" />
              <p className="text-sm text-red-agent">{error}</p>
            </div>
          )}

          {/* Add workspace form */}
          {showAdd && (
            <div className="p-4 rounded-xl border border-border bg-surface-2 space-y-3">
              <label className="block text-sm font-medium text-text">Add Workspace</label>
              <input
                type="text"
                value={newPath}
                onChange={e => { setNewPath(e.target.value); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="/path/to/your/project"
                className="input font-mono text-xs"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={handleAdd} className="btn-primary text-xs px-3 py-1.5">
                  Add Workspace
                </button>
                <button onClick={() => { setShowAdd(false); setError(null); }} className="btn-ghost text-xs px-3 py-1.5">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Workspace list */}
          {workspaces.length === 0 && !showAdd ? (
            <div className="text-center py-12 text-text-dim">
              <HardDrive size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm mb-2">No workspaces configured</p>
              <p className="text-xs">Click "Add" to add your first project workspace</p>
            </div>
          ) : (
            <div className="space-y-2">
              {workspaces.map(ws => (
                <div
                  key={ws.path}
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                    ws.path === workspacePath
                      ? 'border-accent/50 bg-accent/5'
                      : 'border-border hover:border-border-bright hover:bg-surface-2'
                  }`}
                  onClick={() => handleSelect(ws.path)}
                >
                  <Folder size={16} className={ws.path === workspacePath ? 'text-accent-bright' : 'text-text-dim'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text truncate">{ws.name}</p>
                    <p className="text-xs text-text-dim font-mono truncate">{ws.path}</p>
                  </div>
                  {ws.path === workspacePath && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-accent-bright">Active</span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(ws.path); }}
                    className="p-1.5 rounded hover:bg-red-agent/20 text-text-dim hover:text-red-agent transition-colors"
                    title="Remove workspace"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
