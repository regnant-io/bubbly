import { getFileTree, listDirectory, searchInFiles, readFile } from './filesystem';
import { detectProjectType } from '../../steering/loader';
import path from 'path';
import fs from 'fs';

export interface ContextReport {
  projectType: string;
  relevantFiles: string[];
  patterns: {
    componentStyle?: string;
    stateManagement?: string;
    styling?: string;
    testFramework?: string;
    buildTool?: string;
  };
  recommendations: string[];
  fileTree: string;
  keyFiles: {
    config: string[];
    entry: string[];
    tests: string[];
  };
}

/**
 * Gather context about the project to help with task execution
 */
export async function gatherContext(
  workspacePath: string,
  taskDescription: string,
  focusAreas?: string[]
): Promise<ContextReport> {
  const projectType = detectProjectType(workspacePath);
  const fileTree = getFileTree(workspacePath, '.', 3);
  
  // Find key configuration files
  const keyFiles = findKeyFiles(workspacePath);
  
  // Analyze project patterns
  const patterns = await analyzeProjectPatterns(workspacePath, keyFiles);
  
  // Find files relevant to the task
  const relevantFiles = await findRelevantFiles(
    workspacePath,
    taskDescription,
    focusAreas,
    projectType
  );
  
  // Build recommendations
  const recommendations = buildRecommendations(
    projectType,
    patterns,
    taskDescription,
    keyFiles
  );
  
  return {
    projectType,
    relevantFiles,
    patterns,
    recommendations,
    fileTree,
    keyFiles
  };
}

/**
 * Find key configuration and entry files
 */
function findKeyFiles(workspacePath: string): {
  config: string[];
  entry: string[];
  tests: string[];
} {
  const config: string[] = [];
  const entry: string[] = [];
  const tests: string[] = [];
  
  const configFiles = [
    'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
    'webpack.config.js', 'tailwind.config.js', 'jest.config.js',
    'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml',
    '.env', '.env.example', 'docker-compose.yml', 'Dockerfile'
  ];
  
  const entryFiles = [
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/App.ts', 'index.ts', 'main.py', 'app.py',
    'src/main.rs', 'main.go'
  ];
  
  // Check for config files
  for (const file of configFiles) {
    const fullPath = path.join(workspacePath, file);
    if (fs.existsSync(fullPath)) {
      config.push(file);
    }
  }
  
  // Check for entry files
  for (const file of entryFiles) {
    const fullPath = path.join(workspacePath, file);
    if (fs.existsSync(fullPath)) {
      entry.push(file);
    }
  }
  
  // Find test files
  try {
    const testMatches = searchInFiles(workspacePath, 'test', '.', '.test.');
    tests.push(...testMatches.slice(0, 5).map(m => m.file));
  } catch {
    // Ignore errors
  }
  
  return { config, entry, tests };
}

/**
 * Analyze project patterns from key files
 */
