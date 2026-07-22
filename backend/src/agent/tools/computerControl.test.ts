import { validateComputerAction, READ_ONLY_ACTIONS } from './computerControl';
import { checkRequiresApproval } from './index';

describe('validateComputerAction', () => {
  it('accepts screenshot/screen_size with no params', () => {
    expect(validateComputerAction('screenshot', {}).ok).toBe(true);
    expect(validateComputerAction('screen_size', {}).ok).toBe(true);
  });

  it('rejects an unknown action', () => {
    const r = validateComputerAction('launch_missiles', {});
    expect(r.ok).toBe(false);
  });

  it('requires coordinates for move and drag', () => {
    expect(validateComputerAction('move', {}).ok).toBe(false);
    expect(validateComputerAction('move', { x: 10, y: 20 }).ok).toBe(true);
    expect(validateComputerAction('drag', { x: 1, y: 2 }).ok).toBe(false);
    expect(validateComputerAction('drag', { x: 1, y: 2, toX: 3, toY: 4 }).ok).toBe(true);
  });

  it('rejects negative or non-finite coordinates', () => {
    expect(validateComputerAction('move', { x: -1, y: 5 }).ok).toBe(false);
    expect(validateComputerAction('move', { x: NaN, y: 5 }).ok).toBe(false);
  });

  it('validates type text', () => {
    expect(validateComputerAction('type', {}).ok).toBe(false);
    expect(validateComputerAction('type', { text: '' }).ok).toBe(false);
    expect(validateComputerAction('type', { text: 'hello' }).ok).toBe(true);
    expect(validateComputerAction('type', { text: 'x'.repeat(5001) }).ok).toBe(false);
  });

  it('validates key combos', () => {
    expect(validateComputerAction('key', {}).ok).toBe(false);
    expect(validateComputerAction('key', { keys: 'enter' }).ok).toBe(true);
    expect(validateComputerAction('key', { keys: ['ctrl', 'c'] }).ok).toBe(true);
    expect(validateComputerAction('key', { keys: ['a', 'b', 'c', 'd', 'e', 'f'] }).ok).toBe(false);
  });

  it('clamps scroll amount and requires a number', () => {
    expect(validateComputerAction('scroll', {}).ok).toBe(false);
    const r = validateComputerAction('scroll', { amount: 99999 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.amount).toBe(5000);
  });
});

describe('computer_control approval gating', () => {
  it('does NOT require approval for read-only observation', () => {
    for (const action of READ_ONLY_ACTIONS) {
      const r = checkRequiresApproval('computer_control', { action }, false, false);
      expect(r.required).toBe(false);
    }
  });

  it('ALWAYS requires approval for acting, even when shell approval is off', () => {
    for (const action of ['click', 'type', 'key', 'move', 'drag', 'scroll']) {
      const r = checkRequiresApproval('computer_control', { action }, false, false);
      expect(r.required).toBe(true);
    }
  });
});
