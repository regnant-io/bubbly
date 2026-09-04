import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * Configuration for context gatherer
 */
export interface ContextGathererConfig {
  maxFiles: number; // default: 20
  cacheTimeMs: number; // default: 300000 (5 minutes)
  excludePatterns: string[]; // default: node_modules, .git, dist, build
}

/**
 * File information collected during discovery
 */
export interface FileInfo {
  path: string; // Relative path from workspace
  fullPath: string; // Absolute path
  size: number; // File size in bytes
  modifiedTime: number; // Last modified timestamp
  category: 'source' | 'config' | 'docs' | 'test';
  extension: string;
}

/**
 * File relevance with scoring
 */
export interface FileRelevance {
  path: string;
  score: number;
  reasons: string[]; // Why this file is relevant
  category: 'source' | 'config' | 'docs' | 'test';
}

/**
 * Complete context analysis result
 */
export interface ContextAnalysis {
  relevantFiles: FileRelevance[];
  dependencyGraph: Map<string, string[]>; // file -> dependencies
  projectType: string; // 'react', 'node', 'python', etc.
  entryPoints: string[]; // Main files (index.ts, main.py, etc.)
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ContextGathererConfig = {
  maxFiles: 20,
  cacheTimeMs: 300000, // 5 minutes
  excludePatterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    'out',
    'target',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv',
    '.DS_Store',
    'Thumbs.db',
  ],
};

/**
 * File extension to category mapping
 */
const EXTENSION_CATEGORIES: Record<string, 'source' | 'config' | 'docs' | 'test'> = {
  // Source files
  '.ts': 'source',
  '.tsx': 'source',
  '.js': 'source',
  '.jsx': 'source',
  '.py': 'source',
  '.rs': 'source',
  '.go': 'source',
  '.java': 'source',
  '.cpp': 'source',
  '.c': 'source',
  '.h': 'source',
  '.hpp': 'source',
  '.cs': 'source',
  '.rb': 'source',
  '.php': 'source',
  '.swift': 'source',
  '.kt': 'source',
  '.scala': 'source',
  '.vue': 'source',
  '.svelte': 'source',
  
  // Config files
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.conf': 'config',
  '.config': 'config',
  '.env': 'config',
  '.properties': 'config',
  
  // Documentation
  '.md': 'docs',
  '.mdx': 'docs',
  '.txt': 'docs',
  '.rst': 'docs',
  '.adoc': 'docs',
  
  // Test files (will be overridden by filename patterns)
  '.test.ts': 'test',
  '.test.tsx': 'test',
  '.test.js': 'test',
  '.test.jsx': 'test',
  '.spec.ts': 'test',
  '.spec.tsx': 'test',
  '.spec.js': 'test',
  '.spec.jsx': 'test',
};

/**
 * Categorize a file based on its path and extension
 */
export function categorizeFile(filePath: string): 'source' | 'config' | 'docs' | 'test' {
  const fileName = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  
  // Check for test files by filename pattern
  if (
    fileName.includes('.test.') ||
    fileName.includes('.spec.') ||
    fileName.includes('_test.') ||
    fileName.includes('_spec.') ||
    normalizedPath.includes('__tests__') ||
    normalizedPath.includes('/tests/') ||
    normalizedPath.includes('/test/') ||
    normalizedPath.startsWith('tests/') ||
    normalizedPath.startsWith('test/')
  ) {
    return 'test';
  }
  
  // Check for config files by name
  const configFileNames = [
    'package.json',
    'tsconfig.json',
    'jest.config.js',
    'vite.config.ts',
    'webpack.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'babel.config.js',
    '.eslintrc',
    '.prettierrc',
    'pyproject.toml',
    'setup.py',
    'cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'dockerfile',
    'docker-compose.yml',
    '.gitignore',
    '.dockerignore',
    '.env',
  ];
  
  if (configFileNames.some(name => fileName === name || fileName.startsWith(name))) {
    return 'config';
  }
  
  // Check for documentation by path
  if (
    normalizedPath.includes('/docs/') ||
    fileName === 'readme.md' ||
    fileName === 'changelog.md' ||
    fileName === 'contributing.md'
  ) {
    return 'docs';
  }
  
  // Use extension mapping
  return EXTENSION_CATEGORIES[ext] || 'source';
}

