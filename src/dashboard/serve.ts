/**
 * @fileoverview Serves the metrics dashboard locally, live from the ledger.
 *
 * Read-only: the ledger is opened read-only per request and nothing is written anywhere.
 * Local-only via the same rule as the gate's other servers (listenOnThisComputer).
 *
 * Usage:
 *   pnpm run dashboard [-- --port 8790]
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { isLocalRequest, listenOnThisComputer } from '../utils/local-only.js';
import { loadDashboardData } from './data.js';

const PAGE_PATH = path.join(CONFIG.ROOT_DIR, 'src', 'dashboard', 'index.html');

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!isLocalRequest(req.headers)) {
    res.writeHead(403).end('local requests only');
    return;
  }
  const url = (req.url ?? '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(PAGE_PATH));
    } else if (url === '/data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(loadDashboardData()));
    } else {
      res.writeHead(404).end('not found');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(
      /(ENOENT|does not exist)/i.test(message)
        ? `No ledger at ${CONFIG.LEDGER_PATH} yet — it is created when the gate handles its first request.`
        : message);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8790;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port takes a port number.');
    process.exit(1);
  }
  await listenOnThisComputer({
    handler,
    port,
    onListening: () => {
      console.log(`SLM Gate metrics dashboard: http://localhost:${port}`);
      console.log(`Reading ${CONFIG.LEDGER_PATH} (read-only, computed fresh on every reload). Ctrl-C to stop.`);
    },
  });
}

if (isEntryPoint(import.meta.url)) {
  main().catch(err => {
    console.error('dashboard failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
