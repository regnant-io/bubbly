import { isLongRunningCommand, defaultTimeoutFor, DEFAULT_COMMAND_TIMEOUT_MS } from './shell';

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

  // Regression: the old framework pattern matched the framework NAME anywhere in
  // the command line, so every scaffold and every install that merely mentioned
  // a framework was backgrounded. The agent was then told "carry on, do NOT wait
  // on it" and proceeded against a project that had never been created.
  describe('scaffolders and installs are never backgrounded', () => {
    const mustBeForeground = [
      'npm create vite@latest my-app -- --template react',
      'npm create vite@latest my-app -- --template react-ts',
      'npm create vite@latest . -- --template vue',
      'npm create vue@latest my-app -- --default',
      'npm create astro@latest my-app -- --template minimal --yes',
      'npx create-next-app@latest my-app --ts --tailwind --eslint --app --no-src-dir --use-npm',
      'npx create-react-app my-app',
      'npm init vite@latest my-app',
      'npm init -y',
      'npx nuxi init my-app',
      'npm install',
      'npm install vite',
      'npm i vite@latest',
      'npm i -D tailwindcss postcss autoprefixer',
      'npm install --save-dev vitest',
      'pnpm add -D vite',
      'yarn add next',
      'bun add astro',
      'npx tailwindcss init -p',
      'npx shadcn@latest init',
      'npm uninstall gatsby',
      'npm ls vite',
    ];

    it.each(mustBeForeground)('treats "%s" as one-shot', (cmd) => {
      expect(isLongRunningCommand(cmd)).toBe(false);
    });
  });

  // The flip side: a dev binary actually INVOKED still has to be backgrounded.
  describe('dev binaries invoked directly are still long-running', () => {
    const mustBeBackground = [
      'npx vite',
      'npx vite --host',
      'npx next dev',
      'bunx astro dev',
      'pnpm dlx serve dist',
      'vite --port 5173',
      'nuxt dev',
    ];

    it.each(mustBeBackground)('detects "%s" as long-running', (cmd) => {
      expect(isLongRunningCommand(cmd)).toBe(true);
    });
  });
});

describe('defaultTimeoutFor', () => {
  // A flat 30s default meant `npm install` on a React app was killed EVERY time
  // and reported to the agent as "cancelled", leaving node_modules half-written.
  it('gives installs and scaffolds minutes, not seconds', () => {
    expect(defaultTimeoutFor('npm install')).toBeGreaterThanOrEqual(300_000);
    expect(defaultTimeoutFor('npm i -D tailwindcss postcss autoprefixer')).toBeGreaterThanOrEqual(300_000);
    expect(defaultTimeoutFor('npm create vite@latest my-app -- --template react')).toBeGreaterThanOrEqual(300_000);
    expect(defaultTimeoutFor('npx create-next-app@latest my-app')).toBeGreaterThanOrEqual(300_000);
    expect(defaultTimeoutFor('pip install -r requirements.txt')).toBeGreaterThanOrEqual(300_000);
    expect(defaultTimeoutFor('git clone https://example.com/repo.git')).toBeGreaterThanOrEqual(180_000);
  });

  it('gives builds and test suites a middling budget', () => {
    expect(defaultTimeoutFor('npm run build')).toBeGreaterThanOrEqual(180_000);
    expect(defaultTimeoutFor('npm test')).toBeGreaterThanOrEqual(180_000);
    expect(defaultTimeoutFor('npx vitest run')).toBeGreaterThanOrEqual(180_000);
  });

  it('leaves ordinary commands on the plain default', () => {
    expect(defaultTimeoutFor('git status')).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(defaultTimeoutFor('ls -la')).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });
});
