import { executeTool } from './index';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Context Gatherer WebSocket Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-ws-test-'));

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

  it('should send WebSocket events during gather_context execution', async () => {
    const events: Array<{ type: string; content: string }> = [];
    
    // Mock onEvent callback to capture WebSocket events
    const onEvent = (event: { type: string; content: string }) => {
      events.push(event);
    };

    // Execute the gather_context tool with onEvent callback
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Test task for WebSocket events',
        max_files: 10,
      },
      testDir,
      onEvent
    );

    // Verify that the tool executed successfully
    expect(result.result).toContain('Context Analysis');
    expect(result.result).toContain('Project Type:');
    expect(result.result).toContain('Relevant Files');

    // Verify that WebSocket events were sent
    expect(events.length).toBeGreaterThan(0);
    
    // Verify that all events have the correct type
    events.forEach(event => {
      expect(event.type).toBe('status');
      expect(typeof event.content).toBe('string');
      expect(event.content.length).toBeGreaterThan(0);
    });

    // Verify expected progress messages were sent
    const eventContents = events.map(e => e.content);
    
    expect(eventContents).toContain('Starting context analysis...');
    expect(eventContents).toContain('Discovering files in workspace...');
    expect(eventContents.some(msg => msg.includes('Found'))).toBe(true);
    expect(eventContents).toContain('Building dependency graph...');
    expect(eventContents.some(msg => msg.includes('Analyzed'))).toBe(true);
    expect(eventContents).toContain('Detecting project type...');
    expect(eventContents.some(msg => msg.includes('Detected project type'))).toBe(true);
    expect(eventContents).toContain('Finding entry points...');
    expect(eventContents.some(msg => msg.includes('Found'))).toBe(true);
    expect(eventContents).toContain('Ranking files by relevance...');
    expect(eventContents.some(msg => msg.includes('Ranked'))).toBe(true);
    expect(eventContents).toContain('Context gathering complete');
  });

  it('should work without onEvent callback', async () => {
    // Should not throw when no callback is provided
    const result = await executeTool(
      'gather_context',
      {
        task_description: 'Test task without callback',
        max_files: 10,
      },
      testDir
      // No onEvent callback
    );

    expect(result.result).toContain('Context Analysis');
  });

  it('should send cache message when using cached results', async () => {
    const events1: Array<{ type: string; content: string }> = [];
    const events2: Array<{ type: string; content: string }> = [];
    
    // First call - should perform full analysis
    await executeTool(
      'gather_context',
      {
        task_description: 'Same task for caching',
        max_files: 10,
      },
      testDir,
      (event) => events1.push(event)
    );

    // Second call - should use cache
    await executeTool(
      'gather_context',
      {
        task_description: 'Same task for caching',
        max_files: 10,
      },
      testDir,
      (event) => events2.push(event)
    );

    // First call should have many events
    expect(events1.length).toBeGreaterThan(5);
    
    // Second call should only have cache message
    expect(events2.length).toBe(1);
    expect(events2[0].type).toBe('status');
    expect(events2[0].content).toBe('Using cached context analysis...');
  });
});