/**
 * Check if a path should be excluded based on patterns
 */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  for (const pattern of excludePatterns) {
    if (normalizedPath.includes(pattern)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Recursively discover files in a directory
 */
export async function discoverFiles(
  workspacePath: string,
  excludePatterns?: string[]
): Promise<FileInfo[]> {
  const patterns = excludePatterns || DEFAULT_CONFIG.excludePatterns;
  const files: FileInfo[] = [];
  
  logger.info('Starting file discovery', { workspacePath, excludePatterns: patterns });
  
  async function scanDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(workspacePath, fullPath);
        
        // Skip excluded paths
        if (shouldExclude(relativePath, patterns)) {
          continue;
        }
        
        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await scanDirectory(fullPath);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.promises.stat(fullPath);
            const extension = path.extname(entry.name).toLowerCase();
            const category = categorizeFile(relativePath);
            
            files.push({
              path: relativePath.replace(/\\/g, '/'), // Normalize to forward slashes
              fullPath,
              size: stats.size,
              modifiedTime: stats.mtimeMs,
              category,
              extension,
            });
          } catch (error) {
            // Skip files we can't stat (permissions, etc.)
            logger.debug('Failed to stat file', { 
              path: relativePath, 
              error: error instanceof Error ? error.message : String(error) 
            });
          }
        }
      }
    } catch (error) {
      // Skip directories we can't read
      logger.debug('Failed to read directory', { 
        path: dirPath, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
  
  await scanDirectory(workspacePath);
  
  logger.info('File discovery complete', { 
    totalFiles: files.length,
    byCategory: {
      source: files.filter(f => f.category === 'source').length,
      config: files.filter(f => f.category === 'config').length,
      docs: files.filter(f => f.category === 'docs').length,
      test: files.filter(f => f.category === 'test').length,
    }
  });
  
  return files;
}

/**
 * Detect project type based on files present
 */
export function detectProjectType(files: FileInfo[]): string {
  const fileNames = new Set(files.map(f => path.basename(f.path).toLowerCase()));
  const extensions = new Set(files.map(f => f.extension));
  
  // Check for specific project types
  if (fileNames.has('package.json')) {
    // Check for React
    if (extensions.has('.tsx') || extensions.has('.jsx')) {
      return 'react';
    }
    // Check for Vue
    if (extensions.has('.vue')) {
      return 'vue';
    }
    // Check for Svelte
    if (extensions.has('.svelte')) {
      return 'svelte';
    }
    return 'node';
  }
  
  if (fileNames.has('pyproject.toml') || fileNames.has('setup.py') || fileNames.has('requirements.txt')) {
    return 'python';
  }
  
  if (fileNames.has('cargo.toml')) {
    return 'rust';
  }
  
  if (fileNames.has('go.mod')) {
    return 'go';
  }
  
  if (fileNames.has('pom.xml') || fileNames.has('build.gradle')) {
    return 'java';
  }
  
  if (extensions.has('.cs')) {
    return 'csharp';
  }
  
  if (extensions.has('.rb')) {
    return 'ruby';
  }
  
  if (extensions.has('.php')) {
    return 'php';
  }
  
  return 'unknown';
}

/**
 * Find entry point files
 */
export function findEntryPoints(files: FileInfo[]): string[] {
  const entryPoints: string[] = [];
  
  const entryPatterns = [
    'index.ts',
    'index.tsx',
    'index.js',
    'index.jsx',
    'main.ts',
    'main.tsx',
    'main.js',
    'main.jsx',
    'app.ts',
    'app.tsx',
    'app.js',
    'app.jsx',
    'main.py',
    'app.py',
    '__init__.py',
    'main.rs',
    'lib.rs',
    'main.go',
    'main.java',
  ];
  
  for (const file of files) {
    const fileName = path.basename(file.path).toLowerCase();
    
    if (entryPatterns.includes(fileName)) {
      entryPoints.push(file.path);
    }
  }
  
  // Sort by path depth (prefer root-level entry points)
  entryPoints.sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    return depthA - depthB;
  });
  
  return entryPoints.slice(0, 5); // Return top 5 entry points
}

/**
 * Extract import statements from JavaScript/TypeScript code
 */
function extractJsImports(content: string): string[] {
  const imports: string[] = [];
  
  // ES6 imports: import ... from '...'
  // Handles: import X from '...', import { X } from '...', import * as X from '...', import type { X } from '...', import '...'
  const es6ImportRegex = /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = es6ImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  // CommonJS require: require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  // Dynamic imports: import('...')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  return imports;
}

/**
 * Extract import statements from Python code
 */
