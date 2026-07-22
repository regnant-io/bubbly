import { describe, it, expect } from '@jest/globals';
import path from 'path';
import {
  discoverFiles,
  detectProjectType,
  findEntryPoints,
  gatherContext,
} from './contextGatherer';

describe('contextGatherer integration tests', () => {
  // Use the actual bubbly backend directory for integration testing
  const workspacePath = path.resolve(__dirname, '../../..');

  it('should discover files in the bubbly backend', async () => {
    const files = await discoverFiles(workspacePath);

    // Should find files
    expect(files.length).toBeGreaterThan(0);

    // Should exclude node_modules
    expect(files.every(f => !f.path.includes('node_modules'))).toBe(true);

    // Should exclude dist
    expect(files.every(f => !f.path.includes('dist'))).toBe(true);

    // Should find package.json
    expect(files.some(f => f.path === 'package.json')).toBe(true);

    // Should categorize files correctly
    const categories = {
      source: files.filter(f => f.category === 'source').length,
      config: files.filter(f => f.category === 'config').length,
      docs: files.filter(f => f.category === 'docs').length,
      test: files.filter(f => f.category === 'test').length,
    };

    expect(categories.source).toBeGreaterThan(0);
    expect(categories.config).toBeGreaterThan(0);
    expect(categories.test).toBeGreaterThan(0);

    console.log('File discovery stats:', {
      total: files.length,
      categories,
    });
  }, 30000); // 30 second timeout for large directory scan

  it('should detect project type correctly', async () => {
    const files = await discoverFiles(workspacePath);
    const projectType = detectProjectType(files);

    // Bubbly backend is a Node.js project
    expect(projectType).toBe('node');
  }, 30000);

  it('should find entry points', async () => {
    const files = await discoverFiles(workspacePath);
    const entryPoints = findEntryPoints(files);

    // Should find at least one entry point
    expect(entryPoints.length).toBeGreaterThan(0);

    // Should find src/index.ts
    expect(entryPoints.some(ep => ep.includes('index.ts'))).toBe(true);

    console.log('Entry points found:', entryPoints);
  }, 30000);

  it('should handle file metadata correctly', async () => {
    const files = await discoverFiles(workspacePath);

    // Check that all files have required metadata
    for (const file of files.slice(0, 10)) {
      expect(file.path).toBeTruthy();
      expect(file.fullPath).toBeTruthy();
      expect(file.size).toBeGreaterThanOrEqual(0);
      expect(file.modifiedTime).toBeGreaterThan(0);
      expect(['source', 'config', 'docs', 'test']).toContain(file.category);
      // Extension can be empty for files without extensions (like .gitignore, Dockerfile)
      expect(typeof file.extension).toBe('string');
    }
  }, 30000);

  describe('gatherContext main function', () => {
    it('should gather complete context analysis', async () => {
      const taskDescription = 'Implement authentication with JWT tokens in the agent orchestrator';
      
      const analysis = await gatherContext(workspacePath, taskDescription);

      // Should return all required fields
      expect(analysis).toBeDefined();
      expect(analysis.relevantFiles).toBeDefined();
      expect(analysis.dependencyGraph).toBeDefined();
      expect(analysis.projectType).toBeDefined();
      expect(analysis.entryPoints).toBeDefined();

      // Should have relevant files
      expect(analysis.relevantFiles.length).toBeGreaterThan(0);
      expect(analysis.relevantFiles.length).toBeLessThanOrEqual(20); // Default maxFiles

      // Each relevant file should have required properties
      for (const file of analysis.relevantFiles) {
        expect(file.path).toBeTruthy();
        expect(typeof file.score).toBe('number');
        expect(file.score).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(file.reasons)).toBe(true);
        expect(['source', 'config', 'docs', 'test']).toContain(file.category);
      }

      // Should detect project type
      expect(analysis.projectType).toBe('node');

      // Should find entry points
      expect(analysis.entryPoints.length).toBeGreaterThan(0);

      // Should build dependency graph
      expect(analysis.dependencyGraph.size).toBeGreaterThan(0);

      console.log('Context analysis results:', {
        relevantFiles: analysis.relevantFiles.length,
        topFiles: analysis.relevantFiles.slice(0, 5).map(f => ({
          path: f.path,
          score: f.score,
          reasons: f.reasons,
        })),
        projectType: analysis.projectType,
        entryPoints: analysis.entryPoints,
        dependencyGraphSize: analysis.dependencyGraph.size,
      });
    }, 60000); // 60 second timeout for full analysis

    it('should rank files by relevance to task', async () => {
      const taskDescription = 'Fix bug in the orchestrator agent loop';
      
      const analysis = await gatherContext(workspacePath, taskDescription);

      // Should prioritize orchestrator-related files
      const topFiles = analysis.relevantFiles.slice(0, 5);
      const hasOrchestratorFile = topFiles.some(f => 
        f.path.includes('orchestrator') || f.path.includes('agent')
      );

      expect(hasOrchestratorFile).toBe(true);

      console.log('Top files for orchestrator task:', 
        topFiles.map(f => ({ path: f.path, score: f.score }))
      );
    }, 60000);

    it('should use caching for repeated queries', async () => {
      const taskDescription = 'Add logging to the session manager';
      
      // First call - should perform full analysis
      const startTime1 = Date.now();
      const analysis1 = await gatherContext(workspacePath, taskDescription);
      const duration1 = Date.now() - startTime1;

      // Second call - should use cache
      const startTime2 = Date.now();
      const analysis2 = await gatherContext(workspacePath, taskDescription);
      const duration2 = Date.now() - startTime2;

      // Cached call should be much faster
      expect(duration2).toBeLessThan(duration1);

      // Results should be identical
      expect(analysis2.relevantFiles.length).toBe(analysis1.relevantFiles.length);
      expect(analysis2.projectType).toBe(analysis1.projectType);
      expect(analysis2.entryPoints).toEqual(analysis1.entryPoints);

      console.log('Cache performance:', {
        firstCallMs: duration1,
        cachedCallMs: duration2,
        speedup: `${(duration1 / duration2).toFixed(1)}x faster`,
      });
    }, 60000);

    it('should respect custom configuration', async () => {
      const taskDescription = 'Update configuration files';
      
      const analysis = await gatherContext(workspacePath, taskDescription, {
        maxFiles: 5,
        excludePatterns: ['node_modules', '.git', 'dist', 'build', 'logs'],
      });

      // Should respect maxFiles limit
      expect(analysis.relevantFiles.length).toBeLessThanOrEqual(5);

      // Should not include files from logs directory
      const hasLogsFile = analysis.relevantFiles.some(f => f.path.includes('logs/'));
      expect(hasLogsFile).toBe(false);
    }, 60000);

    it('should include dependency graph information', async () => {
      const taskDescription = 'Refactor the model adapters';
      
      const analysis = await gatherContext(workspacePath, taskDescription);

      // Should have dependency information
      expect(analysis.dependencyGraph.size).toBeGreaterThan(0);

      // Check that some files have dependencies
      let filesWithDeps = 0;
      for (const [file, deps] of analysis.dependencyGraph) {
        if (deps.length > 0) {
          filesWithDeps++;
        }
      }

      expect(filesWithDeps).toBeGreaterThan(0);

      console.log('Dependency graph stats:', {
        totalFiles: analysis.dependencyGraph.size,
        filesWithDeps,
        avgDepsPerFile: (
          Array.from(analysis.dependencyGraph.values())
            .reduce((sum, deps) => sum + deps.length, 0) / analysis.dependencyGraph.size
        ).toFixed(2),
      });
    }, 60000);

    it('should handle different task descriptions', async () => {
      const tasks = [
        'Add tests for the file verifier',
        'Implement WebSocket reconnection logic',
        'Update database schema for threads',
      ];

      for (const task of tasks) {
        const analysis = await gatherContext(workspacePath, task);

        expect(analysis.relevantFiles.length).toBeGreaterThan(0);
        expect(analysis.projectType).toBe('node');

        console.log(`Task: "${task}"`, {
          topFile: analysis.relevantFiles[0]?.path,
          score: analysis.relevantFiles[0]?.score,
        });
      }
    }, 120000); // 2 minutes for multiple analyses
  });
});
