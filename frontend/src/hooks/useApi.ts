const BASE = '/api';

export async function fetchSettings() {
  const res = await fetch(`${BASE}/settings`);
  return res.json();
}

export async function saveSettings(settings: Record<string, string>) {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function fetchFileTree(workspace: string) {
  const res = await fetch(`${BASE}/files/tree?workspace=${encodeURIComponent(workspace)}`);
  return res.json();
}

export async function fetchFileList(workspace: string, path: string) {
  const res = await fetch(
    `${BASE}/files/list?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`
  );
  return res.json();
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

/** List one directory level (lazy tree). Returns sorted folders-first entries. */
export async function fetchDirectory(workspace: string, dirPath: string): Promise<{ entries: DirEntry[] }> {
  const res = await fetch(
    `${BASE}/files/list?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(dirPath || '.')}`
  );
  if (!res.ok) return { entries: [] };
  return res.json();
}

/** Fuzzy filename search for the title-bar search / command palette. */
export async function findFiles(workspace: string, q: string, limit = 20): Promise<string[]> {
  if (!q.trim()) return [];
  const res = await fetch(
    `${BASE}/files/find?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(q)}&limit=${limit}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}

export interface GitChangeStats {
  /** False when git isn't installed or the workspace isn't a repository. */
  available: boolean;
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
}

const NO_GIT: GitChangeStats = {
  available: false, branch: null, filesChanged: 0, insertions: 0, deletions: 0, untracked: 0,
};

/** Working-tree change totals for the composer's git pill. Never throws. */
export async function fetchGitStats(workspace: string): Promise<GitChangeStats> {
  try {
    const res = await fetch(`${BASE}/files/git-stats?workspace=${encodeURIComponent(workspace)}`);
    if (!res.ok) return NO_GIT;
    return { ...NO_GIT, ...(await res.json()) };
  } catch {
    return NO_GIT;
  }
}

export interface PromptCheckpoint {
  id: string;
  sessionId: string;
  prompt: string;
  createdAt: string;
  fileCount: number;
}

/** List per-prompt checkpoints for the "undo last N prompts" UI. */
export async function fetchPromptCheckpoints(workspace: string, sessionId?: string): Promise<PromptCheckpoint[]> {
  const qs = `workspace=${encodeURIComponent(workspace)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`;
  const res = await fetch(`${BASE}/files/checkpoints?${qs}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.checkpoints) ? data.checkpoints : [];
}

/** Revert the workspace to the state before a given prompt. */
export async function revertPromptCheckpoint(workspace: string, id: string): Promise<{ ok: boolean; restored?: number; removed?: number; error?: string }> {
  const res = await fetch(`${BASE}/files/checkpoints/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, id }),
  });
  return res.json();
}

export async function fetchFileContent(workspace: string, path: string) {
  const res = await fetch(
    `${BASE}/files/read?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`
  );
  return res.json();
}

/** Save an editor buffer back to disk. */
export async function saveFileContent(workspace: string, path: string, content: string) {
  const res = await fetch(`${BASE}/files/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, path, content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `Save failed (${res.status})`);
  }
  return res.json();
}

export async function fetchSessions() {
  const res = await fetch(`${BASE}/sessions`);
  return res.json();
}

export async function fetchAuditEvents(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/audit`);
  return res.json();
}

export interface UsageStats {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  heatmap: Array<{ date: string; count: number }>;
}

export async function fetchUsageStats(range?: '7d' | '30d'): Promise<UsageStats> {
  const qs = range ? `?range=${range}` : '';
  const res = await fetch(`${BASE}/sessions/stats${qs}`);
  if (!res.ok) throw new Error(`Failed to load usage stats: HTTP ${res.status}`);
  return res.json();
}

/** Detect + create (if missing) the workspace's browser-meta.json lock file. */
export interface RunService {
  name: string;
  cwd: string;
  install: string | null;
  start: string | null;
  port: number | null;
  url: string | null;
  kind: 'frontend' | 'backend';
}

export async function detectBrowserMeta(workspacePath: string): Promise<{ enabled: boolean; created?: boolean; previewUrl?: string | null; install?: string | null; start?: string | null; services?: RunService[]; running?: boolean; path?: string; error?: string }> {
  const res = await fetch(`${BASE}/files/browser-meta?workspacePath=${encodeURIComponent(workspacePath)}`);
  return res.json();
}

/** Persist the last-known preview URL into the workspace's browser-meta.json. */
export async function saveBrowserMetaPreviewUrl(workspacePath: string, previewUrl: string): Promise<void> {
  await fetch(`${BASE}/files/browser-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, previewUrl }),
  }).catch(() => { /* non-critical */ });
}

