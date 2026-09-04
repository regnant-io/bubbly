/**
 * The NODE_ENV leak, pinned from both directions.
 *
 * Two failure modes have actually shipped here, and the tests have to hold the
 * line against both:
 *
 *  1. INHERITING TOO MUCH — NODE_ENV=production from the packaged build reaches
 *     `npm install`, which then omits devDependencies and reports "up to date"
 *     forever. This is the bug users saw as "I can't set up a React project".
 *  2. INHERITING TOO LITTLE — the fix for (1) was an allowlist of fourteen
 *     variables, which silently deleted JAVA_HOME, proxies, PATHEXT, pnpm's
 *     store and everything else a real toolchain needs. Quieter, but worse.
 */

import { buildChildEnv, nonInteractiveEnv, strippedKeys } from './childEnv';

describe('buildChildEnv removes what describes Bubbly itself', () => {
  it('drops NODE_ENV entirely rather than forcing a value', () => {
    const env = buildChildEnv({ base: { NODE_ENV: 'production', PATH: '/usr/bin' } });
    expect(env.NODE_ENV).toBeUndefined();
  });

  it('drops it even when it is not "production"', () => {
    // Any inherited value is a statement about OUR process, not the user's.
    const env = buildChildEnv({ base: { NODE_ENV: 'test', PATH: '/usr/bin' } });
    expect(env.NODE_ENV).toBeUndefined();
  });

  it('drops the npm lifecycle variables `npm start` exports', () => {
    const env = buildChildEnv({
      base: {
        npm_package_name: 'bubbly-backend',
        npm_package_version: '1.0.0',
        npm_lifecycle_event: 'start',
        npm_config_production: 'true',
        PATH: '/usr/bin',
      },
    });
    expect(env.npm_package_name).toBeUndefined();
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.npm_config_production).toBeUndefined();
  });

  it('drops Electron and Node flag variables', () => {
    const env = buildChildEnv({
      base: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=8192', PATH: '/usr/bin' },
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('drops Bubbly\'s own namespaced variables', () => {
    const env = buildChildEnv({ base: { BUBBLY_ELECTRON: '1', BUBBLY_FRONTEND_DIST: '/x', PATH: '/usr/bin' } });
    expect(env.BUBBLY_ELECTRON).toBeUndefined();
    expect(env.BUBBLY_FRONTEND_DIST).toBeUndefined();
  });
});

describe('buildChildEnv keeps what the user\'s toolchain needs', () => {
  const toolchain = {
    PATH: '/usr/bin:/opt/homebrew/bin',
    JAVA_HOME: '/opt/jdk-21',
    CARGO_HOME: '/home/u/.cargo',
    GOPATH: '/home/u/go',
    PYTHONPATH: '/home/u/lib',
    PNPM_HOME: '/home/u/.pnpm',
    NVM_DIR: '/home/u/.nvm',
    HTTP_PROXY: 'http://proxy:8080',
    HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    LANG: 'en_US.UTF-8',
  };

  it.each(Object.keys(toolchain))('keeps %s', (key) => {
    const env = buildChildEnv({ base: toolchain });
    expect(env[key]).toBe((toolchain as Record<string, string>)[key]);
  });

  it('keeps a private registry configured on the machine', () => {
    const env = buildChildEnv({ base: { npm_config_registry: 'https://registry.internal/', PATH: '/usr/bin' } });
    expect(env.npm_config_registry).toBe('https://registry.internal/');
  });
});

describe('interactive vs non-interactive', () => {
  it('a one-shot command is non-interactive and colourless', () => {
    const env = buildChildEnv({ base: { PATH: '/usr/bin' } });
    expect(env.CI).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.NO_COLOR).toBe('1');
  });

  it('a user terminal is interactive and keeps colour', () => {
    const env = buildChildEnv({ interactive: true, base: { PATH: '/usr/bin' } });
    expect(env.CI).toBeUndefined();
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBeTruthy();
  });

  it('an explicit NODE_ENV in `extra` is honoured — the user asked for it', () => {
    const env = buildChildEnv({ base: { PATH: '/usr/bin' }, extra: { NODE_ENV: 'production' } });
    expect(env.NODE_ENV).toBe('production');
  });
});

describe('nonInteractiveEnv', () => {
  it('answers the questions installers ask', () => {
    const env = nonInteractiveEnv();
    expect(env.npm_config_yes).toBe('true');
    expect(env.CI).toBe('1');
  });
});

describe('strippedKeys', () => {
  it('reports what would be removed, for the doctor command', () => {
    expect(strippedKeys({ NODE_ENV: 'production', PATH: '/usr/bin' })).toEqual(['NODE_ENV']);
  });
});
