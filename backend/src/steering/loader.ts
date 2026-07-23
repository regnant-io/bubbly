import fs from 'fs';
import path from 'path';
import { getProjectDataPath } from '../agent/projectData';

export function loadSteeringContext(workspacePath: string): string {
  const parts: string[] = [];

  // 1. Check for BUBBLY.md or AGENTS.md at workspace root
  const rootFiles = ['BUBBLY.md', 'AGENTS.md', '.bubbly.md'];
  for (const f of rootFiles) {
    const fp = path.join(workspacePath, f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8').trim();
      if (content) {
        parts.push(`## Project Constitution (${f})\n\n${content}`);
        break;
      }
    }
  }

  // 2. Load steering/ files from the project's external data dir.
  const steeringDir = getProjectDataPath(workspacePath, 'steering');
  if (fs.existsSync(steeringDir)) {
    const files = fs.readdirSync(steeringDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(steeringDir, file), 'utf8').trim();
      if (content) {
        const label = path.basename(file, '.md');
        parts.push(`## Steering: ${label}\n\n${content}`);
      }
    }
  }

  if (parts.length === 0) return '';

  return `---\n# PROJECT STEERING RULES\n\nThese rules are always in effect. Follow them strictly.\n\n${parts.join('\n\n---\n\n')}\n\n---`;
}

export function loadReadme(workspacePath: string): string {
  for (const f of ['README.md', 'readme.md', 'README.txt']) {
    const fp = path.join(workspacePath, f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      // Truncate to 2000 chars
      return content.length > 2000 ? content.slice(0, 2000) + '\n[...truncated]' : content;
    }
  }
  return '';
}

export function detectProjectType(workspacePath: string): string {
  const markers: Record<string, string> = {
    'package.json': 'Node.js/JavaScript/TypeScript',
    'pyproject.toml': 'Python',
    'requirements.txt': 'Python',
    'Cargo.toml': 'Rust',
    'go.mod': 'Go',
    'pom.xml': 'Java/Maven',
    'build.gradle': 'Java/Gradle',
    'composer.json': 'PHP',
    'Gemfile': 'Ruby',
    'mix.exs': 'Elixir',
    '.csproj': 'C#/.NET',
  };

  for (const [file, type] of Object.entries(markers)) {
    const fp = path.join(workspacePath, file);
    if (fs.existsSync(fp)) {
      // For package.json, try to get framework info
      if (file === 'package.json') {
        try {
          const pkg = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.react) return 'React/TypeScript';
          if (deps.vue) return 'Vue.js';
          if (deps.svelte) return 'Svelte';
          if (deps.next) return 'Next.js';
          if (deps.express) return 'Express.js/Node.js';
          if (deps.fastify) return 'Fastify/Node.js';
          if (deps.nestjs || deps['@nestjs/core']) return 'NestJS';
          return type;
        } catch {
          return type;
        }
      }
      return type;
    }
  }
  return 'unknown';
}
