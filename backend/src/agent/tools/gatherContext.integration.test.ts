import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeTool } from './index';

describe('gather_context Tool Integration', () => {
  let testDir: string;
  let workspacePath: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-context-integration-'));
    workspacePath = testDir;

    // Create a simple project structure
    fs.mkdirSync(path.join(workspacePath, 'src'));
    fs.mkdirSync(path.join(workspacePath, 'tests'));
    
    // Create some source files
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'index.ts'),
      `import { helper } from './helper';\n\nexport function main() {\n  return helper();\n}`
    );
    
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'helper.ts'),
      `export function helper() {\n  return 'Hello, World!';\n}`
    );
    
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'auth.ts'),
      `export function authenticate(user: string, password: string) {\n  return true;\n}`
    );
    
    // Create a test file
    fs.writeFileSync(
      path.join(workspacePath, 'tests', 'helper.test.ts'),
      `import { helper } from '../src/helper';\n\ntest('helper works', () => {\n  expect(helper()).toBe('Hello, World!');\n});`
    );
    
    // Create a config file
    fs.writeFileSync(
      path.join(workspacePath, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
    );
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should gather context for a task', async () => {
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Add authentication to the helper function',
        max_files: 10,
      },
      workspacePath
    );

    expect(result.result).toContain('Context Analysis');
    expect(result.result).toContain('Project Type:');
    expect(result.result).toContain('Relevant Files');
    expect(result.result).toContain('node'); // Should detect as node project
  });

  it('should rank files by relevance', async () => {
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Fix authentication bug',
        max_files: 10,
      },
      workspacePath
    );

    // auth.ts should be highly ranked due to keyword match
    expect(result.result).toContain('auth.ts');
    
    // Should show relevance scores
    expect(result.result).toMatch(/score: \d+/);
  });

  it('should detect entry points', async () => {
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Refactor the main entry point',
        max_files: 10,
      },
      workspacePath
    );

    expect(result.result).toContain('Entry Points:');
    expect(result.result).toContain('src/index.ts');
  });

  it('should show dependency information', async () => {
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Update helper function',
        max_files: 10,
      },
      workspacePath
    );

    // Should show files and their categories
    expect(result.result).toContain('category: source');
    expect(result.result).toContain('category: test');
    expect(result.result).toContain('category: config');
  });

  it('should respect max_files limit', async () => {
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'General refactoring',
        max_files: 2,
      },
      workspacePath
    );

    // Count the number of files listed (each file has a numbered entry)
    const fileMatches = result.result.match(/^\d+\. \*\*/gm);
    expect(fileMatches).not.toBeNull();
    expect(fileMatches!.length).toBeLessThanOrEqual(2);
  });

  it('should handle empty workspace gracefully', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-empty-'));
    
    try {
      const result = await executeTool(
        'gather_context',
        {
          task_description: 'Test empty workspace',
          max_files: 10,
        },
        emptyDir
      );

      expect(result.result).toContain('Context Analysis');
      expect(result.result).toContain('Relevant Files (0)');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
