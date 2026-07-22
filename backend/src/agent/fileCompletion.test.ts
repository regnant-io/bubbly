import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })) },
}));

// Mock the model: return the remainder that completes the file.
jest.mock('../models/index', () => ({ callModel: jest.fn() }));

import { completeTruncatedFile } from './fileCompletion';
import { callModel } from '../models/index';

describe('completeTruncatedFile (self-healing)', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-heal-')); jest.clearAllMocks(); });
  afterEach(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('completes a file cut off mid-function in one pass', async () => {
    // A truncated TS file: unclosed function, dangling token, no newline.
    const truncated = 'export function add(a: number, b: number): number {\n  const result = a +';
    fs.writeFileSync(path.join(ws, 'm.ts'), truncated, 'utf8');

    (callModel as jest.Mock).mockResolvedValueOnce({
      textContent: '  const result = a + b;\n  return result;\n}\n',
      toolCalls: [], stopReason: 'end_turn',
    });

    const events: any[] = [];
    const res = await completeTruncatedFile({
      config: { provider: 'ollama', model: 'test', numCtx: 8192 } as any,
      workspacePath: ws,
      relPath: 'm.ts',
      onEvent: (e) => events.push(e),
    });

    expect(res.completed).toBe(true);
    const final = fs.readFileSync(path.join(ws, 'm.ts'), 'utf8');
    expect(final).toContain('return result;');
    // Balanced braces now.
    expect((final.match(/\{/g) || []).length).toBe((final.match(/\}/g) || []).length);
  });

  it('strips markdown fences the model may add', async () => {
    fs.writeFileSync(path.join(ws, 'm.ts'), 'function f() {\n  return (', 'utf8');
    (callModel as jest.Mock).mockResolvedValueOnce({
      textContent: '```ts\n  return (1 + 2);\n}\n```',
      toolCalls: [], stopReason: 'end_turn',
    });
    const res = await completeTruncatedFile({
      config: { provider: 'ollama', model: 'test' } as any,
      workspacePath: ws, relPath: 'm.ts', onEvent: () => {},
    });
    const final = fs.readFileSync(path.join(ws, 'm.ts'), 'utf8');
    expect(final).not.toContain('```');
    expect(res.completed).toBe(true);
  });

  it('returns completed=true immediately for an already-complete file', async () => {
    fs.writeFileSync(path.join(ws, 'ok.ts'), 'export const x = 1;\n', 'utf8');
    const res = await completeTruncatedFile({
      config: { provider: 'ollama', model: 'test' } as any,
      workspacePath: ws, relPath: 'ok.ts', onEvent: () => {},
    });
    expect(res.completed).toBe(true);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('stops gracefully if the model returns nothing', async () => {
    fs.writeFileSync(path.join(ws, 'm.ts'), 'function f() {\n  return (', 'utf8');
    (callModel as jest.Mock).mockResolvedValue({ textContent: '', toolCalls: [], stopReason: 'end_turn' });
    const res = await completeTruncatedFile({
      config: { provider: 'ollama', model: 'test' } as any,
      workspacePath: ws, relPath: 'm.ts', onEvent: () => {},
    });
    expect(res.completed).toBe(false);
  });
});
