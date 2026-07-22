import { backgroundProcesses } from './backgroundProcess';
import os from 'os';

describe('backgroundProcesses input handling', () => {
  afterEach(() => backgroundProcesses.killAll());

  it('sendInput fails cleanly for an unknown process', () => {
    const r = backgroundProcesses.sendInput('proc_nope', 'y');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No background process/);
  });

  it('detects a prompt and lets us answer it', async () => {
    // A tiny node program that asks a question and echoes the answer, then exits.
    const isWin = process.platform === 'win32';
    const script = "process.stdout.write('Continue? (y/N) '); process.stdin.once('data', d => { process.stdout.write('GOT:' + d.toString().trim()); process.exit(0); });";
    const cmd = isWin
      ? `node -e "${script.replace(/"/g, '\\"')}"`
      : `node -e '${script}'`;

    const started = backgroundProcesses.start(cmd, os.tmpdir());
    expect(started.error).toBeUndefined();
    const id = started.id;

    // Wait for the prompt to be detected. Node process startup + prompt
    // debounce can exceed a fixed sleep on slower machines, so poll.
    let out = backgroundProcesses.getOutput(id, { full: true });
    for (let i = 0; i < 40 && !out.awaitingInput; i++) {
      await new Promise((r) => setTimeout(r, 250));
      out = backgroundProcesses.getOutput(id, { full: true });
    }
    expect(out.awaitingInput?.kind).toBe('confirm');

    // Answer it.
    const sent = backgroundProcesses.sendInput(id, 'y');
    expect(sent.ok).toBe(true);

    for (let i = 0; i < 20 && !(out.output ?? '').includes('GOT:y'); i++) {
      await new Promise((r) => setTimeout(r, 250));
      out = backgroundProcesses.getOutput(id, { full: true });
    }
    expect(out.output).toContain('GOT:y');
  }, 15000);
});
