import { normalizeMcpConfigs } from './manager';

describe('normalizeMcpConfigs', () => {
  it('parses the Claude/Cursor mcpServers object form', () => {
    const raw = JSON.stringify({
      mcpServers: {
        'aws-docs': { command: 'uvx', args: ['awslabs.aws-documentation-mcp-server@latest'], env: { FASTMCP_LOG_LEVEL: 'ERROR' }, disabled: false, autoApprove: [] },
        'github': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], disabled: true },
      },
    });
    const out = normalizeMcpConfigs(raw);
    expect(out).toHaveLength(2);
    const aws = out.find((s) => s.name === 'aws-docs')!;
    expect(aws.transport).toBe('stdio');
    expect(aws.command).toBe('uvx');
    expect(aws.args).toEqual(['awslabs.aws-documentation-mcp-server@latest']);
    expect(aws.env).toEqual({ FASTMCP_LOG_LEVEL: 'ERROR' });
    expect(aws.enabled).toBe(true);
    const gh = out.find((s) => s.name === 'github')!;
    expect(gh.enabled).toBe(false); // disabled:true
  });

  it('parses the VS Code servers form with type + url (remote → sse)', () => {
    const raw = JSON.stringify({
      servers: {
        remote: { type: 'sse', url: 'https://example.com/mcp' },
        local: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
    });
    const out = normalizeMcpConfigs(raw);
    const remote = out.find((s) => s.name === 'remote')!;
    expect(remote.transport).toBe('sse');
    expect(remote.url).toBe('https://example.com/mcp');
    const local = out.find((s) => s.name === 'local')!;
    expect(local.transport).toBe('stdio');
  });

  it('still parses our native array form', () => {
    const raw = JSON.stringify([
      { id: 's1', name: 'One', transport: 'stdio', command: 'foo', enabled: true },
      { id: 's2', name: 'Two', transport: 'stdio', command: 'bar', enabled: false },
    ]);
    const out = normalizeMcpConfigs(raw);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('s1');
    expect(out[1].enabled).toBe(false);
  });

  it('parses a bare keyed object', () => {
    const raw = JSON.stringify({ myserver: { command: 'npx', args: ['x'] } });
    const out = normalizeMcpConfigs(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('myserver');
    expect(out[0].enabled).toBe(true);
  });

  it('infers sse transport from a url when type is missing', () => {
    const out = normalizeMcpConfigs(JSON.stringify({ mcpServers: { r: { url: 'https://x/mcp' } } }));
    expect(out[0].transport).toBe('sse');
  });

  it('accepts an already-parsed object (not just a string)', () => {
    const out = normalizeMcpConfigs({ mcpServers: { a: { command: 'c' } } });
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe('c');
  });

  it('returns [] for empty / invalid input without throwing', () => {
    expect(normalizeMcpConfigs('')).toEqual([]);
    expect(normalizeMcpConfigs('not json')).toEqual([]);
    expect(normalizeMcpConfigs(null)).toEqual([]);
    expect(normalizeMcpConfigs(undefined)).toEqual([]);
    expect(normalizeMcpConfigs('{}')).toEqual([]);
  });

  it('coerces non-string args/env values to strings', () => {
    const out = normalizeMcpConfigs({ mcpServers: { a: { command: 'c', args: [1, true], env: { PORT: 8080 } } } });
    expect(out[0].args).toEqual(['1', 'true']);
    expect(out[0].env).toEqual({ PORT: '8080' });
  });

  it('gives distinct ids to duplicate-named servers', () => {
    const out = normalizeMcpConfigs([
      { name: 'dup', command: 'a' },
      { name: 'dup', command: 'b' },
    ]);
    expect(out[0].id).not.toBe(out[1].id);
  });
});
