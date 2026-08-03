/**
 * Artifacts: agent-authored documents with a version history.
 *
 * The contract that matters is that history is never lost. An agent revising a
 * document badly must not be able to destroy the good version, and a model that
 * re-emits an unchanged document on every turn must not be able to bury the
 * real revisions under identical ones.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  saveArtifact, readArtifact, listArtifacts, deleteArtifact,
  artifactContent, artifactExtension, normalizeArtifactId,
} from './artifacts';

jest.mock('../../db/index', () => ({ getSetting: () => 'false' }));

let ws: string;
let projectsRoot: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-artifacts-ws-'));
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-artifacts-root-'));
  process.env.BUBBLY_PROJECTS_ROOT = projectsRoot;
});

afterEach(() => {
  delete process.env.BUBBLY_PROJECTS_ROOT;
  for (const dir of [ws, projectsRoot]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('creating and revising', () => {
  it('creates a document at version 1', () => {
    const r = saveArtifact(ws, { id: 'migration-plan', title: 'Migration Plan', kind: 'markdown', content: '# Step one' });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.artifact!.versions).toHaveLength(1);
    expect(r.artifact!.versions[0].version).toBe(1);
  });

  it('keeps the old version when revised, rather than overwriting it', () => {
    saveArtifact(ws, { id: 'plan', title: 'Plan', content: 'first draft' });
    const r = saveArtifact(ws, { id: 'plan', content: 'second draft', note: 'reworked step 3' });
    expect(r.created).toBe(false);

    const a = readArtifact(ws, 'plan')!;
    expect(a.versions).toHaveLength(2);
    // The whole point: the earlier version is still readable.
    expect(artifactContent(a, 1)).toBe('first draft');
    expect(artifactContent(a, 2)).toBe('second draft');
    expect(artifactContent(a)).toBe('second draft');
    expect(a.versions[1].note).toBe('reworked step 3');
  });

  it('does not record a version for an identical rewrite', () => {
    saveArtifact(ws, { id: 'plan', title: 'Plan', content: 'same text' });
    saveArtifact(ws, { id: 'plan', content: 'same text' });
    saveArtifact(ws, { id: 'plan', content: 'same text' });
    // A model that re-emits an unchanged document every turn would otherwise
    // bury the real revisions under a pile of duplicates.
    expect(readArtifact(ws, 'plan')!.versions).toHaveLength(1);
  });

  it('carries the title and kind forward when a revision omits them', () => {
    saveArtifact(ws, { id: 'report', title: 'Audit Report', kind: 'html', content: '<p>v1</p>' });
    saveArtifact(ws, { id: 'report', content: '<p>v2</p>' });
    const a = readArtifact(ws, 'report')!;
    expect(a.title).toBe('Audit Report');
    expect(a.kind).toBe('html');
  });

  it('rejects empty content instead of storing a blank version', () => {
    const r = saveArtifact(ws, { id: 'x', content: '   ' });
    expect(r.ok).toBe(false);
    expect(readArtifact(ws, 'x')).toBeNull();
  });

  it('rejects content too large to belong in a document', () => {
    const r = saveArtifact(ws, { id: 'huge', content: 'x'.repeat(600 * 1024) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/i);
  });
});

describe('ids are filenames, so they are constrained like filenames', () => {
  it.each([
    ['../../etc/passwd', 'etc-passwd'],
    ['My Plan!', 'my-plan'],
    ['a/b/c', 'a-b-c'],
    ['', 'untitled'],
    ['...', 'untitled'],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeArtifactId(raw)).toBe(expected);
  });

  it('cannot write outside the artifacts directory', () => {
    saveArtifact(ws, { id: '../../escape', title: 'Nope', content: 'x' });
    // The traversal is flattened into a plain slug, so the file lands inside
    // the project's own artifacts dir and nowhere else.
    const all = listArtifacts(ws);
    expect(all).toHaveLength(1);
    expect(all[0].id).not.toContain('..');
    expect(all[0].id).not.toContain('/');
  });
});

describe('listing and deleting', () => {
  it('lists summaries newest-first without loading bodies', () => {
    saveArtifact(ws, { id: 'one', title: 'One', content: 'a' });
    saveArtifact(ws, { id: 'two', title: 'Two', content: 'bb' });
    const all = listArtifacts(ws);
    expect(all.map((a) => a.id).sort()).toEqual(['one', 'two']);
    const two = all.find((a) => a.id === 'two')!;
    expect(two.version).toBe(1);
    expect(two.bytes).toBe(2);
    expect((two as unknown as { versions?: unknown }).versions).toBeUndefined();
  });

  it('returns an empty list for a project that has none', () => {
    expect(listArtifacts(ws)).toEqual([]);
  });

  it('deletes, and says so when there is nothing to delete', () => {
    saveArtifact(ws, { id: 'gone', content: 'x' });
    expect(deleteArtifact(ws, 'gone').ok).toBe(true);
    expect(readArtifact(ws, 'gone')).toBeNull();
    expect(deleteArtifact(ws, 'gone').ok).toBe(false);
  });
});

describe('saving into the workspace', () => {
  it('picks an extension that matches what the document is', () => {
    const md = saveArtifact(ws, { id: 'a', kind: 'markdown', content: 'x' }).artifact!;
    const html = saveArtifact(ws, { id: 'b', kind: 'html', content: 'x' }).artifact!;
    const ts = saveArtifact(ws, { id: 'c', kind: 'code', language: 'typescript', content: 'x' }).artifact!;
    const unknown = saveArtifact(ws, { id: 'd', kind: 'code', language: 'brainfuck', content: 'x' }).artifact!;
    expect(artifactExtension(md)).toBe('.md');
    expect(artifactExtension(html)).toBe('.html');
    expect(artifactExtension(ts)).toBe('.ts');
    expect(artifactExtension(unknown)).toBe('.txt');
  });
});
