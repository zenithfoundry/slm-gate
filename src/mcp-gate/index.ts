import { CONFIG } from '../config.js';
import { createServer } from './server.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { logLedgerInfo } from '../ledger/index.js';
import { runStartupChecks, watchModelGate } from '../setup/startup.js';

async function main() {
  if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
    console.log = console.error;
  }

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
    if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
      // The coding tool closing our input means it is gone (closed or crashed). Shut down as on SIGTERM
      // rather than linger as an orphan that keeps watching the model gate and showing notifications.
      process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
    }
    watchModelGate();
  } catch (err) {
    console.error(`[mcp-gate] Fatal error during startup:`, err);
    process.exit(1);
  }
}

main();
