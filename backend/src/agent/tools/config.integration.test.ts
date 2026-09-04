import { TOOL_DEFINITIONS, executeTool, checkRequiresApproval } from './index';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Configuration Tools Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-config-integration-'));
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it('should have read_config and write_config in TOOL_DEFINITIONS', () => {
    const toolNames = TOOL_DEFINITIONS.map(t => t.name);
    
    expect(toolNames).toContain('read_config');
    expect(toolNames).toContain('write_config');
  });

  it('should have proper schema for read_config', () => {
    const readConfigTool = TOOL_DEFINITIONS.find(t => t.name === 'read_config');
    
    expect(readConfigTool).toBeDefined();
    expect(readConfigTool?.description).toContain('configuration file');
    expect(readConfigTool?.inputSchema.properties).toHaveProperty('path');
    expect(readConfigTool?.inputSchema.required).toContain('path');
  });

  it('should have proper schema for write_config', () => {
    const writeConfigTool = TOOL_DEFINITIONS.find(t => t.name === 'write_config');
    
    expect(writeConfigTool).toBeDefined();
    expect(writeConfigTool?.description).toContain('configuration');
    expect(writeConfigTool?.inputSchema.properties).toHaveProperty('path');
    expect(writeConfigTool?.inputSchema.properties).toHaveProperty('data');
    expect(writeConfigTool?.inputSchema.properties).toHaveProperty('sort_keys');
    expect(writeConfigTool?.inputSchema.required).toContain('path');
    expect(writeConfigTool?.inputSchema.required).toContain('data');
  });

  it('should perform round-trip: write config, read config, verify data', async () => {
    const configPath = 'app-config.json';
    const originalData = {
      app: {
        name: 'TestApp',
        version: '1.0.0',
        features: ['auth', 'api', 'ui'],
      },
      database: {
        host: 'localhost',
        port: 5432,
      },
    };

    // Write config
    const writeResult = await executeTool(
      'write_config',
      { path: configPath, data: originalData },
      testDir
    );

    expect(writeResult.result).toContain('Configuration written');
    expect(writeResult.diff).toBeDefined();

    // Read config back
    const readResult = await executeTool(
      'read_config',
      { path: configPath },
      testDir
    );

    expect(readResult.result).toContain('Configuration read successfully');
    
    // Parse the result to verify data integrity
    const resultMatch = readResult.result.match(/Configuration read successfully from .*?:\n([\s\S]+)/);
    expect(resultMatch).toBeTruthy();
    
    if (resultMatch) {
      const parsedData = JSON.parse(resultMatch[1]);
      expect(parsedData).toEqual(originalData);
    }
  });

  it('should handle YAML round-trip correctly', async () => {
    const configPath = 'config.yml';
    const data = { server: { port: 3000, host: '0.0.0.0' } };

    // Write YAML
    await executeTool('write_config', { path: configPath, data }, testDir);

    // Read YAML
    const readResult = await executeTool('read_config', { path: configPath }, testDir);

    expect(readResult.result).toContain('Configuration read successfully');
    expect(readResult.result).toContain('"server"');
    expect(readResult.result).toContain('"port": 3000');
  });

  it('should handle TOML round-trip correctly', async () => {
    const configPath = 'config.toml';
    const data = { title: 'Test Config', owner: { name: 'John' } };

    // Write TOML
    await executeTool('write_config', { path: configPath, data }, testDir);

    // Read TOML
    const readResult = await executeTool('read_config', { path: configPath }, testDir);

    expect(readResult.result).toContain('Configuration read successfully');
    expect(readResult.result).toContain('"title": "Test Config"');
  });

  it('should respect sort_keys option', async () => {
    const configPath = 'sorted-config.json';
    const data = { zebra: 1, apple: 2, middle: 3, banana: 4 };

    // Write with sort_keys enabled
    await executeTool(
      'write_config',
      { path: configPath, data, sort_keys: true },
      testDir
    );

    // Read the file directly to check key order
    const content = await fs.promises.readFile(
      path.join(testDir, configPath),
      'utf-8'
    );

    const lines = content.split('\n');
    const keyLines = lines.filter(line => line.includes(':'));
    
    // Extract keys in order
    const keys = keyLines.map(line => {
      const match = line.match(/"(\w+)":/);
      return match ? match[1] : null;
    }).filter(Boolean);

    expect(keys).toEqual(['apple', 'banana', 'middle', 'zebra']);
  });

  it('should integrate with approval system for write_config', () => {
    const approval = checkRequiresApproval(
      'write_config',
      { path: 'important.json', data: { critical: 'data' } },
      true, // requireApprovalForWrites
      false
    );

    expect(approval.required).toBe(true);
    expect(approval.reason).toContain('write config');
    expect(approval.preview).toContain('critical');
  });

  it('should not require approval for read_config even with strict settings', () => {
    const approval = checkRequiresApproval(
      'read_config',
      { path: 'config.json' },
      true, // requireApprovalForWrites
      true  // requireApprovalForShell
    );

    expect(approval.required).toBe(false);
  });
});
