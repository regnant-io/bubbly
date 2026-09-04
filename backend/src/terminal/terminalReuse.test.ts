import { terminalManager } from './terminalManager';
import os from 'os';

describe('terminalManager reuse / idle', () => {
  afterEach(() => {
    terminalManager.killAll();
  });

  it('reuses an idle terminal for the same workspace instead of creating a new one', async () => {
    const ws = os.tmpdir();
    const a = terminalManager.acquireIdle({ workspacePath: ws });
    // A freshly-spawned terminal is intentionally NOT idle (still initializing).
    expect(terminalManager.isIdle(a.id)).toBe(false);
    // After the shell goes quiet it becomes reusable. Poll to avoid flakiness
    // from shell-init output timing in different environments.
    //
    // Poll for considerably longer than a shell "should" need.
    //
    // Idle means "quiet for long enough", and how long a shell takes to finish
    // printing its banner depends entirely on the machine: a PowerShell profile,
    // a slow disk, or simply eight other test workers spawning processes at the
    // same time. The old 5-second budget was enough on an idle machine and not
    // on a busy one, which is the definition of a flaky test — and the failure
    // it produced ("expected true, got false") said nothing about the cause.
    let idle = false;
    for (let i = 0; i < 100 && !idle; i++) {
      await new Promise((r) => setTimeout(r, 250));
      idle = terminalManager.isIdle(a.id);
    }
    expect(idle).toBe(true);
    const b = terminalManager.acquireIdle({ workspacePath: ws });
    expect(b.id).toBe(a.id);
  }, 40_000);

  it('does not reuse a terminal that is marked agent-busy', async () => {
    const ws = os.tmpdir();
    const a = terminalManager.acquireIdle({ workspacePath: ws });
    // Busy excludes reuse regardless of quiet time.
    terminalManager.setAgentBusy(a.id, true);
    expect(terminalManager.isIdle(a.id, 0)).toBe(false);
    const b = terminalManager.acquireIdle({ workspacePath: ws });
    expect(b.id).not.toBe(a.id);
  }, 10000);

  it('reports a dead/unknown terminal as not idle', () => {
    expect(terminalManager.isIdle('does-not-exist')).toBe(false);
  });
});
