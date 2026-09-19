/**
 * Preflight Check (Doctor) Script
 * 
 * Why it is written this way:
 * 1. Fail-Fast Diagnostics: Instead of crashing deep within the application logic when a required
 *    resource is missing (e.g., Ollama is down, port is bound), the `doctor` command acts as a 
 *    proactive health-check.
 * 2. Actionable Feedback: Every check strictly reports a human-readable success/failure message 
 *    alongside an actionable `Fix` instruction.
 * 3. Graceful Network Tolerance: It uses non-throwing network checks (catching fetch/net errors)
 *    so the diagnostic tool itself doesn't crash if the environment is heavily misconfigured.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { CONFIG } from './config.js';
import { detectHardware, recommendPreset, recommendNumCtx, getPresetRank, ramPresets } from './hardware.js';
import { getModelsFootprint } from './models/footprint.js';
import { getProviderRegistry } from './pricing/providers.js';
import { checkLocalModels } from './setup/local-models.js';
import { cliCommand, GATE_LOG_FILE, isStoppedByUser, portOwner, probeGate } from './setup/model-gate.js';
import { toolSettings, UNROUTABLE_TOOLS } from './setup/tool-settings.js';

/**
 * Checks if a given network port is available on the local machine.
 * 
 * It works by attempting to start a temporary TCP server on the port. If it succeeds, the port is free.
 * If it throws an EADDRINUSE error, the port is taken.
 * 
 * @param port - The network port number to check (e.g., 8787).
 * @returns A promise resolving to true if the port is free, false otherwise.
 * 
 * @example
 * const isFree = await checkPortFree(8080);
 * if (!isFree) console.error('Port 8080 is already in use!');
 */
async function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false); // Other errors also mean it's not simply "free"
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * Main execution flow for the doctor command.
 * Sequentially tests critical dependencies: Hardware capabilities, Node version, Environment vars, Ollama and
 * the configured local models, Downstream MCP config, Ledger write-permissions, and the model gate (running,
 * or what holds its port). Then prints the setting that points each coding tool at the gate.
 * 
 * This function will force a process.exit(1) if any issues are detected, preventing the application
 * from starting in a broken state.
 * 
 * @example
 * // Usually invoked via CLI
 * // $ node dist/cli.js doctor
 * run().catch(err => console.error(err));
 */
