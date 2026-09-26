import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * `slm-gate mcp` is the command a coding tool starts. It is started here the way a tool starts it, next to
 * the server's own entry file, against a stand-in Ollama that lists the configured model (so the start-up
 * check raises no notice), with a throwaway settings folder and without the model gate.
 */
const MODEL = 'mock-model';
let ollama: http.Server;
let home: string;
let env: Record<string, string>;

beforeAll(async () => {
  ollama = http.createServer((req, res) => {
    const tags = req.url === '/api/tags';
    res.writeHead(tags ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tags ? { models: [{ name: MODEL }] } : {}));
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-cli-mcp-'));
  env = {
    ...(process.env as Record<string, string>),
    SLM_GATE_HOME: home,
    OLLAMA_HOST: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
    SLM_GATE_MODEL: MODEL,
    SLM_BRAIN_MODEL: MODEL,
    SLM_GATE_TESTING_MODEL: MODEL,
    LLM_GATE_AUTOSTART: 'off',
    DOWNSTREAM_MCP: '',
    MCP_GATE_TRANSPORT: 'stdio',
  };
});

afterAll(async () => {
  await new Promise(resolve => ollama.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

/** Starts the server like a coding tool, lists its tools, and collects any error reading its stdout. */
async function listTools(script: string[]): Promise<{ names: string[]; errors: Error[] }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', ...script], env, stderr: 'ignore' });
  const client = new Client({ name: 'cli-mcp-test', version: '1.0.0' });
  const errors: Error[] = [];
  client.onerror = err => errors.push(err);
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return { names: tools.map(tool => tool.name).sort(), errors };
  } finally {
    await client.close();
  }
}

describe('slm-gate mcp', () => {
  it('serves the same tools as the MCP server started directly, with nothing but protocol messages on stdout', async () => {
    const viaCli = await listTools(['src/cli.ts', 'mcp']);
    const direct = await listTools(['src/mcp-gate/index.ts']);
    // No toolbox connected (DOWNSTREAM_MCP blank), so the standalone tool.
    expect(viaCli.names).toContain('condition_prompt');
    expect(viaCli.names).toEqual(direct.names);
    expect(viaCli.errors).toEqual([]);
  }, 60_000);
});
