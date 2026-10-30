import type http from 'node:http';
import { CONFIG } from '../config.js';
import { createServer } from './server.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { logLedgerInfo } from '../ledger/index.js';
import { log } from '../log.js';
import { exitWithParent } from '../setup/parent-watch.js';
import { runStartupChecks, watchModelGate } from '../setup/startup.js';
import { installShutdown } from '../shutdown.js';

/**
 * Leave nothing running that no coding tool owns. Registered before any work that could hang, so a
 * toolbox that never finishes connecting cannot strand a server either.
 */
function shutDownWhenNobodyOwnsUs(): void {
  const quit = () => process.kill(process.pid, 'SIGTERM');
  if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
    // Our input closing means the coding tool is gone (closed or crashed). Whichever of these arrives
    // first wins; SIGTERM is idempotent here, and stdin is deliberately not resumed, because reading
    // it ourselves would swallow the handshake the transport is about to read.
    process.stdin.once('end', quit);
    process.stdin.once('close', quit);
    process.stdin.on('error', quit);
  }
  // The backstop: this arrives even when start-up hangs before anything reads stdin, and it is the
  // only signal at all when the transport is HTTP.
  exitWithParent();
}

async function main() {
  if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
    console.log = console.error;
  }
  shutDownWhenNobodyOwnsUs();

  log.info('mcp-gate', 'Starting up', {
    mode: CONFIG.DOWNSTREAM_MCP ? 'proxy' : 'standalone',
    transport: CONFIG.MCP_GATE_TRANSPORT,
    brain: CONFIG.SLM_BRAIN_MODEL,
    gate: CONFIG.SLM_GATE_MODEL,
  });
  logLedgerInfo('mcp-gate');

  const langfuse = installLangfuseFlushLifecycle('mcp-gate');
  // SIGTERM/SIGINT (also what the owner watch above sends): in HTTP mode stop listening; a tool call in
  // flight completes either way; then flush, close the ledger, exit.
  let listening: http.Server[] = [];
  installShutdown({
    scope: 'mcp-gate',
    stopAccepting: () => { for (const s of listening) { s.close(); s.closeIdleConnections(); } },
    drainLangfuse: langfuse.drainForShutdown,
  });

  // A coding tool starting this server is the sign that work is about to start: check Ollama and the
  // configured models and make sure the model gate runs (launched in the background if it does not).
  // At most ~1.5 s; problems reach the AI through the instructions and you through a notification.
  let notices: Awaited<ReturnType<typeof runStartupChecks>> = [];
  try {
    notices = await runStartupChecks();
  } catch (err) {
    log.error('mcp-gate', 'Start-up checks failed (continuing)', { error: err });
  }

  try {
    const { start } = await createServer({ notices });
    listening = await start();
    log.info('mcp-gate', 'Server is running and listening for messages.');
    watchModelGate();
  } catch (err) {
    log.error('mcp-gate', 'Fatal error during startup', { error: err });
    process.exit(1);
  }
}

main();
