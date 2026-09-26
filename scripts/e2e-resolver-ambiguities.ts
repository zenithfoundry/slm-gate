/**
 * @fileoverview
 * End-to-End Test: Resolver Ambiguities (`e2e:resolver-ambiguities`)
 * 
 * Expected Outcome:
 * The test spins up `mcp-gate` while overriding the `OLLAMA_HOST` variable to point to a 
 * mock local HTTP server. It sends an ambiguous prompt to `condition_prompt`. 
 * The mock server returns a JSON structure simulating an SLM identifying an ambiguity 
 * that requires user input. The test verifies that `mcp-gate` correctly appends the 
 * "Pending Clarifications (Ask User)" section to the conditioned output text.
 * 
 * Why this test is needed (Why it exists):
 * This test guarantees the functionality of the ambiguity resolver feature. When the 
 * local SLM identifies a destructive or unresolvable question in the user's prompt, 
 * it must safely flag it as an `askUser` item. The `mcp-gate` must then gracefully 
 * format this data as text appended to the result, ensuring the downstream cloud model 
 * or the client can present the clarification to the human.
 * 
 * Warning Expectations / Potential Flakiness:
 * - Does NOT require Ollama running (mocks the Ollama API).
 * - Runs a mock server on a dynamic port to avoid collisions.
 * - Generally stable since there's no actual LLM generation happening, but depends 
 *   on the strict JSON schema matching the resolver output structure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, '..');

async function main() {
  console.log("Starting Resolver Ambiguities Test...");

  // Mock Ollama API Server
  const mockOllama = http.createServer((req, res) => {
    console.log(`[mockOllama] Incoming request: ${req.url}`);
    // The MCP server's start-up check lists the models; answering it keeps a "model not downloaded"
    // desktop notification from appearing during the test.
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      console.log(`[mockOllama] Body: ${body.slice(0, 100)}`);
      try {
        const parsed = JSON.parse(body || '{}');
        const prompt = String(parsed.prompt || (parsed.messages && parsed.messages[0]?.content) || '');
        console.log(`[mockOllama] Prompt: ${prompt.slice(0, 50)}`);
      
      // Determine if it's the Distill prompt or the Resolver prompt
      if (prompt.includes('extract_verbatim') || prompt.includes('Distill') || prompt.includes('compress')) {
         res.end(JSON.stringify({
            model: "mock-model",
            message: { role: "assistant", content: JSON.stringify({ distilledText: "Condensed text here." }) },
            response: JSON.stringify({ distilledText: "Condensed text here." }),
            done: true
         }) + '\n');
      } else if (prompt.includes('Extract concrete open decisions')) {
         const out = {
            decisions: [{ id: "q1", question: "Did you mean production or staging?", kind: "clarification" }]
         };
         res.end(JSON.stringify({
            model: "mock-model", message: { role: "assistant", content: JSON.stringify(out) }, response: JSON.stringify(out), done: true
         }) + '\n');
      } else if (prompt.includes('What file paths or contents should we grep')) {
         const out = { patterns: [] };
         res.end(JSON.stringify({
            model: "mock-model", message: { role: "assistant", content: JSON.stringify(out) }, response: JSON.stringify(out), done: true
         }) + '\n');
      } else if (prompt.includes('Based on standard software conventions')) {
         const out = { answer: "staging", options: ["production", "staging"] };
         res.end(JSON.stringify({
            model: "mock-model", message: { role: "assistant", content: JSON.stringify(out) }, response: JSON.stringify(out), done: true
         }) + '\n');
      } else if (prompt.includes('Classify the risk')) {
         const out = { risk: "destructive" }; // Forces it to askUser
         res.end(JSON.stringify({
            model: "mock-model", message: { role: "assistant", content: JSON.stringify(out) }, response: JSON.stringify(out), done: true
         }) + '\n');
      } else {
         res.end(JSON.stringify({
            model: "mock-model", message: { role: "assistant", content: "{}" }, response: "{}", done: true
         }) + '\n');
      }
      } catch (err) {
        console.error('[mockOllama] Error:', err);
        res.end(JSON.stringify({ error: 'mock Ollama could not handle the request' }));
      }
    });
  });

  await new Promise<void>(resolve => mockOllama.listen(0, '127.0.0.1', resolve));
  const ollamaPort = (mockOllama.address() as any).port;
  console.log(`Mock Ollama server listening on port ${ollamaPort}`);

  const mcpGatePath = path.join(rootPath, 'src', 'mcp-gate', 'index.ts');
  
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', mcpGatePath],
    env: {
      ...process.env,
      DOWNSTREAM_MCP: '', // Standalone mode
      LLM_GATE_AUTOSTART: 'off', // never start the real model gate from a test
      OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
      SLM_BRAIN_MODEL: 'mock-model',
      SLM_GATE_MODEL: 'mock-model'
    }
  });

  transport.onerror = (err) => console.error('[transport-error]', err);

  const client = new Client(
    { name: "e2e-resolver-ambiguities", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("Connected to mcp-gate.");

  const ambiguousSkill = `
# Deploy Script
Deploy the app to the server. Timestamp: ${Date.now()}
`;

  console.log("Calling condition_prompt to trigger ambiguity resolver...");
  try {
    const result = await client.request({
      method: "tools/call",
      params: {
        name: "condition_prompt",
        arguments: {
          text: ambiguousSkill,
          task: "Deploy to server " + Date.now()
        }
      }
    }, CallToolResultSchema);

    const conditionedText = String((result.content[0] as any).text);
    
    if (conditionedText.includes('Pending Clarifications (Ask User)') && conditionedText.includes('Did you mean production or staging?')) {
       console.log("PASS: Ambiguities correctly appended to the text.");
    } else {
       console.error("FAIL: Ambiguities missing from text. Output:\n", conditionedText);
       process.exitCode = 1;
    }

  } catch (err) {
    console.error("FAIL: Tool call failed unexpectedly", err);
    process.exitCode = 1;
  } finally {
    mockOllama.close();
    if (process.exitCode !== 1) {
        process.exit(0);
    } else {
        process.exit(1);
    }
  }
}

main();
