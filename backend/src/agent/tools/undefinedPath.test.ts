import { checkRequiresApproval } from './index';

describe('Undefined Path Validation', () => {
  describe('write_file', () => {
    it('should auto-decline when path is undefined', () => {
      const result = checkRequiresApproval(
        'write_file',
        { content: 'test content' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should auto-decline when path is null', () => {
      const result = checkRequiresApproval(
        'write_file',
        { path: null, content: 'test content' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should auto-decline when path is empty string', () => {
      const result = checkRequiresApproval(
        'write_file',
        { path: '', content: 'test content' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should auto-decline when path is whitespace only', () => {
      const result = checkRequiresApproval(
        'write_file',
        { path: '   ', content: 'test content' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should not auto-decline when path is valid and approval not required', () => {
      const result = checkRequiresApproval(
        'write_file',
        { path: 'valid/path.txt', content: 'test content' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBeUndefined();
    });

    it('should require approval when path is valid and approval is required', () => {
      const result = checkRequiresApproval(
        'write_file',
        { path: 'valid/path.txt', content: 'test content' },
        true,
        false
      );

      expect(result.required).toBe(true);
      expect(result.autoDecline).toBeUndefined();
      expect(result.reason).toContain('Agent wants to write to: valid/path.txt');
    });
  });

  describe('delete_file', () => {
    it('should auto-decline when path is undefined', () => {
      const result = checkRequiresApproval(
        'delete_file',
        {},
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should auto-decline when path is empty', () => {
      const result = checkRequiresApproval(
        'delete_file',
        { path: '' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
    });

    it('should require approval when path is valid', () => {
      const result = checkRequiresApproval(
        'delete_file',
        { path: 'file/to/delete.txt' },
        false,
        false
      );

      expect(result.required).toBe(true);
      expect(result.autoDecline).toBeUndefined();
      expect(result.reason).toContain('Agent wants to delete: file/to/delete.txt');
    });
  });

  describe('run_command', () => {
    it('should auto-decline when command is undefined', () => {
      const result = checkRequiresApproval(
        'run_command',
        {},
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('command parameter is undefined, null, or empty');
    });

    it('should auto-decline when command is empty', () => {
      const result = checkRequiresApproval(
        'run_command',
        { command: '' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
    });

    it('should not require approval when command is valid and approval not required', () => {
      const result = checkRequiresApproval(
        'run_command',
        { command: 'npm test' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBeUndefined();
    });

    it('should require approval when command is valid and approval is required', () => {
      const result = checkRequiresApproval(
        'run_command',
        { command: 'npm test' },
        false,
        true
      );

      expect(result.required).toBe(true);
      expect(result.autoDecline).toBeUndefined();
      expect(result.reason).toContain('Agent wants to run: npm test');
    });
  });

  describe('git_add_and_commit', () => {
    it('should auto-decline when message is undefined', () => {
      const result = checkRequiresApproval(
        'git_add_and_commit',
        { files: ['.'] },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('message parameter is undefined, null, or empty');
    });

    it('should auto-decline when message is empty', () => {
      const result = checkRequiresApproval(
        'git_add_and_commit',
        { files: ['.'], message: '' },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
    });

    it('should require approval when message is valid', () => {
      const result = checkRequiresApproval(
        'git_add_and_commit',
        { files: ['.'], message: 'feat: add new feature' },
        false,
        false
      );

      expect(result.required).toBe(true);
      expect(result.autoDecline).toBeUndefined();
      expect(result.reason).toContain('Agent wants to commit: "feat: add new feature"');
    });
  });

  describe('write_config', () => {
    it('should auto-decline when path is undefined', () => {
      const result = checkRequiresApproval(
        'write_config',
        { data: { test: 'value' } },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('path parameter is undefined, null, or empty');
    });

    it('should auto-decline when path is empty', () => {
      const result = checkRequiresApproval(
        'write_config',
        { path: '', data: { test: 'value' } },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
    });

    it('should not require approval when path is valid and approval not required', () => {
      const result = checkRequiresApproval(
        'write_config',
        { path: 'config.json', data: { test: 'value' } },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBeUndefined();
    });

    it('should require approval when path is valid and approval is required', () => {
      const result = checkRequiresApproval(
        'write_config',
        { path: 'config.json', data: { test: 'value' } },
        true,
        false
      );

      expect(result.required).toBe(true);
      expect(result.autoDecline).toBeUndefined();
      expect(result.reason).toContain('Agent wants to write config to: config.json');
    });
  });
});
