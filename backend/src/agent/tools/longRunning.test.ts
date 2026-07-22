import { isLongRunningCommand } from './shell';

describe('isLongRunningCommand', () => {
  const longRunning = [
    'npm run dev',
    'npm start',
    'yarn dev',
    'pnpm dev',
    'bun dev',
    'npm run serve',
    'npm run watch',
    'vite',
    'next dev',
    'nuxt dev',
    'ng serve',
    'nodemon server.js',
    'webpack-dev-server',
    'webpack serve',
    'tsc --watch',
    'tsc -w',
    'jest --watch',
    'vitest',
    'http-server .',
    'serve -s build',
    'live-server',
    'python -m http.server 8000',
    'python3 -m http.server',
    'flask run',
    'uvicorn main:app --reload',
    'gunicorn app:app',
    'python manage.py runserver',
    'rails server',
    'rails s',
    'php -S localhost:8000',
    'dotnet watch run',
    'cargo watch -x run',
  ];

  const oneShot = [
    'npm install',
    'npm ci',
    'npm run build',
    'next build',
    'yarn build',
    'pnpm build',
    'vitest run',
    'vitest --run',
    'jest',
    'tsc --noEmit',
    'tsc',
    'git status',
    'ls -la',
    'python script.py',
    'python manage.py migrate',
    'cargo build',
    'go build ./...',
    'echo hello',
    'mkdir foo',
  ];

  it.each(longRunning)('detects "%s" as long-running', (cmd) => {
    expect(isLongRunningCommand(cmd)).toBe(true);
  });

  it.each(oneShot)('treats "%s" as one-shot', (cmd) => {
    expect(isLongRunningCommand(cmd)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isLongRunningCommand('')).toBe(false);
    expect(isLongRunningCommand('   ')).toBe(false);
  });
});
