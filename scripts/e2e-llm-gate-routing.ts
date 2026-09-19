/**
 * @fileoverview
 * End-to-End Test: LLM Gate Routing (`e2e:llm-gate-routing`)
 *
 * Expected Outcome:
 * The test spins up a mock upstream and the real `llm-gate` process, with the OpenAI upstream
 * overridden to point at the mock (UPSTREAM_OPENAI_URL). It sends an OpenAI Chat Completions request
 * with the tool's own `Authorization` header and verifies that the mock received exactly that body and
 * that header on `/v1/chat/completions`, and that the mock's reply reached the client unchanged.
 *
 * Why this test is needed (Why it exists):
 * The gate forwards every request with the tool's own login to the provider its format belongs to.
 * This proves the spawned process routes a request and passes it through without translating the
 * body or swapping the credential, as a coding tool would see it.
 *
 * Warning Expectations / Potential Flakiness:
 * - Does NOT require Ollama or any real provider.
 * - Runs on dynamic ports to prevent collisions.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, '..');

const REPLY = JSON.stringify({
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  model: 'gpt-5.6-sol',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Mock upstream response' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  console.log('Starting LLM Gate Routing Test...');

  let received: { url?: string; authorization?: string; body: string } | null = null;
  const mockUpstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log(`[mockUpstream] received request: ${req.url}`);
      received = { url: req.url, authorization: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(REPLY);
    });
  });
  await new Promise<void>(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (mockUpstream.address() as AddressInfo).port;
  console.log(`Mock upstream listening on port ${upstreamPort}`);

  const llmGatePort = await freePort();
  const llmGate = spawn('npx', ['tsx', path.join(rootPath, 'src', 'llm-gate', 'index.ts')], {
    env: {
      ...process.env,
      LLM_GATE_PORT: String(llmGatePort),
      UPSTREAM_OPENAI_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      // This test is about routing; its first request ("Say hello!") must not be answered locally.
      LLM_GATE_LOCAL_FIRST: 'false',
      // Keep test rows out of the real ledger and away from Langfuse.
      LEDGER_PATH: path.join(os.tmpdir(), `slm-gate-e2e-routing-${process.pid}.sqlite`),
      LANGFUSE_PUBLIC_KEY: '',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_HOST: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stopAll = () => {
    mockUpstream.close();
    llmGate.kill();
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopAll();
      reject(new Error('llm-gate boot timeout'));
    }, 10000);
    llmGate.stdout.on('data', d => console.log('[llm-gate stdout]', d.toString().trim()));
    llmGate.stderr.on('data', data => {
      console.log('[llm-gate stderr]', data.toString().trim());
      if (data.toString().includes('LLM Gate running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  console.log(`LLM Gate started on port ${llmGatePort}. Sending request...`);
  const requestBody = JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'Say hello!' }] });
  const response = await fetch(`http://127.0.0.1:${llmGatePort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer tool-own-key' },
    body: requestBody
  });
  const replyText = await response.text();

  const failures: string[] = [];
  if (response.status !== 200) failures.push(`status ${response.status}`);
  if (replyText !== REPLY) failures.push('reply was changed on the way back');
  if (!received) {
    failures.push('mock upstream received nothing');
  } else {
    const got = received as { url?: string; authorization?: string; body: string };
    if (got.url !== '/v1/chat/completions') failures.push(`upstream path was ${got.url}`);
    if (got.authorization !== 'Bearer tool-own-key') failures.push('the tool\'s Authorization header was not forwarded unchanged');
    if (got.body !== requestBody) failures.push('request body was changed on the way out');
  }

  stopAll();
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('PASS: request and reply passed through unchanged with the tool\'s own Authorization header');
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