function extractPythonImports(content: string): string[] {
  const imports: string[] = [];
  
  // from ... import ...
  const fromImportRegex = /^\s*from\s+([^\s]+)\s+import/gm;
  let match;
  while ((match = fromImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  // import ... (simple imports)
  const importRegex = /^\s*import\s+([^\s,]+)/gm;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  return imports;
}

/**
 * Extract imports from a file based on its extension
 */
export async function extractImports(filePath: string, fullPath: string): Promise<string[]> {
  try {
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    
    // JavaScript/TypeScript files
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      return extractJsImports(content);
    }
    
    // Python files
    if (ext === '.py') {
      return extractPythonImports(content);
    }
    
    // Unsupported file type
    return [];
  } catch (error) {
    logger.debug('Failed to extract imports', { 
      path: filePath, 
      error: error instanceof Error ? error.message : String(error) 
    });
    return [];
  }
}

/**
 * Check if an import path is external (from node_modules or standard library)
 */
function isExternalImport(importPath: string): boolean {
  // Relative imports start with . or ..
  if (importPath.startsWith('.')) {
    return false;
  }
  
  // Absolute imports from workspace (rare but possible)
  if (importPath.startsWith('/')) {
    return false;
  }
  
  // Everything else is external (npm packages, python stdlib, etc.)
  return true;
}

/**
 * Resolve a relative import path to an absolute path within the workspace
 */
function resolveImportPath(
  importPath: string,
  fromFilePath: string,
  workspacePath: string,
  files: FileInfo[]
): string | null {
  // Skip external imports
  if (isExternalImport(importPath)) {
    return null;
  }
  
  // Get the directory of the importing file
  const fromDir = path.dirname(fromFilePath);
  
  let resolvedPath: string;
  
  // Handle Python relative imports (.module, ..module)
  if (importPath.startsWith('.')) {
    const ext = path.extname(fromFilePath).toLowerCase();
    
    if (ext === '.py') {
      // Python relative imports
      // .utils -> same directory
      // ..utils -> parent directory
      const dotCount = importPath.match(/^\.*/)![0].length;
      const moduleName = importPath.slice(dotCount);
      
      // Go up directories based on dot count
      let targetDir = fromDir;
      for (let i = 1; i < dotCount; i++) {
        targetDir = path.dirname(targetDir);
      }
      
      // Resolve the module name
      resolvedPath = path.join(targetDir, moduleName.replace(/\./g, path.sep));
    } else {
      // JavaScript/TypeScript relative imports
      resolvedPath = path.join(fromDir, importPath);
    }
  } else {
    // Absolute path from workspace root (rare)
    resolvedPath = importPath;
  }
  
  // Normalize to forward slashes
  resolvedPath = resolvedPath.replace(/\\/g, '/');
  
  // Try to find the file with various extensions
  const possibleExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.json'];
  const possiblePaths: string[] = [];
  
  // Direct file match
  for (const ext of possibleExtensions) {
    possiblePaths.push(resolvedPath + ext);
  }
  
  // Index file in directory
  for (const ext of possibleExtensions) {
    possiblePaths.push(path.join(resolvedPath, 'index' + ext).replace(/\\/g, '/'));
  }
  
  // Python __init__.py
  possiblePaths.push(path.join(resolvedPath, '__init__.py').replace(/\\/g, '/'));
  
  // Find matching file in our file list
  const filePathSet = new Set(files.map(f => f.path));
  
  for (const possiblePath of possiblePaths) {
    if (filePathSet.has(possiblePath)) {
      return possiblePath;
    }
  }
  
  // Could not resolve
  logger.debug('Could not resolve import', { 
    importPath, 
    fromFilePath, 
    resolvedPath,
    triedPaths: possiblePaths 
  });
  
  return null;
}

/**
 * Build a dependency graph for all files
 */
export async function buildDependencyGraph(
  files: FileInfo[],
  workspacePath: string
): Promise<Map<string, string[]>> {
  const dependencyGraph = new Map<string, string[]>();
  
  logger.info('Building dependency graph', { fileCount: files.length });
  
  // Only analyze source and test files
  const analyzableFiles = files.filter(f => 
    f.category === 'source' || f.category === 'test'
  );
  
  for (const file of analyzableFiles) {
    const imports = await extractImports(file.path, file.fullPath);
    const dependencies: string[] = [];
    
    for (const importPath of imports) {
      const resolvedPath = resolveImportPath(importPath, file.path, workspacePath, files);
      
      if (resolvedPath) {
        dependencies.push(resolvedPath);
      }
    }
    
    dependencyGraph.set(file.path, dependencies);
  }
  
  logger.info('Dependency graph built', { 
    filesAnalyzed: analyzableFiles.length,
    totalDependencies: Array.from(dependencyGraph.values()).flat().length
  });
  
  return dependencyGraph;
}

/**
 * Extract keywords from task description
 */
export function extractKeywords(taskDescription: string): string[] {
  // Convert to lowercase and split into words
  const words = taskDescription
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .split(/\s+/)
    .filter(word => word.length > 2); // Filter out very short words
  
  // Common stop words to exclude
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
    'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'now', 'old',
    'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too',
    'use', 'will', 'with', 'this', 'that', 'from', 'have', 'they', 'what', 'been', 'more',
    'when', 'your', 'into', 'just', 'know', 'than', 'them', 'then', 'some', 'time', 'very',
    'make', 'like', 'look', 'come', 'such', 'here', 'take', 'want', 'give', 'many', 'well',
    'their',
  ]);
  
  // Remove stop words and deduplicate
  const keywords = Array.from(new Set(words.filter(word => !stopWords.has(word))));
  
  return keywords;
}