/** Start the project's dev server (browser-meta.json `start`). */
export async function startPreviewServer(workspacePath: string): Promise<{ ok: boolean; processId?: string; url?: string | null; reused?: boolean; command?: string; error?: string }> {
  const res = await fetch(`${BASE}/files/preview/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
  });
  return res.json();
}

/** Poll the running dev server's status + detected URL. */
export async function previewServerStatus(workspacePath: string): Promise<{ running: boolean; url: string | null; processId?: string; command?: string }> {
  const res = await fetch(`${BASE}/files/preview/status?workspacePath=${encodeURIComponent(workspacePath)}`);
  return res.json();
}

/** Stop the project's running dev server. */
export async function stopPreviewServer(workspacePath: string): Promise<{ ok: boolean; stopped?: boolean; error?: string }> {
  const res = await fetch(`${BASE}/files/preview/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
  });
  return res.json();
}

export interface BackgroundProcessInfo {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed' | string;
  exitCode: number | null;
  uptimeMs: number;
  awaitingInput: boolean;
  detectedUrl: string | null;
  startedAt: number;
}

/** List all background processes Bubbly is running (dev servers, watchers, builds). */
export async function listBackgroundProcesses(): Promise<{ processes: BackgroundProcessInfo[] }> {
  const res = await fetch(`${BASE}/files/background/list`);
  if (!res.ok) return { processes: [] };
  return res.json();
}

/** Fetch the captured output for one background process (for the live-log view). */
export async function getBackgroundOutput(id: string, lines?: number): Promise<{ ok: boolean; output: string; status?: string; exitCode?: number | null; error?: string }> {
  const qs = lines ? `&lines=${lines}` : '';
  const res = await fetch(`${BASE}/files/background/output?id=${encodeURIComponent(id)}${qs}`);
  if (!res.ok) return { ok: false, output: '', error: `HTTP ${res.status}` };
  return res.json();
}

/** Stop one background process from the UI. */
export async function stopBackgroundProcess(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/files/background/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return res.json();
}

export async function fetchOllamaModels(url?: string) {
  const qs = url ? `?url=${encodeURIComponent(url)}` : '';
  const res = await fetch(`${BASE}/settings/ollama/models${qs}`);
  return res.json();
}

export async function fetchOllamaStatus(url?: string) {
  const qs = url ? `?url=${encodeURIComponent(url)}` : '';
  const res = await fetch(`${BASE}/settings/ollama/status${qs}`);
  return res.json();
}

export async function fetchGeminiModels() {
  const res = await fetch(`${BASE}/settings/gemini/models`);
  return res.json();
}

/** Resolve whether a model supports image input (Ollama: via /api/show). */
export async function fetchModelVision(provider: string, model: string): Promise<boolean> {
  const res = await fetch(`${BASE}/settings/model/vision?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`);
  if (!res.ok) throw new Error(`vision probe failed: ${res.status}`);
  const data = await res.json();
  return !!data.supportsVision;
}

/** The context window a run would ACTUALLY use, resolved server-side. */
export interface ResolvedContext {
  ok: boolean;
  model?: string;
  /** Effective window in tokens. */
  numCtx?: number;
  source?: 'model-max' | 'configured' | 'default';
  /** The model's own maximum, when it could be probed. */
  modelMax?: number | null;
  /** Local memory ceiling in effect (null for cloud models — they're uncapped). */
  ceiling?: number | null;
  cloud?: boolean;
  auto?: boolean;
  /** The model could go bigger but the memory ceiling held it back. */
  cappedByCeiling?: boolean;
  error?: string;
}

/**
 * Resolve a model's effective context window against the CURRENT (possibly
 * unsaved) form values, so the settings page never displays a stale number.
 */
export async function fetchModelContext(params: {
  model: string;
  url?: string;
  numCtx?: string | number;
  ceiling?: string | number;
  auto?: boolean;
}): Promise<ResolvedContext> {
  const qs = new URLSearchParams({ model: params.model });
  if (params.url) qs.set('url', params.url);
  if (params.numCtx !== undefined) qs.set('numCtx', String(params.numCtx));
  if (params.ceiling !== undefined) qs.set('ceiling', String(params.ceiling));
  if (params.auto !== undefined) qs.set('auto', String(params.auto));
  const res = await fetch(`${BASE}/settings/model/context?${qs.toString()}`);
  if (!res.ok) throw new Error(`context probe failed: ${res.status}`);
  return res.json();
}

export async function fetchSpecs(workspace: string) {
  const res = await fetch(`${BASE}/files/specs?workspace=${encodeURIComponent(workspace)}`);
  return res.json();
}
