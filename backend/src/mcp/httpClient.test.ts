import { extractJsonRpcFromSse } from './client';

describe('extractJsonRpcFromSse', () => {
  it('extracts a single JSON-RPC message from an SSE body', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const msg = extractJsonRpcFromSse(body, 1) as any;
    expect(msg.id).toBe(1);
    expect(msg.result.tools).toEqual([]);
  });

  it('matches the message with the requested id among several events', () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
    const msg = extractJsonRpcFromSse(body, 2) as any;
    expect(msg.id).toBe(2);
    expect(msg.result.b).toBe(2);
  });

  it('handles data split across multiple data: lines', () => {
    const body = 'data: {"jsonrpc":"2.0","id":5,\ndata: "result":{"ok":true}}\n\n';
    const msg = extractJsonRpcFromSse(body, 5) as any;
    expect(msg.result.ok).toBe(true);
  });

  it('falls back to the last payload when no id matches', () => {
    const body = 'data: {"jsonrpc":"2.0","id":9,"result":{"last":true}}\n\n';
    const msg = extractJsonRpcFromSse(body, 1) as any;
    expect(msg.result.last).toBe(true);
  });

  it('returns null for an empty / dataless body', () => {
    expect(extractJsonRpcFromSse('', 1)).toBeNull();
    expect(extractJsonRpcFromSse('event: ping\n\n', 1)).toBeNull();
  });
});
