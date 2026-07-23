import React, { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { 
  MessageSquare, 
  ClipboardList, 
  Search, 
  Trash2, 
  RefreshCw,
  Clock,
  Zap,
  AlertCircle
} from '../Shared/icons';

interface ThreadMetadata {
  id: string;
  threadType: 'vibe_coding' | 'spec_session';
  specId?: string;
  firstMessage: string;
  messageCount: number;
  provider: 'claude' | 'ollama';
  model: string;
  status: 'active' | 'running' | 'idle' | 'done' | 'error';
  threadName?: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ThreadPanelProps {
  onThreadSelect: (threadId: string) => void;
}

export function ThreadPanel({ onThreadSelect }: ThreadPanelProps) {
  const { currentSessionId } = useStore();
  const { scrollRef } = useScrollRestoration('thread-list', true);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'vibe_coding' | 'spec_session'>('all');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const loadThreads = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true);
      setPage(0);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    
    try {
      const params = new URLSearchParams();
      if (filterType !== 'all') {
        params.append('threadType', filterType);
      }
      if (searchQuery.trim()) {
        params.append('search', searchQuery.trim());
      }
      const currentPage = reset ? 0 : page;
      params.append('limit', String(PAGE_SIZE));
      
      const response = await fetch(`/api/sessions/threads?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error(`Failed to load threads: ${response.statusText}`);
      }
      
      const data = await response.json();
      const newThreads = Array.isArray(data) ? data : [];
      
      if (reset) {
        setThreads(newThreads);
      } else {
        setThreads(prev => [...prev, ...newThreads]);
      }
      
      setHasMore(newThreads.length === PAGE_SIZE);
      if (!reset) setPage(currentPage + 1);
    } catch (err) {
      console.error('Failed to load threads:', err);
      setError(err instanceof Error ? err.message : 'Failed to load threads');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [searchQuery, filterType, page]);

  useEffect(() => {
    loadThreads(true);
  }, [searchQuery, filterType]);

  const handleDeleteAll = async () => {
    if (!confirm('Delete ALL threads? This cannot be undone.')) {
      return;
    }
    
    try {
      const response = await fetch('/api/sessions', { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete threads');
      setThreads([]);
      // The active thread is now gone — clear its transcript/plan/diffs so the
      // UI doesn't keep showing a conversation that no longer exists.
      const store = useStore.getState();
      store.resetThreadState();
      store.setCurrentSessionId(null);
    } catch (err) {
      console.error('Failed to delete threads:', err);
      alert(err instanceof Error ? err.message : 'Failed to delete threads');
    }
  };

  const handleDelete = async (threadId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    
    if (!confirm('Delete this thread? This cannot be undone.')) {
      return;
    }
    
    try {
      const response = await fetch(`/api/sessions/${threadId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to delete thread: ${response.statusText}`);
      }

      // If we just deleted the thread currently on screen, reset to a clean
      // slate — otherwise its messages/plan/diffs linger over a dead session.
      if (threadId === useStore.getState().currentSessionId) {
        const store = useStore.getState();
        store.resetThreadState();
        store.setCurrentSessionId(null);
      }
      // Reload threads after deletion
      loadThreads(true);
    } catch (err) {
      console.error('Failed to delete thread:', err);
      alert(err instanceof Error ? err.message : 'Failed to delete thread');
    }
  };

  const getThreadIcon = (type: string) => {
    switch (type) {
      case 'spec_session':
        return <ClipboardList size={14} className="text-accent-bright" />;
      case 'vibe_coding':
      default:
        return <MessageSquare size={14} className="text-blue-agent" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'text-blue-agent';
      case 'done':
        return 'text-green-agent';
      case 'error':
        return 'text-red-agent';
      case 'idle':
        return 'text-amber-agent';
      case 'active':
      default:
        return 'text-text-dim';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-accent-bright" />
            <span className="text-sm font-medium text-text">Thread History</span>
          </div>
          <div className="flex items-center gap-1">
            {threads.length > 0 && (
              <button
                onClick={handleDeleteAll}
                className="p-1 rounded hover:bg-red-agent/20 text-text-dim hover:text-red-agent transition-colors"
                title="Delete all threads"
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              onClick={() => loadThreads(true)}
              disabled={loading}
              className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text transition-colors disabled:opacity-50"
              title="Refresh threads"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-2.5 text-text-dim" />
          <input
            type="text"
            placeholder="Search threads..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-xs bg-surface-2 border border-border rounded-lg text-text placeholder-text-dim focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Filter dropdown */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as typeof filterType)}
          className="w-full px-3 py-2 text-xs bg-surface-2 border border-border rounded-lg text-text focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors"
        >
          <option value="all">All Threads</option>
          <option value="vibe_coding">Vibe Coding</option>
          <option value="spec_session">Spec Sessions</option>
        </select>
      </div>

      {/* Thread list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {error ? (
          <div className="text-center py-8 px-4">
            <AlertCircle size={24} className="mx-auto mb-2 text-red-agent opacity-50" />
            <p className="text-xs text-red-agent">{error}</p>
            <button
              onClick={() => loadThreads(true)}
              className="mt-3 px-3 py-1.5 text-xs bg-surface-3 hover:bg-surface-4 text-text rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : threads.length === 0 ? (
          <div className="text-center py-8 text-text-dim text-sm">
            {loading ? (
              <>
                <RefreshCw size={24} className="mx-auto mb-2 opacity-30 animate-spin" />
                Loading threads...
              </>
            ) : (
              <>
                <MessageSquare size={24} className="mx-auto mb-2 opacity-30" />
                {searchQuery || filterType !== 'all' 
                  ? 'No threads found' 
                  : 'No threads yet'}
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {threads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => onThreadSelect(thread.id)}
                className={`flex flex-col gap-2 px-4 py-3 cursor-pointer transition-colors ${
                  currentSessionId === thread.id ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-surface-3/50'
                }`}
              >
                {/* Thread header */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {getThreadIcon(thread.threadType)}
                    <span className="text-xs font-medium text-text truncate">
                      {thread.threadName || `${thread.threadType.charAt(0).toUpperCase() + thread.threadType.slice(1)} Thread`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-text-dim">
                      {formatDate(thread.updatedAt)}
                    </span>
                    <button
                      onClick={(e) => handleDelete(thread.id, e)}
                      className="p-1 rounded hover:bg-red-agent/20 text-text-dim hover:text-red-agent transition-colors"
                      title="Delete thread"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Thread preview */}
                <p className="text-xs text-text-dim line-clamp-2">
                  {thread.firstMessage || 'No messages yet'}
                </p>

                {/* Thread metadata */}
                <div className="flex items-center gap-3 text-xs text-text-dim">
                  <span className="flex items-center gap-1">
                    <MessageSquare size={10} />
                    {thread.messageCount}
                  </span>
                  <span className="flex items-center gap-1">
                    <Zap size={10} />
                    {thread.model}
                  </span>
                  <span className={`flex items-center gap-1 ${getStatusColor(thread.status)}`}>
                    {thread.status}
                  </span>
                </div>
              </div>
            ))}
            {/* Load more with spinner */}
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => loadThreads(false)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 px-4 py-2 text-xs text-text-dim hover:text-text bg-surface-2 hover:bg-surface-3 rounded-lg transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <>
                      <RefreshCw size={12} className="animate-spin" />
                      Loading...
                    </>
                  ) : (
                    'Load more'
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
