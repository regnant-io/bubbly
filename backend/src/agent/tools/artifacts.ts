/**
 * Artifacts — documents the agent authors ON PURPOSE, kept out of the chat log.
 *
 * There is a category of output that is neither a message nor a project file: a
 * migration plan, an API summary, a generated landing page, a diagram, a report
 * on what a subsystem does. Written into the transcript it is a wall of text
 * that buries the conversation and can only be re-read by scrolling. Written
 * into the workspace it is a file the user did not ask for, sitting in their
 * repo, that git now wants to track.
 *
 * An artifact is the third option: a titled, versioned document with a stable
 * id, stored in the project's private data directory. The chat shows a card;
 * the panel shows the document. Updating it produces a new VERSION rather than
 * overwriting history, because the interesting question about an agent-authored
 * document is usually "what changed" — and because an agent that rewrites a
 * document badly should never be able to destroy the good version.
 *
 * Deliberately NOT a file-write shortcut: an artifact only becomes a file in
 * the workspace when the user says so, from the panel.
 */

import fs from 'fs';
import path from 'path';
import { getProjectDataPath } from '../projectData';
import { logger } from '../../utils/logger';

/** What an artifact is, which decides how the panel renders it. */
export type ArtifactKind = 'markdown' | 'html' | 'code' | 'svg' | 'mermaid' | 'json';

export const ARTIFACT_KINDS: ArtifactKind[] = ['markdown', 'html', 'code', 'svg', 'mermaid', 'json'];

export interface ArtifactVersion {
  version: number;
  content: string;
  createdAt: number;
  /** One line on what changed, written by the agent. */
  note?: string;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** For kind 'code': the language, so the viewer highlights it correctly. */
  language?: string;
  createdAt: number;
  updatedAt: number;
  versions: ArtifactVersion[];
}

/** An artifact without its history — what a list needs. */
export type ArtifactSummary = Omit<Artifact, 'versions'> & {
  version: number;
  bytes: number;
};

const MAX_CONTENT_BYTES = 512 * 1024;
/** Older versions past this are dropped; a document's history is useful, not infinite. */
const MAX_VERSIONS = 20;

function artifactsDir(workspacePath: string): string {
  return getProjectDataPath(workspacePath, 'artifacts');
}

function artifactPath(workspacePath: string, id: string): string {
  return path.join(artifactsDir(workspacePath), `${id}.json`);
}

/**
 * Ids come from the model, so they are normalised into something that can only
 * ever be a single filename — no traversal, no separators, no surprises.
 */
export function normalizeArtifactId(raw: string): string {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

function summarize(a: Artifact): ArtifactSummary {
  const latest = a.versions[a.versions.length - 1];
  const { versions, ...rest } = a;
  return { ...rest, version: latest?.version ?? 0, bytes: Buffer.byteLength(latest?.content ?? '', 'utf8') };
}

export function listArtifacts(workspacePath: string): ArtifactSummary[] {
  const dir = artifactsDir(workspacePath);
  if (!fs.existsSync(dir)) return [];
  const out: ArtifactSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const a = readArtifact(workspacePath, name.slice(0, -5));
    if (a) out.push(summarize(a));
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt);
}

export function readArtifact(workspacePath: string, id: string): Artifact | null {
  const file = artifactPath(workspacePath, normalizeArtifactId(id));
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Artifact;
    if (!parsed || !Array.isArray(parsed.versions)) return null;
    return parsed;
  } catch (err) {
    logger.warn('Could not read artifact', { id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function persist(workspacePath: string, a: Artifact): void {
  const dir = artifactsDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  const file = artifactPath(workspacePath, a.id);
  // Write-then-rename: a crash mid-write must not leave a half-written document
  // where a complete earlier one used to be.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  artifact?: Artifact;
  /** True when this call created the document rather than revising it. */
  created?: boolean;
}

/**
 * Create an artifact, or add a version to an existing one.
 *
 * `create` on an id that already exists is treated as an update rather than an
 * error: the model reliably re-issues create when it means "here is the new
 * version of that document", and failing the call would lose the content it
 * just generated.
 */
export function saveArtifact(
  workspacePath: string,
  input: { id: string; title?: string; kind?: ArtifactKind; language?: string; content: string; note?: string },
): SaveResult {
  const id = normalizeArtifactId(input.id);
  const content = String(input.content ?? '');
  if (!content.trim()) return { ok: false, error: 'An artifact needs content.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { ok: false, error: `Artifact content is too large (max ${Math.round(MAX_CONTENT_BYTES / 1024)}KB). Write it to a file in the workspace instead.` };
  }
  const kind = input.kind && ARTIFACT_KINDS.includes(input.kind) ? input.kind : 'markdown';
  const now = Date.now();

  const existing = readArtifact(workspacePath, id);
  if (existing) {
    const latest = existing.versions[existing.versions.length - 1];
    // An identical rewrite is not a version. Without this a model that re-emits
    // an unchanged document on every turn would bury the real revisions.
    if (latest && latest.content === content) {
      return { ok: true, artifact: existing, created: false };
    }
    const next: Artifact = {
      ...existing,
      title: input.title?.trim() || existing.title,
      kind: input.kind ? kind : existing.kind,
      language: input.language ?? existing.language,
      updatedAt: now,
      versions: [
        ...existing.versions,
        { version: (latest?.version ?? 0) + 1, content, createdAt: now, note: input.note?.trim() || undefined },
      ].slice(-MAX_VERSIONS),
    };
    persist(workspacePath, next);
    logger.info('Artifact updated', { id, version: next.versions[next.versions.length - 1].version });
    return { ok: true, artifact: next, created: false };
  }

  const created: Artifact = {
    id,
    title: input.title?.trim() || id,
    kind,
    language: input.language,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, content, createdAt: now, note: input.note?.trim() || undefined }],
  };
  persist(workspacePath, created);
  logger.info('Artifact created', { id, kind });
  return { ok: true, artifact: created, created: true };
}

export function deleteArtifact(workspacePath: string, id: string): { ok: boolean; error?: string } {
  const file = artifactPath(workspacePath, normalizeArtifactId(id));
  try {
    if (!fs.existsSync(file)) return { ok: false, error: `No artifact "${id}".` };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The content of a specific version, or the latest when none is named. */
export function artifactContent(a: Artifact, version?: number): string {
  if (version == null) return a.versions[a.versions.length - 1]?.content ?? '';
  return a.versions.find((v) => v.version === version)?.content ?? '';
}

/** The file extension an artifact should get when saved into the workspace. */
export function artifactExtension(a: Artifact): string {
  switch (a.kind) {
    case 'html': return '.html';
    case 'svg': return '.svg';
    case 'json': return '.json';
    case 'mermaid': return '.mmd';
    case 'markdown': return '.md';
    case 'code': return extensionForLanguage(a.language);
  }
}

function extensionForLanguage(language?: string): string {
  const map: Record<string, string> = {
    typescript: '.ts', tsx: '.tsx', javascript: '.js', jsx: '.jsx', python: '.py',
    go: '.go', rust: '.rs', java: '.java', csharp: '.cs', php: '.php', ruby: '.rb',
    sql: '.sql', bash: '.sh', shell: '.sh', yaml: '.yaml', toml: '.toml', css: '.css',
  };
  return map[String(language ?? '').toLowerCase()] ?? '.txt';
}
