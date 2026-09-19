/**
 * @fileoverview "Only programs on this computer": the one rule both slm-gate HTTP servers apply (the model
 * gate on LLM_GATE_PORT and the MCP server's HTTP mode on MCP_GATE_PORT). Kept in one place because it is a
 * security rule and two copies could drift.
 *
 * Two parts, because binding alone is not enough:
 * - Listen on the loopback addresses only, so other machines on the network cannot connect.
 * - Refuse requests addressed to another name (Host) or sent by a web page from another site (Origin).
 *   A page open in the browser runs on this computer too: through DNS rebinding it can reach 127.0.0.1
 *   under its own domain name, and any page can send cross-site requests to localhost.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';

/** Names for this computer. Other spellings (`localhost.`, `127.1`, …) are refused: fail closed. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** A Host header's name without the port or IPv6 brackets, e.g. `[::1]:8787` → `::1`. */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false; // includes the literal `null` sent by sandboxed pages and file:// documents
  }
}

/**
 * True for a request addressed to this computer by name, and either sent by a program (no Origin) or by a
 * web page served from this computer. Coding tools' model clients send no Origin.
 */
export function isLocalRequest(headers: http.IncomingHttpHeaders): boolean {
  if (!headers.host || !LOCAL_HOSTNAMES.has(hostnameOf(headers.host))) return false;
  return headers.origin === undefined || isLocalOrigin(headers.origin);
}

function listenOn(params: { server: http.Server; host: string; port: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    params.server.once('error', reject);
    params.server.listen({ host: params.host, port: params.port, ipv6Only: params.host === '::1' }, () => {
      params.server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Serves `handler` on 127.0.0.1 and ::1, so `localhost` works whichever address a client's resolver picks
 * first (macOS answers ::1 first, and not every client falls back).
 *
 * @param params.port The port (0 picks a free one, the same for both addresses)
 * @param params.onListening Called once both addresses listen
 * @returns The listening servers (to close them)
 * @throws When 127.0.0.1 cannot be used (e.g. the port is taken), or ::1 fails for any reason other than
 *   IPv6 being unavailable; nothing is left listening then
 */
export async function listenOnThisComputer(params: {
  handler: http.RequestListener;
  port: number;
  onListening?: () => void;
}): Promise<http.Server[]> {
  const ipv4 = http.createServer(params.handler);
  await listenOn({ server: ipv4, host: '127.0.0.1', port: params.port });
  const port = (ipv4.address() as AddressInfo).port;

  const ipv6 = http.createServer(params.handler);
  try {
    await listenOn({ server: ipv6, host: '::1', port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
      // E.g. another program holds [::1]:port: `localhost` clients would reach it, not us.
      await new Promise(resolve => ipv4.close(resolve));
      throw err;
    }
    console.error(`[slm-gate] IPv6 is not available on this computer; listening on 127.0.0.1:${port} only.`);
    params.onListening?.();
    return [ipv4];
  }
  params.onListening?.();
  return [ipv4, ipv6];
}