async function run() {
  console.log('=== SMALL-LANGUAGE-MODEL-GATE DOCTOR ===\n');
  let issues = 0;

  /**
   * Helper to format and track the result of a single check.
   */
  function report(success: boolean, msg: string, fix?: string) {
    if (success) {
      console.log(`✓ ${msg}`);
    } else {
      console.log(`✗ ${msg}`);
      if (fix) console.log(`  Fix: ${fix}`);
      issues++;
    }
  }

  // 0. Hardware Check
  const hw = detectHardware();
  report(true, `Hardware: ${hw.totalRamGB}GB RAM, ${hw.arch}, ${hw.accelerator} accelerator${hw.unifiedMemory ? ' (Unified Memory)' : ''}`);

  const recPreset = recommendPreset(hw.totalRamGB);
  const recNumCtx = recommendNumCtx(hw.totalRamGB);
  report(true, `Recommended settings: RAM_PRESET=${recPreset}, NUM_CTX=${recNumCtx}`);

  // Compare the user's specifically configured models against the defaults for their preset
  // This highlights potential mismatches where a user expects the performance of a preset but has overridden the models
  const defaultModelsForPreset = ramPresets[CONFIG.RAM_PRESET] || ramPresets['custom'];
  if (CONFIG.SLM_BRAIN_MODEL !== defaultModelsForPreset.brain || CONFIG.SLM_GATE_MODEL !== defaultModelsForPreset.gate) {
    console.log(`  Note: Configured models (${CONFIG.SLM_BRAIN_MODEL} + ${CONFIG.SLM_GATE_MODEL}) differ from preset defaults (${defaultModelsForPreset.brain} + ${defaultModelsForPreset.gate})`);
  }

  let memoryWarning = false;
  const recRank = getPresetRank(recPreset);
  const curRank = getPresetRank(CONFIG.RAM_PRESET);

  if (recRank < curRank) {
    memoryWarning = true;
  }
  
  if (!memoryWarning && CONFIG.SLM_PROVIDER === 'ollama') {
    try {
      const footprint = await getModelsFootprint([CONFIG.SLM_BRAIN_MODEL, CONFIG.SLM_GATE_MODEL]);
      const totalBytes = Object.values(footprint).reduce((a, b) => a + b, 0);
      let totalGB = totalBytes / (1024 * 1024 * 1024);
      
      // If footprint is 0 (Ollama down or models not pulled yet), estimate sizes from the model name's parameter count
      if (totalGB === 0) {
        // Heuristic: ~0.7GB per billion parameters (typical for 4-bit/5-bit quants)
        const est = (m: string) => { const match = m.match(/(\d+(?:\.\d+)?)b/i); return match ? parseFloat(match[1]) * 0.7 : 0; };
        totalGB = est(CONFIG.SLM_BRAIN_MODEL) + est(CONFIG.SLM_GATE_MODEL);
      }

      // Warn if the combined model sizes exceed 70% of total physical RAM
      if (totalGB > hw.totalRamGB * 0.7) {
        memoryWarning = true;
      }
    } catch {
      // ignore
    }
  }

  // If a memory constraint is detected, actively intervene by writing a known-safe fallback configuration
  // The system or user can then choose to load this fallback instead of crashing
  if (memoryWarning) {
    const fallbackConfig = {
      RAM_PRESET: recPreset,
      SLM_BRAIN_MODEL: ramPresets[recPreset].brain,
      SLM_GATE_MODEL: ramPresets[recPreset].gate,
      NUM_CTX: recNumCtx
    };
    const fallbackPath = path.join(CONFIG.ROOT_DIR, '.slm-gate-fallback.json');
    fs.writeFileSync(fallbackPath, JSON.stringify(fallbackConfig, null, 2));
    
    report(false, `Memory constraint: Current models/preset likely exceed available memory (eviction/thrash risk).`, `A safe fallback config was written to .slm-gate-fallback.json`);
  }

  // 1. Node version check
  // Node 22 is the floor set by package.json `engines`: better-sqlite3 >= 13 (N-API prebuilds)
  // requires it, and it is the oldest release still receiving prebuilt binaries.
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  report(nodeMajor >= 22, `Node version ≥ 22 (found v${process.versions.node})`, 'Upgrade Node.js to v22 or later.');

  // 2. .env presence and CONFIG parsing
  // Validates that the configuration template has been implemented by the user.
  const envPath = path.join(CONFIG.ROOT_DIR, '.env');
  const envExists = fs.existsSync(envPath);
  report(envExists, '.env file is present', 'Copy .env.example to .env and configure it.');
  report(true, 'Configuration parses successfully'); // If we reached here without throwing, CONFIG parsed correctly.

  // 3. Ollama and the local models the settings name (the same check the MCP server runs at start-up).
  if (CONFIG.SLM_PROVIDER === 'ollama') {
    const models = await checkLocalModels();
    for (const problem of models.problems) report(false, problem.message, problem.fix);
    if (models.problems.length === 0) {
      report(true, `Ollama is running at ${CONFIG.OLLAMA_HOST} and has every local model the settings name`);
    }
  } else {
    report(true, `SLM_PROVIDER is openai; assuming SLM endpoint is reachable.`);
  }

  // No cloud key is checked: the model gate forwards each coding tool's own login. CLOUD_* is read only by
  // the benchmark, the optional resolver cloud tier and an OpenAI-compatible SLM_PROVIDER.

  // 6 & 7. Downstream MCP Configuration & TLS Adapter rules
  // Ensures that if the user explicitly enabled the TLS adapter, the downstream MCP target is physically present on disk.
  if (CONFIG.DOWNSTREAM_MCP) {
    report(true, 'DOWNSTREAM_MCP is configured');

    if (CONFIG.DOWNSTREAM_MCP.command) {
      // For Stdio MCP servers, the first argument is conventionally the target script.
      const cmdArgs = CONFIG.DOWNSTREAM_MCP.args || [];
      const targetFile = cmdArgs[0]; 
      
      if (targetFile) {
        const resolvedTarget = path.resolve(targetFile);
        const targetExists = fs.existsSync(resolvedTarget);
        
        let fixMsg = `Ensure the file exists at ${resolvedTarget}`;
        if (!targetExists && resolvedTarget.includes('tech-lead-stack') && resolvedTarget.includes('mcp-server.mjs')) {
          const tlsDir = resolvedTarget.split('/dist/')[0];
          fixMsg = `build it: cd ${tlsDir} && pnpm run mcp:build`;
        }
        
        report(targetExists, `DOWNSTREAM_MCP target file exists (${resolvedTarget})`, fixMsg);
      }
    }
  } else {
    report(!CONFIG.TLS_ADAPTER, 'DOWNSTREAM_MCP is blank (standalone mode)', 'TLS_ADAPTER=on requires DOWNSTREAM_MCP to be set');
  }

  // 8. SQLite Ledger path & permissions
  // MCP hosts (Claude Desktop among them) spawn the gate with a working directory that may not
  // exist. A cwd-relative LEDGER_PATH therefore passes here — doctor runs from the repo — and
  // ENOENTs inside the host, so only an absolute path is accepted.
  if (!path.isAbsolute(CONFIG.LEDGER_PATH)) {
    report(false, `Ledger path is a full path (${CONFIG.LEDGER_PATH})`,
      `Set LEDGER_PATH to a full path on this machine, e.g. ${path.join(CONFIG.OUTPUT_DIR, 'ledger.sqlite')} — or leave it blank to use that default.`);
  } else {
    const ledgerDir = path.dirname(CONFIG.LEDGER_PATH);
    try {
      if (!fs.existsSync(ledgerDir)) {
        fs.mkdirSync(ledgerDir, { recursive: true });
      }
      fs.accessSync(ledgerDir, fs.constants.W_OK);
      report(true, `Ledger path is writable (${CONFIG.LEDGER_PATH})`);
    } catch (e) {
      report(false, `Ledger path is not writable (${CONFIG.LEDGER_PATH})`, 'Fix permissions for the output directory.');
    }
  }

  // 8b. Window budgets. Without one, that provider's cycle cards never fill in.
  // A note, not a failure: the gate itself works fine without them.
  const cycleCards = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' } as const;
  const registry = getProviderRegistry();
  for (const [id, label] of Object.entries(cycleCards)) {
    if (!registry[id]?.windowBudget) {
      console.log(`  Note: ${id.toUpperCase()}_WINDOW_BUDGET is not set, so both "${label} Cycle" cards (Est. Seconds Saved / Est. Minutes Saved) will stay empty.`);
    }
  }

  // 9. The model gate: every coding tool pointed at it fails while it is down, so this warns loudly.
  const gatePort = CONFIG.MODEL_GATE_PORT;
  const gateAddress = `http://localhost:${gatePort}`;
  const toolsFail = `EVERY CODING TOOL POINTED AT ${gateAddress} CANNOT REACH ITS AI PROVIDER.`;
  const [start, restart, doctor] = [cliCommand('start'), cliCommand('restart'), cliCommand('doctor')];
  const reinstall = `If it still does not start, see ${GATE_LOG_FILE}; a broken install is repaired with \`cd ${CONFIG.ROOT_DIR} && pnpm install && pnpm run build\`, then \`${restart}\`.`;
  const gate = await probeGate({ port: gatePort });
  if (gate.kind === 'slm-gate') {
    report(true, `Model gate is running on ${gateAddress} (pid ${gate.health.pid}, started ${gate.health.startedAt})`);
    if (gate.stale) {
      report(false, 'The running model gate is an older slm-gate build than the one installed',
        `\`${restart}\` when no coding tool is in the middle of an answer.`);
    }
  } else if (gate.kind === 'other') {
    const owner = portOwner(gatePort) ?? 'another program';
    report(false, `MODEL GATE CANNOT RUN: port ${gatePort} is taken by ${owner}. ${toolsFail}`,
      `Either quit ${owner}, then run \`${start}\`. Or move the gate to a free port: set LLM_GATE_PORT=<new port> in ${path.join(CONFIG.ROOT_DIR, '.env')}, run \`${restart}\`, then run \`${doctor}\` again, paste the new lines below into each coding tool and restart them.`);
  } else if (isStoppedByUser()) {
    report(false, `MODEL GATE IS STOPPED (you ran \`slm-gate stop\`). ${toolsFail}`,
      `\`${start}\` (it also starts again by itself after a reboot). ${reinstall}`);
  } else {
    const startsItself = CONFIG.LLM_GATE_AUTOSTART
      ? `It starts by itself when a coding tool starts slm-gate's MCP server; to start it now run \`${start}\`.`
      : `LLM_GATE_AUTOSTART is off, so nothing starts it for you: run \`${start}\`.`;
    report(false, `MODEL GATE IS NOT RUNNING on ${gateAddress}. ${toolsFail}`, `${startsItself} ${reinstall}`);
  }

  if (CONFIG.MCP_GATE_TRANSPORT === 'http') {
    const mcpPortFree = await checkPortFree(CONFIG.MCP_GATE_PORT);
    report(mcpPortFree, `MCP_GATE_PORT (${CONFIG.MCP_GATE_PORT}) is free`, `Kill the process using port ${CONFIG.MCP_GATE_PORT}`);
  }

  // 10. The setting that sends each coding tool's model requests through the gate (on the current port).
  console.log(`\n--- Coding tool settings: paste these to send a tool's model requests through ${gateAddress} ---`);
  for (const setting of toolSettings(gatePort)) {
    console.log(`\n${setting.tool}  (works with: ${setting.login})`);
    for (const line of setting.lines) console.log(`  ${line}`);
  }
  console.log('\nThese cannot send their model requests through the gate (slm-gate\'s MCP tools still work in them):');
  for (const unroutable of UNROUTABLE_TOOLS) console.log(`  ${unroutable.tool}: ${unroutable.reason}`);

  console.log('\n=============================================');
  if (issues === 0) {
    console.log('READY');
  } else {
    console.log(`${issues} issue(s) to fix`);
    process.exit(1); // Fail the script execution so CI pipelines or scripts can catch it
  }
}

run().catch(err => {
  console.error('Doctor check failed unexpectedly:', err);
  process.exit(1);
});
