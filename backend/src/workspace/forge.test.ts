import { getPullRequest } from './forge';

jest.mock('../secrets/credentialSources', () => ({
  findForgeToken: () => ({ token: 'test-token', source: 'test' }),
}));

describe('forge pull request files', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('uses the paginated GitLab diffs endpoint', async () => {
    const urls: string[] = [];
    global.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.toString());

      if (url.pathname.endsWith('/diffs')) {
        const page = Number(url.searchParams.get('page'));
        const count = page === 1 ? 100 : 1;
        return new Response(JSON.stringify(Array.from({ length: count }, (_, i) => ({
          new_path: `src/file-${page}-${i}.ts`,
          old_path: `src/file-${page}-${i}.ts`,
          new_file: page === 2,
        }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        iid: 42,
        title: 'Improve integration',
        state: 'opened',
        author: { username: 'dev' },
        source_branch: 'feature',
        target_branch: 'main',
        web_url: 'https://gitlab.example/group/project/-/merge_requests/42',
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const pr = await getPullRequest({
      forge: 'gitlab', host: 'gitlab.example', owner: 'group', repo: 'project',
    }, 42);

    expect(pr.changedFiles).toHaveLength(101);
    expect(pr.changedFiles?.[100]).toMatchObject({ status: 'added' });
    expect(urls.filter((url) => url.includes('/diffs'))).toHaveLength(2);
    expect(urls.some((url) => url.includes('/changes'))).toBe(false);
  });
});