async function analyzeProjectPatterns(
  workspacePath: string,
  keyFiles: { config: string[]; entry: string[]; tests: string[] }
): Promise<ContextReport['patterns']> {
  const patterns: ContextReport['patterns'] = {};
  
  // Check package.json for patterns
  if (keyFiles.config.includes('package.json')) {
    try {
      const pkgContent = await readFile(workspacePath, 'package.json');
      const pkg = JSON.parse(pkgContent);
      
      // Detect state management
      if (pkg.dependencies?.zustand) patterns.stateManagement = 'zustand';
      else if (pkg.dependencies?.redux) patterns.stateManagement = 'redux';
      else if (pkg.dependencies?.mobx) patterns.stateManagement = 'mobx';
      
      // Detect styling
      if (pkg.dependencies?.tailwindcss || pkg.devDependencies?.tailwindcss) {
        patterns.styling = 'tailwind';
      } else if (pkg.dependencies?.['styled-components']) {
        patterns.styling = 'styled-components';
      }
      
      // Detect test framework
      if (pkg.devDependencies?.jest) patterns.testFramework = 'jest';
      else if (pkg.devDependencies?.vitest) patterns.testFramework = 'vitest';
      else if (pkg.devDependencies?.mocha) patterns.testFramework = 'mocha';
      
      // Detect build tool
      if (pkg.devDependencies?.vite) patterns.buildTool = 'vite';
      else if (pkg.devDependencies?.webpack) patterns.buildTool = 'webpack';
      
      // Detect component style
      if (pkg.dependencies?.react) {
        patterns.componentStyle = 'React functional components';
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  return patterns;
}

/**
 * Find files relevant to the task
 */
async function findRelevantFiles(
  workspacePath: string,
  taskDescription: string,
  focusAreas: string[] = [],
  projectType: string
): Promise<string[]> {
  const relevant: Set<string> = new Set();
  
  // Extract keywords from task description
  const keywords = extractKeywords(taskDescription, focusAreas);
  
  // Search for files containing keywords
  for (const keyword of keywords) {
    try {
      const matches = searchInFiles(workspacePath, keyword, '.', undefined);
      // Add top 3 matches per keyword
      matches.slice(0, 3).forEach(m => relevant.add(m.file));
    } catch {
      // Ignore errors
    }
  }
  
  // Add common patterns based on task type
  if (taskDescription.toLowerCase().includes('component')) {
    try {
      const components = searchInFiles(workspacePath, 'component', 'src', '.tsx');
      components.slice(0, 2).forEach(m => relevant.add(m.file));
    } catch {}
  }
  
  if (taskDescription.toLowerCase().includes('api') || taskDescription.toLowerCase().includes('endpoint')) {
    try {
      const apis = searchInFiles(workspacePath, 'api', 'src', undefined);
      apis.slice(0, 3).forEach(m => relevant.add(m.file));
    } catch {}
  }
  
  return Array.from(relevant).slice(0, 10); // Limit to 10 files
}

/**
 * Extract keywords from task description
 */
function extractKeywords(taskDescription: string, focusAreas: string[]): string[] {
  const keywords: Set<string> = new Set();
  
  // Add focus areas
  focusAreas.forEach(area => keywords.add(area.toLowerCase()));
  
  // Extract nouns and important words (simple heuristic)
  const words = taskDescription.toLowerCase().split(/\s+/);
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
  
  words.forEach(word => {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (cleaned.length > 3 && !stopWords.has(cleaned)) {
      keywords.add(cleaned);
    }
  });
  
  return Array.from(keywords).slice(0, 5); // Top 5 keywords
}

/**
 * Build recommendations based on analysis
 */
function buildRecommendations(
  projectType: string,
  patterns: ContextReport['patterns'],
  taskDescription: string,
  keyFiles: { config: string[]; entry: string[]; tests: string[] }
): string[] {
  const recommendations: string[] = [];
  
  // Project type recommendations
  if (projectType.includes('React')) {
    recommendations.push('Follow React best practices and hooks patterns');
    if (patterns.componentStyle) {
      recommendations.push(`Use ${patterns.componentStyle} for consistency`);
    }
  }
  
  // State management
  if (patterns.stateManagement) {
    recommendations.push(`Use ${patterns.stateManagement} for state management`);
  }
  
  // Styling
  if (patterns.styling === 'tailwind') {
    recommendations.push('Use Tailwind CSS classes for styling');
  } else if (patterns.styling) {
    recommendations.push(`Follow ${patterns.styling} styling patterns`);
  }
  
  // Testing
  if (patterns.testFramework && taskDescription.toLowerCase().includes('test')) {
    recommendations.push(`Write tests using ${patterns.testFramework}`);
  }
  
  // Configuration
  if (keyFiles.config.length > 0) {
    recommendations.push(`Review ${keyFiles.config[0]} for project configuration`);
  }
  
  // Entry points
  if (keyFiles.entry.length > 0) {
    recommendations.push(`Check ${keyFiles.entry[0]} to understand app structure`);
  }
  
  // General
  recommendations.push('Match existing code style and patterns');
  recommendations.push('Read relevant files before making changes');
  
  return recommendations;
}