/**
 * Calculate keyword match score for a file
 * Returns a score between 0 and 40
 */
function calculateKeywordScore(
  file: FileInfo,
  keywords: string[],
  workspacePath: string
): number {
  if (keywords.length === 0) return 0;
  
  const fileName = path.basename(file.path).toLowerCase();
  const filePath = file.path.toLowerCase();
  
  let score = 0;
  
  // Check filename matches (higher weight)
  for (const keyword of keywords) {
    if (fileName.includes(keyword)) {
      score += 10; // Strong signal if keyword in filename
    } else if (filePath.includes(keyword)) {
      score += 5; // Moderate signal if keyword in path
    }
  }
  
  // Try to read file content for keyword matching (only for small files)
  if (file.size < 100000) { // Only read files < 100KB
    try {
      const content = fs.readFileSync(file.fullPath, 'utf-8').toLowerCase();
      
      for (const keyword of keywords) {
        // Count occurrences of keyword in content
        const regex = new RegExp(`\\b${keyword}\\b`, 'g');
        const matches = content.match(regex);
        
        if (matches) {
          // Add points based on frequency, but cap it
          score += Math.min(matches.length * 2, 10);
        }
      }
    } catch (error) {
      // Skip files we can't read
      logger.debug('Could not read file for keyword matching', {
        path: file.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // Cap at 40 points
  return Math.min(score, 40);
}

/**
 * Calculate category weight score
 * Returns a score between 0 and 20
 */
function calculateCategoryScore(file: FileInfo): number {
  const categoryWeights: Record<FileInfo['category'], number> = {
    source: 20,
    test: 15,
    config: 10,
    docs: 5,
  };
  
  return categoryWeights[file.category] || 0;
}

/**
 * Calculate dependency centrality score
 * Files that are imported by many others are more central
 * Returns a score between 0 and 20
 */
function calculateCentralityScore(
  file: FileInfo,
  dependencyGraph: Map<string, string[]>
): number {
  // Count how many files import this file
  let importCount = 0;
  
  for (const [_, dependencies] of dependencyGraph) {
    if (dependencies.includes(file.path)) {
      importCount++;
    }
  }
  
  // Also consider how many files this file imports (lower is better for focused files)
  const outgoingDeps = dependencyGraph.get(file.path)?.length || 0;
  
  // Score based on incoming dependencies (more is better)
  const incomingScore = Math.min(importCount * 4, 15);
  
  // Penalty for too many outgoing dependencies (files that import everything)
  const outgoingPenalty = Math.min(outgoingDeps * 0.5, 5);
  
  return Math.max(incomingScore - outgoingPenalty, 0);
}

/**
 * Calculate recency score based on modification time
 * Returns a score between 0 and 10
 */
function calculateRecencyScore(file: FileInfo): number {
  const now = Date.now();
  const ageMs = now - file.modifiedTime;
  
  // Files modified in the last hour: 10 points
  if (ageMs < 3600000) return 10;
  
  // Files modified in the last day: 7 points
  if (ageMs < 86400000) return 7;
  
  // Files modified in the last week: 5 points
  if (ageMs < 604800000) return 5;
  
  // Files modified in the last month: 3 points
  if (ageMs < 2592000000) return 3;
  
  // Older files: 0 points
  return 0;
}

/**
 * Calculate size penalty
 * Returns a penalty between 0 and 10 (subtracted from total score)
 */
function calculateSizePenalty(file: FileInfo): number {
  // Prefer smaller, focused files
  // Files over 10KB start getting penalized
  const sizeKB = file.size / 1024;
  
  if (sizeKB < 10) return 0;
  if (sizeKB < 50) return 2;
  if (sizeKB < 100) return 5;
  if (sizeKB < 500) return 7;
  
  return 10; // Large files get max penalty
}

/**
 * Calculate overall relevance score for a file
 * Maximum possible score: 90 (40 + 20 + 20 + 10)
 */
export function calculateRelevanceScore(
  file: FileInfo,
  keywords: string[],
  dependencyGraph: Map<string, string[]>,
  workspacePath: string
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  
  // Keyword matching (0-40 points)
  const keywordScore = calculateKeywordScore(file, keywords, workspacePath);
  if (keywordScore > 0) {
    reasons.push(`Keyword matches (${keywordScore.toFixed(0)} pts)`);
  }
  
  // Category weight (0-20 points)
  const categoryScore = calculateCategoryScore(file);
  reasons.push(`${file.category} file (${categoryScore} pts)`);
  
  // Dependency centrality (0-20 points)
  const centralityScore = calculateCentralityScore(file, dependencyGraph);
  if (centralityScore > 0) {
    reasons.push(`Central in dependency graph (${centralityScore.toFixed(0)} pts)`);
  }
  
  // Recency (0-10 points)
  const recencyScore = calculateRecencyScore(file);
  if (recencyScore > 0) {
    reasons.push(`Recently modified (${recencyScore} pts)`);
  }
  
  // Size penalty (0-10 points subtracted)
  const sizePenalty = calculateSizePenalty(file);
  if (sizePenalty > 0) {
    reasons.push(`Size penalty (-${sizePenalty} pts)`);
  }
  
  const totalScore = keywordScore + categoryScore + centralityScore + recencyScore - sizePenalty;
  
  return {
    score: Math.max(totalScore, 0), // Ensure non-negative
    reasons,
  };
}

/**
 * Rank files by relevance to a task
 */
export function rankFilesByRelevance(
  files: FileInfo[],
  taskDescription: string,
  dependencyGraph: Map<string, string[]>,
  workspacePath: string,
  maxFiles: number = 20
): FileRelevance[] {
  logger.info('Ranking files by relevance', { 
    fileCount: files.length, 
    taskDescription: taskDescription.slice(0, 100) 
  });
  
  // Extract keywords from task description
  const keywords = extractKeywords(taskDescription);
  logger.debug('Extracted keywords', { keywords });
  
  // Calculate scores for all files
  const scoredFiles: FileRelevance[] = files.map(file => {
    const { score, reasons } = calculateRelevanceScore(
      file,
      keywords,
      dependencyGraph,
      workspacePath
    );
    
    return {
      path: file.path,
      score,
      reasons,
      category: file.category,
    };
  });
  
  // Sort by score (descending) and take top N
  const rankedFiles = scoredFiles
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
  
  logger.info('File ranking complete', {
    totalFiles: files.length,
    rankedFiles: rankedFiles.length,
    topScore: rankedFiles[0]?.score || 0,
    bottomScore: rankedFiles[rankedFiles.length - 1]?.score || 0,
  });
  
  return rankedFiles;
}

/**
 * Cache entry for context analysis
 */
interface CacheEntry {
  analysis: ContextAnalysis;
  timestamp: number;
}

/**
 * In-memory cache for context analysis results
 */
const analysisCache = new Map<string, CacheEntry>();

/**
 * Generate a cache key from workspace path and task description
 */
function generateCacheKey(workspacePath: string, taskDescription: string): string {
  // Normalize workspace path and combine with task description
  const normalizedPath = workspacePath.replace(/\\/g, '/').toLowerCase();
  const normalizedTask = taskDescription.toLowerCase().trim();
  
  // Create a simple hash-like key
  return `${normalizedPath}::${normalizedTask}`;
}

/**
 * Check if a cache entry is still valid
 */
function isCacheValid(entry: CacheEntry, cacheTimeMs: number): boolean {
  const age = Date.now() - entry.timestamp;
  return age < cacheTimeMs;
}

/**
 * Get cached analysis if available and valid
 */
function getCachedAnalysis(
  workspacePath: string,
  taskDescription: string,
  cacheTimeMs: number
): ContextAnalysis | null {
  const cacheKey = generateCacheKey(workspacePath, taskDescription);
  const entry = analysisCache.get(cacheKey);
  
  if (!entry) {
    logger.debug('Cache miss - no entry found', { cacheKey });
    return null;
  }
  
  if (!isCacheValid(entry, cacheTimeMs)) {
    logger.debug('Cache miss - entry expired', { 
      cacheKey, 
      age: Date.now() - entry.timestamp,
      maxAge: cacheTimeMs 
    });
    // Remove expired entry
    analysisCache.delete(cacheKey);
    return null;
  }
  
  logger.info('Cache hit - returning cached analysis', { 
    cacheKey,
    age: Date.now() - entry.timestamp 
  });
  
  return entry.analysis;
}

/**
 * Store analysis in cache
 */
function setCachedAnalysis(
  workspacePath: string,
  taskDescription: string,
  analysis: ContextAnalysis
): void {
  const cacheKey = generateCacheKey(workspacePath, taskDescription);
  
  analysisCache.set(cacheKey, {
    analysis,
    timestamp: Date.now(),
  });
  
  logger.debug('Analysis cached', { 
    cacheKey,
    cacheSize: analysisCache.size 
  });
}

/**
 * Clear expired cache entries
 */
function cleanupCache(cacheTimeMs: number): void {
  const now = Date.now();
  let removedCount = 0;
  
  for (const [key, entry] of analysisCache.entries()) {
    if (!isCacheValid(entry, cacheTimeMs)) {
      analysisCache.delete(key);
      removedCount++;
    }
  }
  
  if (removedCount > 0) {
    logger.debug('Cache cleanup complete', { 
      removedCount,
      remainingEntries: analysisCache.size 
    });
  }
}

/**
 * Progress callback for context gathering
 */
export type ContextGatheringProgressCallback = (status: string) => void;

/**
 * Main function to gather context with caching
 */
export async function gatherContext(
  workspacePath: string,
  taskDescription: string,
  config?: Partial<ContextGathererConfig>,
  onProgress?: ContextGatheringProgressCallback
): Promise<ContextAnalysis> {
  const fullConfig: ContextGathererConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  
  logger.info('Starting context gathering', { 
    workspacePath, 
    taskDescription: taskDescription.slice(0, 100),
    config: fullConfig 
  });
  
  // Check cache first
  const cached = getCachedAnalysis(workspacePath, taskDescription, fullConfig.cacheTimeMs);
  if (cached) {
    onProgress?.('Using cached context analysis...');
    return cached;
  }
  
  // Perform analysis
  logger.info('Performing fresh context analysis');
  onProgress?.('Starting context analysis...');
  
  // 1. Discover files
  onProgress?.('Discovering files in workspace...');
  const files = await discoverFiles(workspacePath, fullConfig.excludePatterns);
  onProgress?.(`Found ${files.length} files`);
  
  // 2. Build dependency graph
  onProgress?.('Building dependency graph...');
  const dependencyGraph = await buildDependencyGraph(files, workspacePath);
  const totalDeps = Array.from(dependencyGraph.values()).flat().length;
  onProgress?.(`Analyzed ${dependencyGraph.size} files, found ${totalDeps} dependencies`);
  
  // 3. Detect project type
  onProgress?.('Detecting project type...');
  const projectType = detectProjectType(files);
  onProgress?.(`Detected project type: ${projectType}`);
  
  // 4. Find entry points
  onProgress?.('Finding entry points...');
  const entryPoints = findEntryPoints(files);
  onProgress?.(`Found ${entryPoints.length} entry points`);
  
  // 5. Rank files by relevance
  onProgress?.('Ranking files by relevance...');
  const relevantFiles = rankFilesByRelevance(
    files,
    taskDescription,
    dependencyGraph,
    workspacePath,
    fullConfig.maxFiles
  );
  onProgress?.(`Ranked ${relevantFiles.length} most relevant files`);
  
  // Build result
  const analysis: ContextAnalysis = {
    relevantFiles,
    dependencyGraph,
    projectType,
    entryPoints,
  };
  
  // Cache the result
  setCachedAnalysis(workspacePath, taskDescription, analysis);
  
  // Cleanup old cache entries
  cleanupCache(fullConfig.cacheTimeMs);
  
  logger.info('Context gathering complete', {
    relevantFiles: relevantFiles.length,
    projectType,
    entryPoints: entryPoints.length,
    totalFiles: files.length,
  });
  
  onProgress?.('Context gathering complete');
  
  return analysis;
}
