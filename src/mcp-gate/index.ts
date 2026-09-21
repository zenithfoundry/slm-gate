import { CONFIG } from '../config.js';
import { createServer } from './server.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { logLedgerInfo } from '../ledger/index.js';
import { exitWithParent } from '../setup/parent-watch.js';
import { runStartupChecks, watchModelGate } from '../setup/startup.js';

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

  console.error(`[mcp-gate] Starting up...`);
  console.error(`[mcp-gate] Mode: ${CONFIG.DOWNSTREAM_MCP ? 'Proxy' : 'Standalone'}`);
  console.error(`[mcp-gate] Transport: ${CONFIG.MCP_GATE_TRANSPORT}`);
  console.error(`[mcp-gate] Models -> Brain: ${CONFIG.SLM_BRAIN_MODEL} | Gate: ${CONFIG.SLM_GATE_MODEL}`);
  logLedgerInfo('mcp-gate');

  installLangfuseFlushLifecycle('mcp-gate');

  // A coding tool starting this server is the sign that work is about to start: check Ollama and the
  // configured models and make sure the model gate runs (launched in the background if it does not).
  // At most ~1.5 s; problems reach the AI through the instructions and you through a notification.
  let notices: Awaited<ReturnType<typeof runStartupChecks>> = [];
  try {
    notices = await runStartupChecks();
  } catch (err) {
    console.error(`[mcp-gate] Start-up checks failed (continuing):`, err);
  }

  try {
    const { start } = await createServer({ notices });
    await start();
    console.error(`[mcp-gate] Server is running and listening for messages.`);
    watchModelGate();
  } catch (err) {
    console.error(`[mcp-gate] Fatal error during startup:`, err);
    process.exit(1);
  }
}

main();
