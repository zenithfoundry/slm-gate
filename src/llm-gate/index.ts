import { server } from './server.js';
import { CONFIG } from '../config.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { getDb, logLedgerInfo } from '../ledger/index.js';
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const sinks = ['sqlite'];
  if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
    sinks.push('langfuse');
  }

  logLedgerInfo('llm-gate');
  getDb().pragma(`busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
  if (CONFIG.LLM_GATE_DISTILL) warmUpLocalModel();
  if (CONFIG.LLM_GATE_LOCAL_FIRST) warmUpAnsweringModel();
  server.listen(CONFIG.LLM_GATE_PORT, () => {
    console.error(`LLM Gate running on port ${CONFIG.LLM_GATE_PORT} (pass-through: anthropic, chat-completions, responses, gemini). sinks: [${sinks.join(', ')}]`);
  });

  installLangfuseFlushLifecycle('llm-gate');
}

export { server };
