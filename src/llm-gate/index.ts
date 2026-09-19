import { requestListener, server } from './server.js';
import { listenOnThisComputer } from '../utils/local-only.js';
import { CONFIG } from '../config.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { getDb, logLedgerInfo } from '../ledger/index.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { warmUpLocalModel } from './distill.js';
import { warmUpAnsweringModel } from './local-first.js';

// Ledger writes are synchronous. With better-sqlite3's default 5 s busy wait, another process
// holding the ledger's write lock would freeze every stream through the gate. Wait briefly instead;
// a row that still cannot be written is logged and dropped (see recordRequest in server.ts).
const LEDGER_BUSY_TIMEOUT_MS = 100;

/**
 * Entry point for the `llm-gate` layer.
 * 
 * Can be imported as a module (`export { server }`) for integration testing,
 * or executed directly via CLI to boot the standalone HTTP proxy server.
 */

if (isEntryPoint(import.meta.url)) {
  const sinks = ['sqlite'];
  if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
    sinks.push('langfuse');
  }

  logLedgerInfo('llm-gate');
  getDb().pragma(`busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  if (CONFIG.LLM_GATE_DISTILL) warmUpLocalModel();
  if (CONFIG.LLM_GATE_LOCAL_FIRST) warmUpAnsweringModel();
  listenOnThisComputer({
    handler: requestListener,
    port: CONFIG.LLM_GATE_PORT,
    onListening: () => console.error(`LLM Gate running on port ${CONFIG.LLM_GATE_PORT}, for programs on this computer only (pass-through: anthropic, chat-completions, responses, gemini). sinks: [${sinks.join(', ')}]`),
  }).catch(err => {
    console.error(`LLM Gate could not listen on port ${CONFIG.LLM_GATE_PORT}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  installLangfuseFlushLifecycle('llm-gate');
}

export { server };
