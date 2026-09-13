/**
 * Jest global setup: isolate every test run from the real ledger.
 *
 * Several suites call `DELETE FROM events` against `CONFIG.LEDGER_PATH` to get a clean
 * table (tests/ledger/elision.test.ts, tests/llm-gate/outcome.test.ts). Without this file
 * that path is the developer's production ledger, so running the suite silently destroys
 * real telemetry and replaces it with synthetic fixtures.
 *
 * This runs before any module is imported, and `config.ts` reads `process.env` at import
 * time while dotenv never overrides an already-set variable — so setting it here wins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-test-'));

// JEST_WORKER_ID keeps parallel workers off each other's database.
process.env.LEDGER_PATH = path.join(dir, `ledger-${process.env.JEST_WORKER_ID ?? '0'}.sqlite`);

// Never let a test run ship to a real Langfuse project.
process.env.LANGFUSE_PUBLIC_KEY = '';
process.env.LANGFUSE_SECRET_KEY = '';
process.env.LANGFUSE_HOST = '';
process.env.LANGFUSE_ENVIRONMENT = 'test';
