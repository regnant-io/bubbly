import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  categorizeFile,
  discoverFiles,
  detectProjectType,
  findEntryPoints,
  extractImports,
  buildDependencyGraph,
  extractKeywords,
  calculateRelevanceScore,
  rankFilesByRelevance,
  type FileInfo,
} from './contextGatherer';

describe('contextGatherer', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'context-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('categorizeFile', () => {
    it('should categorize source files correctly', () => {
      expect(categorizeFile('src/index.ts')).toBe('source');
      expect(categorizeFile('src/components/Button.tsx')).toBe('source');
      expect(categorizeFile('app.py')).toBe('source');
      expect(categorizeFile('main.rs')).toBe('source');
      expect(categorizeFile('server.js')).toBe('source');
    });

    it('should categorize config files correctly', () => {
      expect(categorizeFile('package.json')).toBe('config');
      expect(categorizeFile('tsconfig.json')).toBe('config');
      expect(categorizeFile('vite.config.ts')).toBe('config');
      expect(categorizeFile('.env')).toBe('config');
      expect(categorizeFile('docker-compose.yml')).toBe('config');
    });

    it('should categorize documentation files correctly', () => {
      expect(categorizeFile('README.md')).toBe('docs');
      expect(categorizeFile('docs/guide.md')).toBe('docs');
      expect(categorizeFile('CHANGELOG.md')).toBe('docs');
      expect(categorizeFile('notes.txt')).toBe('docs');
    });

    it('should categorize test files correctly', () => {
      expect(categorizeFile('src/utils.test.ts')).toBe('test');
      expect(categorizeFile('src/components/Button.spec.tsx')).toBe('test');
      expect(categorizeFile('__tests__/integration.js')).toBe('test');
      expect(categorizeFile('tests/unit/parser.py')).toBe('test');
      expect(categorizeFile('src/utils_test.go')).toBe('test');
    });

    it('should handle edge cases', () => {
      expect(categorizeFile('unknown.xyz')).toBe('source');
      expect(categorizeFile('file-without-extension')).toBe('source');
    });
  });

  describe('discoverFiles', () => {
    it('should discover all files in a directory', async () => {
      // Create test file structure
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'src', 'index.ts'), 'export {}');
      await fs.promises.writeFile(path.join(tempDir, 'package.json'), '{}');
      await fs.promises.writeFile(path.join(tempDir, 'README.md'), '# Test');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(3);
      expect(files.some(f => f.path === 'src/index.ts')).toBe(true);
      expect(files.some(f => f.path === 'package.json')).toBe(true);
      expect(files.some(f => f.path === 'README.md')).toBe(true);
    });

    it('should exclude node_modules by default', async () => {
      // Create test file structure with node_modules
      await fs.promises.mkdir(path.join(tempDir, 'node_modules', 'package'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'node_modules', 'package', 'index.js'), '');
      await fs.promises.writeFile(path.join(tempDir, 'index.ts'), 'export {}');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('index.ts');
    });

    it('should exclude .git directory by default', async () => {
      // Create test file structure with .git
      await fs.promises.mkdir(path.join(tempDir, '.git', 'objects'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, '.git', 'config'), '');
      await fs.promises.writeFile(path.join(tempDir, 'index.ts'), 'export {}');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('index.ts');
    });

    it('should exclude dist and build directories by default', async () => {
      // Create test file structure
      await fs.promises.mkdir(path.join(tempDir, 'dist'), { recursive: true });
      await fs.promises.mkdir(path.join(tempDir, 'build'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'dist', 'bundle.js'), '');
      await fs.promises.writeFile(path.join(tempDir, 'build', 'output.js'), '');
      await fs.promises.writeFile(path.join(tempDir, 'src.ts'), 'export {}');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('src.ts');
    });

    it('should respect custom exclude patterns', async () => {
      // Create test file structure
      await fs.promises.mkdir(path.join(tempDir, 'custom'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'custom', 'file.ts'), '');
      await fs.promises.writeFile(path.join(tempDir, 'index.ts'), 'export {}');

      const files = await discoverFiles(tempDir, ['custom']);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('index.ts');
    });

    it('should collect file metadata correctly', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.ts'), 'export const x = 1;');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('test.ts');
      expect(files[0].fullPath).toBe(path.join(tempDir, 'test.ts'));
      expect(files[0].size).toBeGreaterThan(0);
      expect(files[0].modifiedTime).toBeGreaterThan(0);
      expect(files[0].category).toBe('source');
      expect(files[0].extension).toBe('.ts');
    });

    it('should handle nested directory structures', async () => {
      // Create nested structure
      await fs.promises.mkdir(path.join(tempDir, 'src', 'components', 'ui'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'src', 'components', 'ui', 'Button.tsx'), '');
      await fs.promises.writeFile(path.join(tempDir, 'src', 'index.ts'), '');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(2);
      expect(files.some(f => f.path === 'src/components/ui/Button.tsx')).toBe(true);
      expect(files.some(f => f.path === 'src/index.ts')).toBe(true);
    });

    it('should categorize discovered files', async () => {
      // Create files of different categories
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.promises.mkdir(path.join(tempDir, 'tests'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'src', 'app.ts'), '');
      await fs.promises.writeFile(path.join(tempDir, 'package.json'), '{}');
      await fs.promises.writeFile(path.join(tempDir, 'README.md'), '');
      await fs.promises.writeFile(path.join(tempDir, 'tests', 'app.test.ts'), '');

      const files = await discoverFiles(tempDir);

      expect(files.length).toBe(4);
      expect(files.filter(f => f.category === 'source').length).toBe(1);
      expect(files.filter(f => f.category === 'config').length).toBe(1);
      expect(files.filter(f => f.category === 'docs').length).toBe(1);
      expect(files.filter(f => f.category === 'test').length).toBe(1);
    });
  });

  describe('detectProjectType', () => {
    function createFileInfo(path: string, extension: string): FileInfo {
      return {
        path,
        fullPath: `/fake/${path}`,
        size: 100,
        modifiedTime: Date.now(),
        category: 'source',
        extension,
      };
    }

    it('should detect React projects', () => {
      const files = [
        createFileInfo('package.json', '.json'),
        createFileInfo('src/App.tsx', '.tsx'),
      ];

      expect(detectProjectType(files)).toBe('react');
    });

    it('should detect Vue projects', () => {
      const files = [
        createFileInfo('package.json', '.json'),
        createFileInfo('src/App.vue', '.vue'),
      ];

      expect(detectProjectType(files)).toBe('vue');
    });

    it('should detect Svelte projects', () => {
      const files = [
        createFileInfo('package.json', '.json'),
        createFileInfo('src/App.svelte', '.svelte'),
      ];

      expect(detectProjectType(files)).toBe('svelte');
    });

    it('should detect Node.js projects', () => {
      const files = [
        createFileInfo('package.json', '.json'),
        createFileInfo('src/server.js', '.js'),
      ];

      expect(detectProjectType(files)).toBe('node');
    });

    it('should detect Python projects', () => {
      const files = [
        createFileInfo('pyproject.toml', '.toml'),
        createFileInfo('main.py', '.py'),
      ];

      expect(detectProjectType(files)).toBe('python');
    });

    it('should detect Rust projects', () => {
      const files = [
        createFileInfo('Cargo.toml', '.toml'),
        createFileInfo('src/main.rs', '.rs'),
      ];

      expect(detectProjectType(files)).toBe('rust');
    });

    it('should detect Go projects', () => {
      const files = [
        createFileInfo('go.mod', '.mod'),
        createFileInfo('main.go', '.go'),
      ];

      expect(detectProjectType(files)).toBe('go');
    });

    it('should detect Java projects', () => {
      const files = [
        createFileInfo('pom.xml', '.xml'),
        createFileInfo('src/Main.java', '.java'),
      ];

      expect(detectProjectType(files)).toBe('java');
    });

    it('should return unknown for unrecognized projects', () => {
      const files = [
        createFileInfo('random.txt', '.txt'),
      ];

      expect(detectProjectType(files)).toBe('unknown');
    });
  });

  describe('findEntryPoints', () => {
    function createFileInfo(path: string): FileInfo {
      return {
        path,
        fullPath: `/fake/${path}`,
        size: 100,
        modifiedTime: Date.now(),
        category: 'source',
        extension: '.ts',
      };
    }

    it('should find common entry points', () => {
      const files = [
        createFileInfo('src/index.ts'),
        createFileInfo('src/utils.ts'),
        createFileInfo('main.py'),
      ];

      const entryPoints = findEntryPoints(files);

      expect(entryPoints).toContain('src/index.ts');
      expect(entryPoints).toContain('main.py');
      expect(entryPoints).not.toContain('src/utils.ts');
    });

    it('should prefer root-level entry points', () => {
      const files = [
        createFileInfo('src/nested/index.ts'),
        createFileInfo('index.ts'),
      ];

      const entryPoints = findEntryPoints(files);

      expect(entryPoints[0]).toBe('index.ts');
      expect(entryPoints[1]).toBe('src/nested/index.ts');
    });

    it('should limit to 5 entry points', () => {
      const files = [
        createFileInfo('index.ts'),
        createFileInfo('main.ts'),
        createFileInfo('app.ts'),
        createFileInfo('index.js'),
        createFileInfo('main.js'),
        createFileInfo('app.js'),
        createFileInfo('main.py'),
      ];

      const entryPoints = findEntryPoints(files);

      expect(entryPoints.length).toBeLessThanOrEqual(5);
    });

    it('should handle empty file list', () => {
      const entryPoints = findEntryPoints([]);

      expect(entryPoints).toEqual([]);
    });

    it('should find various entry point patterns', () => {
      const files = [
        createFileInfo('index.tsx'),
        createFileInfo('main.jsx'),
        createFileInfo('app.py'),
        createFileInfo('main.rs'),
        createFileInfo('main.go'),
      ];

      const entryPoints = findEntryPoints(files);

      expect(entryPoints.length).toBeGreaterThan(0);
      expect(entryPoints).toContain('index.tsx');
      expect(entryPoints).toContain('main.jsx');
      expect(entryPoints).toContain('app.py');
    });
  });

  describe('extractImports', () => {
    it('should extract ES6 imports from JavaScript/TypeScript', async () => {
      const content = `
        import React from 'react';
        import { useState, useEffect } from 'react';
        import * as utils from './utils';
        import type { User } from './types';
        import './styles.css';
      `;
      
      const testFile = path.join(tempDir, 'test.ts');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.ts', testFile);
      
      expect(imports).toContain('react');
      expect(imports).toContain('./utils');
      expect(imports).toContain('./types');
      expect(imports).toContain('./styles.css');
    });

    it('should extract CommonJS require statements', async () => {
      const content = `
        const express = require('express');
        const utils = require('./utils');
        const { helper } = require('../helpers');
      `;
      
      const testFile = path.join(tempDir, 'test.js');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.js', testFile);
      
      expect(imports).toContain('express');
      expect(imports).toContain('./utils');
      expect(imports).toContain('../helpers');
    });

    it('should extract dynamic imports', async () => {
      const content = `
        const module = await import('./dynamic');
        import('./lazy').then(m => m.default());
      `;
      
      const testFile = path.join(tempDir, 'test.ts');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.ts', testFile);
      
      expect(imports).toContain('./dynamic');
      expect(imports).toContain('./lazy');
    });

    it('should extract Python imports', async () => {
      const content = `
        import os
        import sys
        from typing import List, Dict
        from .utils import helper
        from ..models import User
      `;
      
      const testFile = path.join(tempDir, 'test.py');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.py', testFile);
      
      expect(imports).toContain('os');
      expect(imports).toContain('sys');
      expect(imports).toContain('typing');
      expect(imports).toContain('.utils');
      expect(imports).toContain('..models');
    });

    it('should return empty array for unsupported file types', async () => {
      const content = '# This is a markdown file';
      
      const testFile = path.join(tempDir, 'test.md');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.md', testFile);
      
      expect(imports).toEqual([]);
    });

    it('should handle files with no imports', async () => {
      const content = 'const x = 1; console.log(x);';
      
      const testFile = path.join(tempDir, 'test.js');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.js', testFile);
      
      expect(imports).toEqual([]);
    });

    it('should handle mixed import styles', async () => {
      const content = `
        import React from 'react';
        const express = require('express');
        const lazy = await import('./lazy');
      `;
      
      const testFile = path.join(tempDir, 'test.ts');
      await fs.promises.writeFile(testFile, content);
      
      const imports = await extractImports('test.ts', testFile);
      
      expect(imports).toContain('react');
      expect(imports).toContain('express');
      expect(imports).toContain('./lazy');
    });
  });

  describe('buildDependencyGraph', () => {
    it('should build a dependency graph for simple project', async () => {
      // Create test files
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'index.ts'),
        `import { helper } from './utils';\nimport { User } from './types';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'utils.ts'),
        `import { User } from './types';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'types.ts'),
        `export interface User { name: string; }`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      expect(graph.has('src/index.ts')).toBe(true);
      expect(graph.has('src/utils.ts')).toBe(true);
      expect(graph.has('src/types.ts')).toBe(true);
      
      const indexDeps = graph.get('src/index.ts') || [];
      expect(indexDeps).toContain('src/utils.ts');
      expect(indexDeps).toContain('src/types.ts');
      
      const utilsDeps = graph.get('src/utils.ts') || [];
      expect(utilsDeps).toContain('src/types.ts');
      
      const typesDeps = graph.get('src/types.ts') || [];
      expect(typesDeps).toEqual([]);
    });

    it('should skip external dependencies', async () => {
      await fs.promises.writeFile(
        path.join(tempDir, 'index.ts'),
        `import React from 'react';\nimport express from 'express';\nimport { helper } from './utils';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'utils.ts'),
        `export const helper = () => {};`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const indexDeps = graph.get('index.ts') || [];
      expect(indexDeps).not.toContain('react');
      expect(indexDeps).not.toContain('express');
      expect(indexDeps).toContain('utils.ts');
    });

    it('should resolve relative imports correctly', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'src', 'components'), { recursive: true });
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'components', 'Button.tsx'),
        `import { helper } from '../utils';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'utils.ts'),
        `export const helper = () => {};`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const buttonDeps = graph.get('src/components/Button.tsx') || [];
      expect(buttonDeps).toContain('src/utils.ts');
    });

    it('should handle index file imports', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'app.ts'),
        `import { helper } from './utils';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'utils', 'index.ts'),
        `export const helper = () => {};`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const appDeps = graph.get('src/app.ts') || [];
      expect(appDeps).toContain('src/utils/index.ts');
    });

    it('should handle imports with file extensions', async () => {
      await fs.promises.writeFile(
        path.join(tempDir, 'index.js'),
        `import { helper } from './utils.js';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'utils.js'),
        `export const helper = () => {};`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const indexDeps = graph.get('index.js') || [];
      expect(indexDeps).toContain('utils.js');
    });

    it('should only analyze source and test files', async () => {
      await fs.promises.writeFile(
        path.join(tempDir, 'index.ts'),
        `import config from './config.json';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'config.json'),
        `{}`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      expect(graph.has('index.ts')).toBe(true);
      expect(graph.has('config.json')).toBe(false);
    });

    it('should handle circular dependencies', async () => {
      await fs.promises.writeFile(
        path.join(tempDir, 'a.ts'),
        `import { b } from './b';`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'b.ts'),
        `import { a } from './a';`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const aDeps = graph.get('a.ts') || [];
      const bDeps = graph.get('b.ts') || [];
      
      expect(aDeps).toContain('b.ts');
      expect(bDeps).toContain('a.ts');
    });

    it('should handle empty project', async () => {
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      expect(graph.size).toBe(0);
    });

    it('should handle Python imports', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'main.py'),
        `from .utils import helper\nfrom .models import User`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'utils.py'),
        `def helper(): pass`
      );
      
      await fs.promises.writeFile(
        path.join(tempDir, 'src', 'models.py'),
        `class User: pass`
      );
      
      const files = await discoverFiles(tempDir);
      const graph = await buildDependencyGraph(files, tempDir);
      
      const mainDeps = graph.get('src/main.py') || [];
      expect(mainDeps).toContain('src/utils.py');
      expect(mainDeps).toContain('src/models.py');
    });
  });

  describe('extractKeywords', () => {
    it('should extract keywords from task description', () => {
      const keywords = extractKeywords('Implement user authentication with JWT tokens');
      
      expect(keywords).toContain('implement');
      expect(keywords).toContain('user');
      expect(keywords).toContain('authentication');
      expect(keywords).toContain('jwt');
      expect(keywords).toContain('tokens');
    });

    it('should filter out stop words', () => {
      const keywords = extractKeywords('The user can login with their password');
      
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('can');
      expect(keywords).not.toContain('with');
      expect(keywords).not.toContain('their');
      expect(keywords).toContain('user');
      expect(keywords).toContain('login');
      expect(keywords).toContain('password');
    });

    it('should filter out short words', () => {
      const keywords = extractKeywords('Add a new UI to the app');
      
      expect(keywords).not.toContain('a');
      expect(keywords).not.toContain('to');
      expect(keywords).toContain('add');
      expect(keywords).toContain('new');
      expect(keywords).toContain('app');
    });

    it('should handle punctuation', () => {
      const keywords = extractKeywords('Fix bug: user can\'t login!');
      
      expect(keywords).toContain('fix');
      expect(keywords).toContain('bug');
      expect(keywords).toContain('user');
      expect(keywords).toContain('login');
    });

    it('should deduplicate keywords', () => {
      const keywords = extractKeywords('user user user authentication');
      
      expect(keywords.filter(k => k === 'user').length).toBe(1);
      expect(keywords).toContain('authentication');
    });

    it('should handle empty string', () => {
      const keywords = extractKeywords('');
      
      expect(keywords).toEqual([]);
    });
  });

  describe('calculateRelevanceScore', () => {
    function createFileInfo(path: string, size: number = 1000, modifiedTime: number = Date.now()): FileInfo {
      return {
        path,
        fullPath: `/fake/${path}`,
        size,
        modifiedTime,
        category: 'source',
        extension: '.ts',
      };
    }

    it('should score files with keyword matches higher', () => {
      const file = createFileInfo('src/auth/login.ts');
      const keywords = ['auth', 'login'];
      const graph = new Map<string, string[]>();
      
      const result = calculateRelevanceScore(file, keywords, graph, '/fake');
      
      expect(result.score).toBeGreaterThan(0);
      expect(result.reasons.some(r => r.includes('Keyword matches'))).toBe(true);
    });

    it('should give higher scores to source files than config files', () => {
      const sourceFile: FileInfo = {
        ...createFileInfo('src/app.ts'),
        category: 'source',
      };
      
      const configFile: FileInfo = {
        ...createFileInfo('config.json'),
        category: 'config',
      };
      
      const keywords: string[] = [];
      const graph = new Map<string, string[]>();
      
      const sourceScore = calculateRelevanceScore(sourceFile, keywords, graph, '/fake');
      const configScore = calculateRelevanceScore(configFile, keywords, graph, '/fake');
      
      expect(sourceScore.score).toBeGreaterThan(configScore.score);
    });

    it('should score recently modified files higher', () => {
      const recentFile = createFileInfo('src/new.ts', 1000, Date.now() - 1000); // 1 second ago
      const oldFile = createFileInfo('src/old.ts', 1000, Date.now() - 100000000); // Very old
      
      const keywords: string[] = [];
      const graph = new Map<string, string[]>();
      
      const recentScore = calculateRelevanceScore(recentFile, keywords, graph, '/fake');
      const oldScore = calculateRelevanceScore(oldFile, keywords, graph, '/fake');
      
      expect(recentScore.score).toBeGreaterThan(oldScore.score);
    });

    it('should penalize large files', () => {
      const smallFile = createFileInfo('src/small.ts', 5000); // 5KB
      const largeFile = createFileInfo('src/large.ts', 500000); // 500KB
      
      const keywords: string[] = [];
      const graph = new Map<string, string[]>();
      
      const smallScore = calculateRelevanceScore(smallFile, keywords, graph, '/fake');
      const largeScore = calculateRelevanceScore(largeFile, keywords, graph, '/fake');
      
      expect(smallScore.score).toBeGreaterThan(largeScore.score);
    });

    it('should score central files higher in dependency graph', () => {
      const centralFile = createFileInfo('src/utils.ts');
      const leafFile = createFileInfo('src/leaf.ts');
      
      // utils.ts is imported by many files
      const graph = new Map<string, string[]>([
        ['src/a.ts', ['src/utils.ts']],
        ['src/b.ts', ['src/utils.ts']],
        ['src/c.ts', ['src/utils.ts']],
        ['src/leaf.ts', []],
      ]);
      
      const keywords: string[] = [];
      
      const centralScore = calculateRelevanceScore(centralFile, keywords, graph, '/fake');
      const leafScore = calculateRelevanceScore(leafFile, keywords, graph, '/fake');
      
      expect(centralScore.score).toBeGreaterThan(leafScore.score);
    });

    it('should include reasons for the score', () => {
      const file = createFileInfo('src/auth.ts', 5000, Date.now() - 1000);
      const keywords = ['auth'];
      const graph = new Map<string, string[]>();
      
      const result = calculateRelevanceScore(file, keywords, graph, '/fake');
      
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.some(r => r.includes('source file'))).toBe(true);
    });

    it('should never return negative scores', () => {
      const file = createFileInfo('src/huge.ts', 10000000); // 10MB file
      const keywords: string[] = [];
      const graph = new Map<string, string[]>();
      
      const result = calculateRelevanceScore(file, keywords, graph, '/fake');
      
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('rankFilesByRelevance', () => {
    function createFileInfo(path: string, category: FileInfo['category'] = 'source'): FileInfo {
      return {
        path,
        fullPath: `/fake/${path}`,
        size: 1000,
        modifiedTime: Date.now(),
        category,
        extension: '.ts',
      };
    }

    it('should rank files by relevance score', () => {
      const files = [
        createFileInfo('src/auth/login.ts'),
        createFileInfo('src/utils/helper.ts'),
        createFileInfo('config.json', 'config'),
      ];
      
      const graph = new Map<string, string[]>();
      const ranked = rankFilesByRelevance(
        files,
        'implement login authentication',
        graph,
        '/fake',
        10
      );
      
      expect(ranked.length).toBe(3);
      expect(ranked[0].path).toBe('src/auth/login.ts'); // Should be first due to keyword matches
    });

    it('should limit results to maxFiles', () => {
      const files = Array.from({ length: 50 }, (_, i) => 
        createFileInfo(`src/file${i}.ts`)
      );
      
      const graph = new Map<string, string[]>();
      const ranked = rankFilesByRelevance(
        files,
        'test task',
        graph,
        '/fake',
        10
      );
      
      expect(ranked.length).toBe(10);
    });

    it('should include score and reasons for each file', () => {
      const files = [createFileInfo('src/app.ts')];
      const graph = new Map<string, string[]>();
      
      const ranked = rankFilesByRelevance(
        files,
        'app',
        graph,
        '/fake',
        10
      );
      
      expect(ranked[0].score).toBeGreaterThan(0);
      expect(ranked[0].reasons.length).toBeGreaterThan(0);
      expect(ranked[0].category).toBe('source');
    });

    it('should handle empty file list', () => {
      const ranked = rankFilesByRelevance(
        [],
        'test task',
        new Map(),
        '/fake',
        10
      );
      
      expect(ranked).toEqual([]);
    });

    it('should sort by score descending', () => {
      const files = [
        createFileInfo('src/utils.ts'),
        createFileInfo('src/auth.ts'),
        createFileInfo('config.json', 'config'),
      ];
      
      const graph = new Map<string, string[]>();
      const ranked = rankFilesByRelevance(
        files,
        'authentication',
        graph,
        '/fake',
        10
      );
      
      // Verify scores are in descending order
      for (let i = 0; i < ranked.length - 1; i++) {
        expect(ranked[i].score).toBeGreaterThanOrEqual(ranked[i + 1].score);
      }
    });

    it('should extract keywords from task description', () => {
      const files = [
        createFileInfo('src/user/profile.ts'),
        createFileInfo('src/admin/dashboard.ts'),
      ];
      
      const graph = new Map<string, string[]>();
      const ranked = rankFilesByRelevance(
        files,
        'update user profile page',
        graph,
        '/fake',
        10
      );
      
      // user/profile.ts should rank higher due to keyword matches
      expect(ranked[0].path).toBe('src/user/profile.ts');
    });
  });

});
