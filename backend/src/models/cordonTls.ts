import { readFileSync } from 'fs';
import { Agent } from 'undici';

/**
 * Bubbly's mutual-TLS identity for a Cordon node.
 *
 * A Light-mode node identifies Bubbly by the `x-client-id` header. Every other
 * Cordon mode identifies clients by certificate, so Bubbly presents the one the
 * node's `cordon pki` issued it:
 *
 *   CORDON_CLIENT_CERT=/etc/bubbly/cordon/bubbly.crt
 *   CORDON_CLIENT_KEY=/etc/bubbly/cordon/bubbly.key
 *   CORDON_CA_CERT=/etc/bubbly/cordon/ca.crt      # trusts the node's certificate
 *
 * These are files on the machine running Bubbly, so they come from the
 * environment rather than the Settings page. Returns undefined for a plain
 * HTTP node or when nothing is configured, and fetch then uses its default.
 */
let cached: { id: string; agent: Agent } | undefined;

export function cordonDispatcher(url: string, env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const cert = env.CORDON_CLIENT_CERT?.trim();
  const key = env.CORDON_CLIENT_KEY?.trim();
  const ca = env.CORDON_CA_CERT?.trim();
  if (!url.startsWith('https://') || (!cert && !ca)) return undefined;

  const id = [cert, key, ca].join('|');
  if (cached?.id === id) return cached.agent;

  const read = (what: string, path?: string) => {
    if (!path) return undefined;
    try {
      return readFileSync(path);
    } catch (err) {
      throw new Error(`Cordon: cannot read the ${what} ${path}: ${(err as Error).message}`);
    }
  };
  const agent = new Agent({
    connect: {
      cert: read('client certificate', cert),
      key: read('client key', key),
      ca: read('CA certificate', ca),
    },
  });
  cached = { id, agent };
  return agent;
}
