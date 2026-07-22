import os from 'os';
import { terminalManager } from './terminalManager';

describe('terminal manager', () => {
  afterAll(() => {
    terminalManager.killAll();
  });

  it('creates a terminal session bound to the workspace', () => {
    const session = terminalManager.create({ workspacePath: os.tmpdir(), title: 'Test' });
    expect(session.id).toMatch(/^term_/);
    expect(session.alive).toBe(true);
    expect(terminalManager.get(session.id)).toBeDefined();
    terminalManager.kill(session.id);
    expect(terminalManager.get(session.id)).toBeUndefined();
  });

  it('streams output to subscribers and runs a command', (done) => {
    const session = terminalManager.create({ workspacePath: os.tmpdir(), title: 'Echo' });
    const marker = 'BUBBLY_TERM_TEST_OK';
    let buffer = '';

    const off = terminalManager.onOutput((id, chunk) => {
      if (id === session.id) {
        buffer += chunk;
        if (buffer.includes(marker)) {
          off();
          terminalManager.kill(session.id);
          done();
        }
      }
    });

    // Give the shell a moment to start, then echo a marker.
    setTimeout(() => {
      const cmd = process.platform === 'win32' ? `Write-Output "${marker}"` : `echo ${marker}`;
      terminalManager.runCommand(session.id, cmd);
    }, 800);
  }, 15000);

  it('lists active sessions', () => {
    const a = terminalManager.create({ workspacePath: os.tmpdir() });
    const list = terminalManager.list();
    expect(list.some((s) => s.id === a.id)).toBe(true);
    terminalManager.kill(a.id);
  });

  it('returns false when writing to a dead terminal', () => {
    const a = terminalManager.create({ workspacePath: os.tmpdir() });
    terminalManager.kill(a.id);
    expect(terminalManager.write(a.id, 'echo hi\n')).toBe(false);
  });
});
