import { detectInputPrompt } from './inputDetection';

describe('detectInputPrompt', () => {
  describe('confirmations', () => {
    const cases: Array<[string, string | undefined]> = [
      ['Overwrite existing file? (y/N) ', 'n'],
      ['Are you sure? [Y/n] ', 'y'],
      ['Do you want to continue? (yes/no) ', undefined],
      ['Ok to proceed? (y) ', undefined],
      ['? Proceed with installation? (Y/n) ', 'y'],
    ];
    it.each(cases)('detects "%s" as confirm', (text, def) => {
      const r = detectInputPrompt(text);
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('confirm');
      if (def) expect(r?.suggestedReply).toBe(def);
    });
  });

  describe('passwords', () => {
    const cases = [
      'Password: ',
      "[sudo] password for derrick: ",
      'Enter passphrase for key: ',
      'Enter your PIN: ',
    ];
    it.each(cases)('detects "%s" as password', (text) => {
      const r = detectInputPrompt(text);
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('password');
    });
  });

  describe('pause prompts', () => {
    const cases = [
      'Press any key to continue . . . ',
      'Press ENTER to continue',
      'Press Enter to proceed',
    ];
    it.each(cases)('detects "%s" as pause', (text) => {
      const r = detectInputPrompt(text);
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('pause');
      expect(r?.suggestedReply).toBe('\r');
    });
  });

  describe('selection menus', () => {
    it('detects inquirer arrow-key menu', () => {
      const out = 'Pick a framework: (Use arrow keys)\n❯ React\n  Vue\n  Svelte';
      const r = detectInputPrompt(out);
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('selection');
    });
  });

  describe('free-text questions', () => {
    it('detects npm init package name prompt', () => {
      const r = detectInputPrompt('package name: (my-app) ');
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('question');
      expect(r?.suggestedReply).toBe('my-app');
    });
    it('detects an inquirer leader question', () => {
      const r = detectInputPrompt('? What is your project named? ');
      expect(r?.waiting).toBe(true);
      expect(r?.kind).toBe('question');
    });
  });

  describe('non-prompts (no false positives)', () => {
    const cases = [
      '',
      'Building...\nCompiled successfully.\n',
      'Listening on http://localhost:3000\n',
      'info: installed 42 packages\n',
      'Note: run npm audit for details\n',
      // A question mark inside a completed log line (ends with newline → not waiting)
      'Did the build succeed? Yes, all good.\n',
      // bare URL on a waiting line
      'https://example.com/login?token=abc',
    ];
    it.each(cases)('does not flag %j', (text) => {
      const r = detectInputPrompt(text);
      expect(r).toBeNull();
    });
  });

  it('ignores ANSI color codes around prompts', () => {
    const r = detectInputPrompt('\x1b[1m\x1b[33mOverwrite? (y/N)\x1b[0m ');
    expect(r?.waiting).toBe(true);
    expect(r?.kind).toBe('confirm');
  });

  it('uses only the trailing output for long streams', () => {
    const noise = 'log line\n'.repeat(2000);
    const r = detectInputPrompt(noise + 'Password: ');
    expect(r?.kind).toBe('password');
  });
});
