/**
 * Entry point of the model gate: opens the ledger with a short busy timeout, serves on this computer only,
 * warms the local model, pins the models and installs the Langfuse flush lifecycle.
 */
import type http from 'node:http';
import { requestListener, server } from './server.js';
import { listenOnThisComputer } from '../utils/local-only.js';
import { CONFIG } from '../config.js';
import { installLangfuseFlushLifecycle } from '../ledger/flush-lifecycle.js';
import { getDb, logLedgerInfo } from '../ledger/index.js';
import { log } from '../log.js';
import { installShutdown } from '../shutdown.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { warmUpLocalModel } from './distill.js';
import { startPinningModels } from '../models/pin.js';

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
  // Keep both models resident: a third model loaded by anything else evicts one of ours and every call
  // after that pays a reload. Checks now and every minute; see src/models/pin.ts.
  startPinningModels();
  const langfuse = installLangfuseFlushLifecycle('llm-gate');

  // SIGTERM/SIGINT: stop listening (a reply in flight streams to its end), then flush, close the ledger, exit.
  let listening: http.Server[] = [];
  installShutdown({
    scope: 'llm-gate',
    stopAccepting: () => { for (const s of listening) { s.close(); s.closeIdleConnections(); } },
    drainLangfuse: langfuse.drainForShutdown,
  });

  listenOnThisComputer({
    handler: requestListener,
    port: CONFIG.LLM_GATE_PORT,
    onListening: () => log.info('llm-gate', `LLM Gate running on port ${CONFIG.LLM_GATE_PORT}, for programs on this computer only (pass-through: anthropic, chat-completions, responses, gemini). sinks: [${sinks.join(', ')}]`),
  }).then(servers => {
    listening = servers;
  }).catch(err => {
    log.error('llm-gate', `LLM Gate could not listen on port ${CONFIG.LLM_GATE_PORT}`, { error: err });
    process.exit(1);
  });
}

export { server };
