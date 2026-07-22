import { gatherContext } from './contextGatherer';
import { logger } from '../../utils/logger';
import fs from 'fs';
import path from 'path';

// Mock the logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock file system operations to prevent actual file I/O
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    default: {
      ...actualFs.default,
      promises: {
        readdir: jest.fn().mockResolvedValue([]),
        stat: jest.fn().mockResolvedValue({ size: 1000, mtimeMs: Date.now() }),
        readFile: jest.fn().mockResolvedValue(''),
      },
      readFileSync: jest.fn().mockReturnValue(''),
      existsSync: jest.fn().mockReturnValue(false),
    },
  };
});

describe('Context Gatherer Caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should cache analysis results and return cached data on second call', async () => {
    const workspacePath = '/test/workspace';
    const taskDescription = 'implement user authentication';
    
    // First call - should perform analysis
    const result1 = await gatherContext(workspacePath, taskDescription);
    
    expect(result1).toBeDefined();
    expect(result1.relevantFiles).toBeDefined();
    expect(result1.dependencyGraph).toBeDefined();
    expect(result1.projectType).toBeDefined();
    expect(result1.entryPoints).toBeDefined();
    
    // Verify that analysis was performed (not from cache)
    const firstCallLogs = (logger.info as jest.Mock).mock.calls;
    const hasCacheHit = firstCallLogs.some(call => 
      typeof call[0] === 'string' && call[0].includes('Cache hit')
    );
    expect(hasCacheHit).toBe(false);
    
    // Clear mocks to check second call
    jest.clearAllMocks();
    
    // Second call with same parameters - should use cache
    const result2 = await gatherContext(workspacePath, taskDescription);
    
    // Results should be the same
    expect(result2).toEqual(result1);
    
    // Logger should indicate cache hit
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Cache hit'),
      expect.any(Object)
    );
  });

  it('should not use cache for different task descriptions', async () => {
    const workspacePath = '/test/workspace';
    const taskDescription1 = 'implement user authentication';
    const taskDescription2 = 'add payment processing';
    
    // First call
    await gatherContext(workspacePath, taskDescription1);
    
    jest.clearAllMocks();
    
    // Second call with different task description
    await gatherContext(workspacePath, taskDescription2);
    
    // Should not use cache (no cache hit log)
    const logs = (logger.info as jest.Mock).mock.calls;
    const hasCacheHit = logs.some(call => 
      typeof call[0] === 'string' && call[0].includes('Cache hit')
    );
    expect(hasCacheHit).toBe(false);
  });

  it('should not use cache for different workspace paths', async () => {
    const workspacePath1 = '/test/workspace1';
    const workspacePath2 = '/test/workspace2';
    const taskDescription = 'implement user authentication';
    
    // First call
    await gatherContext(workspacePath1, taskDescription);
    
    jest.clearAllMocks();
    
    // Second call with different workspace
    await gatherContext(workspacePath2, taskDescription);
    
    // Should not use cache (no cache hit log)
    const logs = (logger.info as jest.Mock).mock.calls;
    const hasCacheHit = logs.some(call => 
      typeof call[0] === 'string' && call[0].includes('Cache hit')
    );
    expect(hasCacheHit).toBe(false);
  });

  it('should expire cache after configured time', async () => {
    const workspacePath = '/test/workspace';
    const taskDescription = 'implement user authentication';
    const cacheTimeMs = 100; // 100ms cache time
    
    // First call
    await gatherContext(workspacePath, taskDescription, { cacheTimeMs });
    
    // Wait for cache to expire
    await new Promise(resolve => setTimeout(resolve, 150));
    
    jest.clearAllMocks();
    
    // Second call after cache expiration
    await gatherContext(workspacePath, taskDescription, { cacheTimeMs });
    
    // Should not use cache (cache expired)
    const logs = (logger.info as jest.Mock).mock.calls;
    const hasCacheHit = logs.some(call => 
      typeof call[0] === 'string' && call[0].includes('Cache hit')
    );
    expect(hasCacheHit).toBe(false);
    
    // Logger should indicate cache miss due to expiration
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cache miss - entry expired'),
      expect.any(Object)
    );
  });

  it('should handle case-insensitive cache keys', async () => {
    const workspacePath1 = '/Test/Workspace';
    const workspacePath2 = '/test/workspace';
    const taskDescription1 = 'Implement User Authentication';
    const taskDescription2 = 'implement user authentication';
    
    // First call
    await gatherContext(workspacePath1, taskDescription1);
    
    jest.clearAllMocks();
    
    // Second call with different casing - should use cache
    await gatherContext(workspacePath2, taskDescription2);
    
    // Should use cached result (case-insensitive)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Cache hit'),
      expect.any(Object)
    );
  });

  it('should cleanup expired entries during cache operations', async () => {
    const workspacePath = '/test/workspace';
    const cacheTimeMs = 100; // 100ms cache time
    
    // Create multiple cache entries
    await gatherContext(workspacePath, 'task 1', { cacheTimeMs });
    await gatherContext(workspacePath, 'task 2', { cacheTimeMs });
    await gatherContext(workspacePath, 'task 3', { cacheTimeMs });
    
    // Wait for cache to expire
    await new Promise(resolve => setTimeout(resolve, 150));
    
    jest.clearAllMocks();
    
    // Trigger cleanup by making a new request
    await gatherContext(workspacePath, 'task 4', { cacheTimeMs });
    
    // Logger should indicate cleanup occurred
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cache cleanup complete'),
      expect.objectContaining({
        removedCount: expect.any(Number),
      })
    );
  });
});
