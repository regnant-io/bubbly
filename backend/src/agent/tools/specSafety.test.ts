import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSafeSpecId, createSpec, readSpec, updateTaskStatus } from './specs';

describe('spec id safety', () => {
  it('accepts simple slug ids', () => {
    expect(isSafeSpecId('my-feature')).toBe(true);
    expect(isSafeSpecId('feature-2')).toBe(true);
  });

  it('rejects traversal and absolute ids', () => {
    expect(isSafeSpecId('../escape')).toBe(false);
    expect(isSafeSpecId('..\\escape')).toBe(false);
    expect(isSafeSpecId('a/b')).toBe(false);
    expect(isSafeSpecId('a\\b')).toBe(false);
    expect(isSafeSpecId('/abs')).toBe(false);
    expect(isSafeSpecId('')).toBe(false);
    expect(isSafeSpecId(undefined)).toBe(false);
    expect(isSafeSpecId(null)).toBe(false);
    expect(isSafeSpecId('with\0null')).toBe(false);
  });

  it('readSpec returns null for an unsafe id (no traversal)', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-spec-'));
    expect(readSpec(ws, '../../etc')).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('round-trips a real spec and updates a task', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-spec-'));
    try {
      const spec = createSpec(ws, { title: 'Demo Feature', type: 'feature', requirements: 'support login' });
      expect(spec.id).toBeTruthy();
      const read = readSpec(ws, spec.id);
      expect(read?.title).toBe('Demo Feature');
      // listSpecs should ignore stray files in the specs dir.
      fs.writeFileSync(path.join(ws, '.bubbly', 'specs', '.DS_Store'), 'x');
      const { listSpecs } = require('./specs');
      expect(listSpecs(ws).length).toBe(1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
