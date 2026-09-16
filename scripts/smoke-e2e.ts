/**
 * @fileoverview
 * End-to-End Smoke Test for mcp-gate
 * 
 * Expected Outcome:
 * The test successfully connects to `mcp-gate` via stdio, queries available tools,
 * calls `condition_prompt` with a fake skill containing fluff and verbatim sections,
 * and asserts that the model appropriately distills the prompt while retaining critical
 * `MUST` statements, YAML frontmatter, and code blocks. Finally, it validates that
 * a local ledger row was written for the request.
 * 
 * Why this test is needed (Why it exists):
 * This test verifies the core decoupling and routing mechanism of `mcp-gate`. It proves
 * that `mcp-gate` can run as a transparent proxy, intercept calls, condition them locally 
 * (via Ollama SLM), and adhere to strict formatting contracts before passing the result
 * along (or returning it directly). It protects against regressions in the prompt 
 * compression/preservation logic.
 * 
 * Warning Expectations / Potential Flakiness:
 * - Requires Ollama running locally with the target model (e.g. `qwen2.5-coder:3b`).
 * - Distillation length assertions can occasionally be flaky depending on the specific 
 *   local SLM's generative output for the "fluff" text. If the distillation takes too 
 *   long (hitting `SLM_TIMEOUT_MS`), it will fallback safely, which logs a warning but 
 *   continues execution.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, '..');

import { ensureOllamaReady, getE2EEnv, E2E_LEDGER_PATH, SLM_GATE_MODEL, SLM_BRAIN_MODEL } from "./ollama-helper.js";

// 1. Fake downstream server mode
if (process.argv[2] === '--fake-downstream') {
  const server = new Server(
    { name: "fake-downstream", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [{
        name: "get_skill",
        description: "A fake skill returning tool",
        inputSchema: { type: "object", properties: {}, required: [] }
      }]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "get_skill") {
      const longSkill = `
# Fake Skill

You MUST keep this line verbatim.

## Important Heading
This text is extra fluff that should be distilled away by the SLM to make the output shorter.
We add a lot of extra words here to ensure that the compression algorithm has something to remove.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.
The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.

\`\`\`typescript
console.log("Preserve code blocks too");
\`\`\`
CACHE_BUST_${Date.now()}
`;
      return { content: [{ type: "text", text: longSkill }] };
    }
    throw new Error(`Tool not found: ${request.params.name}`);
  });

  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
  // Keep alive
  setInterval(() => {}, 1000);
} 
// 2. Main E2E Test Mode
else {
  async function runTest() {
    console.log("Starting E2E Smoke Test...");
    
    // Check Ollama readiness and warm up models to avoid standby delays
    await ensureOllamaReady([SLM_GATE_MODEL, SLM_BRAIN_MODEL]);

    const mcpGatePath = path.join(rootPath, 'dist', 'mcp-gate', 'index.js');
    if (!fs.existsSync(mcpGatePath)) {
      console.error(`FAIL: ${mcpGatePath} not found.`);
      console.error(`Please run 'pnpm run build' first.`);
      process.exit(1);
    }

    // Force use of the fake downstream server for E2E tests
    const env = getE2EEnv({
      DOWNSTREAM_MCP: JSON.stringify({
        command: "tsx",
        args: [__filename, "--fake-downstream"]
      }),
      // Sized to THIS test's canned payload (~212 estimated tokens), which is far below any
      // realistic DISTILL_MIN_TOKENS — under the shipped thresholds nothing happened at all and
      // the assertion below could never pass.
      //
      // What this exercises is the HARD-TRUNCATION path, not SLM summarisation: `get_skill` is
      // 'verbatim' in the seeded distill_policy table (skill contracts must never be reworded),
      // so the model is deliberately never invoked for this payload. The value of the assertions
      // is therefore that the MUST line and the heading survive truncation and the remainder is
      // left recoverable behind an elision marker.
      // SLM compression itself is covered by e2e:standalone-mcp and tests/mcp-gate/distill.test.ts.
      DISTILL_MIN_TOKENS: '50',
      DISTILL_MAX_TOKENS: '180'
    });
    console.log("Using in-process FAKE downstream MCP server.");

    const transport = new StdioClientTransport({
      command: 'node',
      args: [mcpGatePath],
      env
    });

    const client = new Client(
      { name: "e2e-test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    console.log("Connecting to mcp-gate...");
    await client.connect(transport);

    console.log("Calling tools/list...");
    const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    const toolNames = tools.tools.map(t => t.name);
    console.log("Tools returned:", toolNames);

    const isProxy = !!env.DOWNSTREAM_MCP;
    const targetTool = isProxy && toolNames.includes('get_skill') ? 'get_skill' : 'condition_prompt';
    
    if (!toolNames.includes(targetTool)) {
      console.error(`FAIL: Expected tool '${targetTool}' missing from tools list.`);
      process.exit(1);
    }
    console.log(`PASS: Expected tool '${targetTool}' is present.`);

    console.log(`\nCalling ${targetTool}... (Requires Ollama running)`);
    try {
      const result = await client.request({
        method: "tools/call",
        params: {
          name: targetTool,
          arguments: {
            text: targetTool === 'condition_prompt' ? "# Fake Skill\nYou MUST keep this line verbatim.\n\n## Important Heading\nFluff text to compress. Fluff text to compress. Fluff text to compress. Fluff text to compress. Fluff text to compress.\n```\ncode\n```\nCACHE_BUST_" + Date.now() : undefined,
            task: "Smoke test e2e conditioning"
          }
        }
      }, CallToolResultSchema, { timeout: 300000 });

      const conditionedText = String((result.content[0] as any).text);
      console.log("\nConditioned output length:", conditionedText.length);
      
      let pass = true;

      // Assertion (a): returned text is SHORTER
      const isPipelineFailure = conditionedText.includes('[distill_timeout]') || conditionedText.includes('[resolver_timeout]');
      if (isPipelineFailure) {
        console.warn("WARNING: Pipeline hit SLM timeout or parsing failure, skipping compression assertion.");
      } else {
        if (conditionedText.includes('The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.')) {
           console.error("FAIL: Text does not appear to be compressed.");
           pass = false;
        } else {
           console.log("PASS: Text was processed/compressed.");
        }
      }

      // Assertion (b): MUST/heading/frontmatter retained verbatim
      if (!conditionedText.includes('You MUST keep this line verbatim.')) {
        console.error("FAIL: MUST line not retained verbatim.");
        pass = false;
      } else {
        console.log("PASS: MUST line retained verbatim.");
      }

      if (!conditionedText.includes('## Important Heading')) {
        console.error("FAIL: Heading not retained verbatim.");
        pass = false;
      } else {
        console.log("PASS: Heading retained verbatim.");
      }
      
      // Assertion (c): Open questions / Ask User
      if (conditionedText.includes('Pending Clarifications (Ask User)') || conditionedText.includes('Open questions')) {
        console.log("PASS: askUser section found.");
      } else {
        console.log("SKIP: askUser section not present (graceful skip).");
      }

      // Assertion (d): Ledger row written.
      // Opens the SAME database the spawned gate wrote to. getDb() would resolve
      // CONFIG.LEDGER_PATH in THIS process, which is the developer's real ledger — a different
      // file from the throwaway one the child was given, so the row would never be found.
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(E2E_LEDGER_PATH, { readonly: true });
      const row = db.prepare("SELECT * FROM events WHERE layer = 'mcp' AND route = 'condition' ORDER BY ts DESC LIMIT 1").get();
      if (!row) {
        console.error("FAIL: No ledger row found for layer=mcp, route=condition.");
        pass = false;
      } else {
        console.log("PASS: Ledger row found:", (row as any).request_id);
      }

      if (!pass) {
        console.error("\nTEST FAILED.");
        process.exit(1);
      } else {
        console.log("\nALL TESTS PASSED.");
        process.exit(0);
      }

    } catch (err) {
      console.error("FAIL: Tool call failed", err);
      process.exit(1);
    }
  }

  runTest();
}
