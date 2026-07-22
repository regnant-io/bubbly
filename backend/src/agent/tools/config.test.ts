import { executeTool, checkRequiresApproval } from './index';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Configuration File Tools', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-config-test-'));
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  describe('read_config', () => {
    it('should read and parse a JSON configuration file', async () => {
      const configPath = 'test-config.json';
      const configData = { name: 'test', version: '1.0.0', enabled: true };
      
      // Write test config file
      await fs.promises.writeFile(
        path.join(testDir, configPath),
        JSON.stringify(configData, null, 2)
      );

      const result = await executeTool('read_config', { path: configPath }, testDir);

      expect(result.result).toContain('Configuration read successfully');
      expect(result.result).toContain('"name": "test"');
      expect(result.result).toContain('"version": "1.0.0"');
    });

    it('should read and parse a YAML configuration file', async () => {
      const configPath = 'test-config.yaml';
      const yamlContent = `name: test\nversion: 1.0.0\nenabled: true\n`;
      
      await fs.promises.writeFile(path.join(testDir, configPath), yamlContent);

      const result = await executeTool('read_config', { path: configPath }, testDir);

      expect(result.result).toContain('Configuration read successfully');
      expect(result.result).toContain('"name": "test"');
    });

    it('should read and parse a TOML configuration file', async () => {
      const configPath = 'test-config.toml';
      const tomlContent = `name = "test"\nversion = "1.0.0"\nenabled = true\n`;
      
      await fs.promises.writeFile(path.join(testDir, configPath), tomlContent);

      const result = await executeTool('read_config', { path: configPath }, testDir);

      expect(result.result).toContain('Configuration read successfully');
      expect(result.result).toContain('"name": "test"');
    });

    it('should return error for unsupported file format', async () => {
      const result = await executeTool('read_config', { path: 'test.txt' }, testDir);

      expect(result.result).toContain('Error: Unsupported configuration file format');
    });

    it('should return error for invalid JSON', async () => {
      const configPath = 'invalid.json';
      await fs.promises.writeFile(
        path.join(testDir, configPath),
        '{ invalid json }'
      );

      const result = await executeTool('read_config', { path: configPath }, testDir);

      expect(result.result).toContain('Error reading config');
      expect(result.result).toContain('Parse error');
    });
  });

  describe('write_config', () => {
    it('should write a JSON configuration file', async () => {
      const configPath = 'output.json';
      const configData = { name: 'test', version: '2.0.0', features: ['a', 'b'] };

      const result = await executeTool(
        'write_config',
        { path: configPath, data: configData },
        testDir
      );

      expect(result.result).toContain('Configuration written to output.json');
      expect(result.result).toContain('format: json');
      expect(result.diff).toBeDefined();

      // Verify file was written correctly
      const content = await fs.promises.readFile(path.join(testDir, configPath), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(configData);
    });

    it('should write a YAML configuration file', async () => {
      const configPath = 'output.yaml';
      const configData = { name: 'test', version: '2.0.0' };

      const result = await executeTool(
        'write_config',
        { path: configPath, data: configData },
        testDir
      );

      expect(result.result).toContain('Configuration written to output.yaml');
      expect(result.result).toContain('format: yaml');

      // Verify file exists
      const exists = await fs.promises.access(path.join(testDir, configPath))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('should write a TOML configuration file', async () => {
      const configPath = 'output.toml';
      const configData = { name: 'test', version: '2.0.0' };

      const result = await executeTool(
        'write_config',
        { path: configPath, data: configData },
        testDir
      );

      expect(result.result).toContain('Configuration written to output.toml');
      expect(result.result).toContain('format: toml');
    });

    it('should sort keys when sort_keys is true', async () => {
      const configPath = 'sorted.json';
      const configData = { zebra: 1, apple: 2, banana: 3 };

      const result = await executeTool(
        'write_config',
        { path: configPath, data: configData, sort_keys: true },
        testDir
      );

      expect(result.result).toContain('sorted: true');

      // Verify keys are sorted
      const content = await fs.promises.readFile(path.join(testDir, configPath), 'utf-8');
      const lines = content.split('\n');
      const keyOrder = lines
        .filter(line => line.includes(':'))
        .map(line => line.trim().split(':')[0].replace(/"/g, ''));
      
      expect(keyOrder).toEqual(['apple', 'banana', 'zebra']);
    });

    it('should return error for unsupported file format', async () => {
      const result = await executeTool(
        'write_config',
        { path: 'test.txt', data: { test: 'data' } },
        testDir
      );

      expect(result.result).toContain('Error: Unsupported configuration file format');
    });
  });

  describe('checkRequiresApproval', () => {
    it('should require approval for write_config when requireApprovalForWrites is true', () => {
      const result = checkRequiresApproval(
        'write_config',
        { path: 'config.json', data: { test: 'value' } },
        true,
        false
      );

      expect(result.required).toBe(true);
      expect(result.reason).toContain('Agent wants to write config to: config.json');
      expect(result.preview).toBeDefined();
    });

    it('should not require approval for write_config when requireApprovalForWrites is false', () => {
      const result = checkRequiresApproval(
        'write_config',
        { path: 'config.json', data: { test: 'value' } },
        false,
        false
      );

      expect(result.required).toBe(false);
    });

    it('should auto-decline write_config with missing path', () => {
      const result = checkRequiresApproval(
        'write_config',
        { data: { test: 'value' } },
        false,
        false
      );

      expect(result.required).toBe(false);
      expect(result.autoDecline).toBe(true);
      expect(result.reason).toContain('Invalid write_config call: path parameter is undefined, null, or empty');
    });

    it('should not require approval for read_config', () => {
      const result = checkRequiresApproval(
        'read_config',
        { path: 'config.json' },
        true,
        true
      );

      expect(result.required).toBe(false);
    });
  });
});
