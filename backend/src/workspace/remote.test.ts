/**
 * The parts of remote support that MUST be right.
 *
 * Everything here is a containment or credential question. A bug in path
 * resolution is not a broken feature — it is Bubbly writing to
 * `/etc/ssh/sshd_config` on someone else's server because a model passed
 * `../../..` and nothing stopped it. There is no local filesystem to fall back
 * on for that check, so the rule is enforced textually and pinned here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRemotePath, shellQuote } from './sshProvider';
import { parseRepoUrl, clonePathFor, redact } from './gitSource';
import { parseSshConfig } from '../secrets/credentialSources';
import { apiBase } from './forge';

jest.mock('../db/index', () => ({ getSetting: () => 'false', getDb: () => { throw new Error('not used'); } }));

describe('remote path containment', () => {
  const root = '/home/deploy/app';

  it('resolves an ordinary relative path', () => {
    expect(resolveRemotePath(root, 'src/index.ts')).toBe('/home/deploy/app/src/index.ts');
  });

  it('treats "." as the root', () => {
    expect(resolveRemotePath(root, '.')).toBe('/home/deploy/app');
  });

  it('normalizes redundant segments', () => {
    expect(resolveRemotePath(root, './src/../src/index.ts')).toBe('/home/deploy/app/src/index.ts');
  });

  it('REFUSES to escape the root with ..', () => {
    expect(() => resolveRemotePath(root, '../../../etc/passwd')).toThrow(/outside the workspace/);
  });

  it('refuses a deep escape that lands back under a similar name', () => {
    // /home/deploy/application is NOT inside /home/deploy/app, and a naive
    // startsWith check says it is. That is the classic prefix bug.
    expect(() => resolveRemotePath(root, '../application/secret')).toThrow(/outside the workspace/);
  });

  it('refuses an absolute path that is outside', () => {
    expect(() => resolveRemotePath(root, '/etc/shadow')).toThrow(/outside the workspace/);
  });

  it('allows a path that is genuinely inside, however it is written', () => {
    expect(resolveRemotePath(root, 'a/b/../c')).toBe('/home/deploy/app/a/c');
  });

  it('handles a root with a trailing slash', () => {
    expect(resolveRemotePath('/srv/site/', 'index.html')).toBe('/srv/site/index.html');
  });
});

describe('shell quoting', () => {
  it('wraps a plain word', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('neutralises a path with spaces', () => {
    expect(shellQuote('/home/me/my project')).toBe("'/home/me/my project'");
  });

  it('escapes an embedded single quote so the word cannot be broken out of', () => {
    // The injection that matters: without this, a filename containing a quote
    // ends the quoted word and the rest is executed as a command.
    expect(shellQuote("it's; rm -rf /")).toBe(`'it'\\''s; rm -rf /'`);
  });

  it('leaves shell metacharacters inert by keeping them inside the quotes', () => {
    // Inside POSIX single quotes NOTHING is special, so the test is not that the
    // metacharacters are removed — they must survive verbatim — but that the
    // quoting is never broken out of. The only character that can do that is a
    // single quote, and every one of them must be escaped.
    const quoted = shellQuote('$(whoami) `id` && echo pwned');
    expect(quoted).toBe("'$(whoami) `id` && echo pwned'");
    const inner = quoted.slice(1, -1);
    expect(inner.replace(/'\\''/g, '')).not.toContain("'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('repository URL parsing', () => {
  it('understands an https URL', () => {
    const p = parseRepoUrl('https://github.com/acme/widget');
    expect(p).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget', forge: 'github', ssh: false });
  });

  it('understands an https URL with .git', () => {
    expect(parseRepoUrl('https://github.com/acme/widget.git')?.repo).toBe('widget');
  });

  it('understands the scp-style SSH form', () => {
    const p = parseRepoUrl('git@github.com:acme/widget.git');
    expect(p).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget', ssh: true });
  });

  it('understands bare owner/repo as GitHub, which is what people mean', () => {
    expect(parseRepoUrl('acme/widget')).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'widget' });
  });

  it('handles nested GitLab groups', () => {
    const p = parseRepoUrl('https://gitlab.com/team/sub/project');
    expect(p).toMatchObject({ owner: 'team/sub', repo: 'project', forge: 'gitlab' });
  });

  it('recognises a self-hosted instance by hostname', () => {
    expect(parseRepoUrl('https://gitlab.internal.acme.com/ops/infra')?.forge).toBe('gitlab');
    expect(parseRepoUrl('https://github.acme.com/ops/infra')?.forge).toBe('github');
  });

  it('classifies an unknown host as "other" rather than guessing', () => {
    expect(parseRepoUrl('https://git.sr.ht/~user/thing')?.forge).toBe('other');
  });

  it('rejects nonsense instead of producing a broken clone', () => {
    expect(parseRepoUrl('')).toBeNull();
    expect(parseRepoUrl('not a url at all with spaces')).toBeNull();
  });
});

describe('clone paths', () => {
  it('namespaces by host and owner so two same-named repos cannot collide', () => {
    const a = clonePathFor(parseRepoUrl('https://github.com/acme/api')!);
    const b = clonePathFor(parseRepoUrl('https://github.com/personal/api')!);
    expect(a).not.toBe(b);
    expect(a).toContain('acme');
    expect(b).toContain('personal');
  });

  it('keeps a nested group structure', () => {
    const p = clonePathFor(parseRepoUrl('https://gitlab.com/team/sub/project')!);
    expect(p).toContain(`team${path.sep}sub`);
  });
});

describe('redaction', () => {
  it('removes a bearer token', () => {
    expect(redact('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain('ghp_');
  });

  it('removes credentials embedded in a URL', () => {
    expect(redact('https://user:s3cret@github.com/a/b')).toBe('https://***:***@github.com/a/b');
  });

  it('removes a bare GitHub token', () => {
    expect(redact('failed with ghp_1234567890abcdefghij')).not.toContain('ghp_1234567890abcdefghij');
  });

  it('removes a GitLab PAT', () => {
    expect(redact('token glpat-ABCDEFGHIJKLMNOPQRST')).not.toContain('glpat-ABCDEFGHIJKLMNOPQRST');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('fatal: repository not found')).toBe('fatal: repository not found');
  });
});

describe('~/.ssh/config parsing', () => {
  const config = `
# work
Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_work

Host *.internal
  User admin

Host staging
  HostName staging.acme.com
`;

  it('reads the fields people actually set', () => {
    const hosts = parseSshConfig(config);
    const prod = hosts.find((h) => h.host === 'prod');
    expect(prod).toMatchObject({ hostName: '10.0.0.5', user: 'deploy', port: 2222 });
    expect(prod?.identityFile).toContain('id_work');
  });

  it('skips wildcard blocks, which configure a pattern rather than a place', () => {
    expect(parseSshConfig(config).some((h) => h.host.includes('*'))).toBe(false);
  });

  it('does not leak one block\'s settings into the next', () => {
    const staging = parseSshConfig(config).find((h) => h.host === 'staging');
    expect(staging?.user).toBeUndefined();
    expect(staging?.port).toBeUndefined();
  });

  it('ignores comments and blank lines', () => {
    expect(parseSshConfig('# nothing here\n\n').length).toBe(0);
  });
});

describe('forge API bases', () => {
  it('uses the dedicated host for github.com', () => {
    expect(apiBase({ forge: 'github', host: 'github.com' })).toBe('https://api.github.com');
  });

  it('uses the /api/v3 path for GitHub Enterprise', () => {
    expect(apiBase({ forge: 'github', host: 'ghe.acme.com' })).toBe('https://ghe.acme.com/api/v3');
  });

  it('uses /api/v4 for any GitLab, self-hosted or not', () => {
    expect(apiBase({ forge: 'gitlab', host: 'gitlab.com' })).toBe('https://gitlab.com/api/v4');
    expect(apiBase({ forge: 'gitlab', host: 'gitlab.internal' })).toBe('https://gitlab.internal/api/v4');
  });
});

describe('the vault', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-vault-'));
    originalHome = process.env.BUBBLY_HOME;
    process.env.BUBBLY_HOME = home;
    delete process.env.BUBBLY_VAULT_KEY;
    jest.isolateModules(() => { /* fresh module state per case */ });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.BUBBLY_HOME;
    else process.env.BUBBLY_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const freshVault = () => {
    let mod!: typeof import('../secrets/vault');
    jest.isolateModules(() => { mod = require('../secrets/vault'); });
    return mod;
  };

  it('round-trips a secret', () => {
    const vault = freshVault();
    vault.setSecret('github:github.com:token', 'ghp_secret');
    expect(vault.getSecret('github:github.com:token')).toBe('ghp_secret');
  });

  it('returns null for something never stored', () => {
    expect(freshVault().getSecret('nope')).toBeNull();
  });

  it('never writes the plaintext to disk', () => {
    const vault = freshVault();
    vault.setSecret('k', 'super-secret-value');
    const onDisk = fs.readFileSync(path.join(home, '.bubbly', 'vault.json'), 'utf8');
    expect(onDisk).not.toContain('super-secret-value');
  });

  it('lists names without exposing values', () => {
    const vault = freshVault();
    vault.setSecret('a', '1');
    vault.setSecret('b', '2');
    expect(vault.listSecretNames()).toEqual(['a', 'b']);
  });

  it('deletes a secret', () => {
    const vault = freshVault();
    vault.setSecret('a', '1');
    vault.deleteSecret('a');
    expect(vault.getSecret('a')).toBeNull();
    expect(vault.hasSecret('a')).toBe(false);
  });

  it('survives a tampered entry without losing the others', () => {
    const vault = freshVault();
    vault.setSecret('good', 'value');
    vault.setSecret('bad', 'value');
    const file = path.join(home, '.bubbly', 'vault.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.entries.bad.data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(file, JSON.stringify(parsed));

    const reopened = freshVault();
    expect(reopened.getSecret('bad')).toBeNull();
    expect(reopened.getSecret('good')).toBe('value');
  });

  it('keeps existing secrets when a passphrase is added', () => {
    const vault = freshVault();
    vault.setSecret('token', 'keep-me');
    vault.setPassphrase('correct horse battery');
    expect(vault.getSecret('token')).toBe('keep-me');
    expect(vault.backend()).toBe('passphrase');
  });

  it('refuses the wrong passphrase and accepts the right one', () => {
    const vault = freshVault();
    vault.setSecret('token', 'keep-me');
    vault.setPassphrase('correct horse battery');
    vault.lock();
    expect(vault.unlock('wrong')).toBe(false);
    expect(vault.unlock('correct horse battery')).toBe(true);
    expect(vault.getSecret('token')).toBe('keep-me');
  });
});
