import { gatherContext } from './contextGatherer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Context Gatherer Progress Callbacks', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-progress-test-'));

    // Create some test files
    await fs.promises.writeFile(
      path.join(testDir, 'index.ts'),
      'import { helper } from "./helper";\nexport function main() { return helper(); }'
    );
    await fs.promises.writeFile(
      path.join(testDir, 'helper.ts'),
      'export function helper() { return "hello"; }'
    );
    await fs.promises.writeFile(
      path.join(testDir, 'package.json'),
      '{"name": "test", "version": "1.0.0"}'
    );
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it('should call progress callback during context gathering', async () => {
    const progressUpdates: string[] = [];
    
    await gatherContext(
      testDir,
      'Test task description',
      { maxFiles: 10 },
      (status) => {
        progressUpdates.push(status);
      }
    );

    // Verify that progress callbacks were called
    expect(progressUpdates.length).toBeGreaterThan(0);
    
    // Verify expected progress messages
    expect(progressUpdates).toContain('Starting context analysis...');
    expect(progressUpdates).toContain('Discovering files in workspace...');
    expect(progressUpdates.some(msg => msg.includes('Found'))).toBe(true);
    expect(progressUpdates).toContain('Building dependency graph...');
    expect(progressUpdates).toContain('Detecting project type...');
    expect(progressUpdates.some(msg => msg.includes('Detected project type'))).toBe(true);
    expect(progressUpdates).toContain('Finding entry points...');
    expect(progressUpdates).toContain('Ranking files by relevance...');
    expect(progressUpdates).toContain('Context gathering complete');
  });

  it('should use cached results and report it', async () => {
    const progressUpdates1: string[] = [];
    const progressUpdates2: string[] = [];
    
    // First call - should perform full analysis
    await gatherContext(
      testDir,
      'Same task',
      { maxFiles: 10 },
      (status) => {
        progressUpdates1.push(status);
      }
    );

    // Second call - should use cache
    await gatherContext(
      testDir,
      'Same task',
      { maxFiles: 10 },
      (status) => {
        progressUpdates2.push(status);
      }
    );

    // First call should have many progress updates
    expect(progressUpdates1.length).toBeGreaterThan(5);
    
    // Second call should only have cache message
    expect(progressUpdates2).toEqual(['Using cached context analysis...']);
  });

  it('should work without progress callback', async () => {
    // Should not throw when no callback is provided
    await expect(
      gatherContext(testDir, 'Test task', { maxFiles: 10 })
    ).resolves.toBeDefined();
  });
});
