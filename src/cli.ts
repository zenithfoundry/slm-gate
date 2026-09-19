#!/usr/bin/env node
/**
 * Entry point for the `slm-gate` CLI.
 * 
 * Why it is written this way:
 * 1. Dual Execution Environments: We need to support running via `tsx src/cli.ts` in development,
 *    and `node dist/cli.js` when installed globally or built for production.
 * 2. Process Spawning: Instead of heavily coupling the CLI directly to the module logic (which might
 *    carry complex dependencies or require TS execution), this script acts purely as an orchestrator.
 *    It determines whether to use Node or tsx and spawns child processes for the actual commands.
 * 3. Environment Overrides: It allows injecting temporary environment variables (like RAM presets) 
 *    into the spawned processes without permanently mutating the parent process environment.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
// ROOT_DIR ensures that no matter where the command is executed from, it executes relative to the project root.
const ROOT_DIR = path.resolve(dirname, '..');

/**
 * Spawns a child process for a given command.
 * 
 * @param command - The executable to run (e.g., 'node' or 'tsx')
 * @param args - Arguments to pass to the executable
 * @param env - Additional environment variables to overlay on top of process.env
 * @returns The spawned ChildProcess instance
 */
function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit', // Connects child's stdout/stderr directly to the terminal
    cwd: ROOT_DIR,
    env: { ...process.env, ...env }
  });

  child.on('error', (err) => {
    console.error(`Failed to start process: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      process.exit(code || 1);
    }
  });

  return child;
}

// Determine if we are running the compiled JavaScript (from dist/) or TypeScript (from src/)
const isCompiled = filename.endsWith('.js');
const tsxPath = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');

/**
 * Resolves the correct execution path and command for a given source script.
 * 
 * @param srcPath - The relative path to the TypeScript source file (e.g., 'src/config.ts')
 * @returns An object containing the executable ('node' or 'tsx') and the absolute path to the target file.
 */
function getRunPath(srcPath: string) {
  // If we're executing the compiled CLI (dist/cli.js), we map 'src/*.ts' to 'dist/*.js' and use 'node'
  if (isCompiled && srcPath.startsWith('src/')) {
    const distPath = srcPath.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
    return { command: 'node', args: [path.join(ROOT_DIR, distPath)] };
  }
  // If running in development, we use 'tsx' to execute the TypeScript files directly
  return { command: tsxPath, args: [path.join(ROOT_DIR, srcPath)] };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
Usage: slm-gate <command> [options]

Commands:
  serve          Run the model gate in this terminal (normally not needed: it starts by itself
                 whenever a coding tool starts slm-gate's MCP server)
                 Options:
                   --layer llm|mcp|both     (default: llm; your coding tools start the MCP server)
                   --transport stdio|http   (MCP server transport, default: stdio)
                   --preset <preset>        (override RAM preset, e.g., ram-24)
  start          Start the model gate in the background (if it is not running)
  stop           Stop the model gate; it stays stopped until start, restart or a reboot
  restart        Stop and start the model gate (e.g. after updating slm-gate)
  bench          Run the offline evaluation harness
                 Options:
                   --n <number>             (number of tasks to run)
  metrics        Show performance and cost metrics from the local ledger
  ledger:sync    Sync local SQLite ledger traces and scores to Langfuse
                 Options:
                   --all                    (sync all historical events)
                   --limit <number>         (limit number of events to sync)
                   --dry-run                (simulate without sending network requests)
  ledger:reset   Nuke local SQLite database and start fresh
  setup-dashboard Setup Langfuse dashboard and widgets
  config         Print the current resolved configuration
  models:check   Check if required models are pulled and fit in RAM
  doctor         Run preflight readiness checks
`);
    process.exit(0);
  }

  if (command === 'serve') {
    // The MCP server is started by the coding tools themselves; by hand you usually want the model gate.
    let layer = 'llm';
    let transport = 'stdio';
    let preset = '';

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--layer') layer = args[++i];
      else if (args[i] === '--transport') transport = args[++i];
      else if (args[i] === '--preset') preset = args[++i];
    }

    if (!layer || !['mcp', 'llm', 'both'].includes(layer)) {
      console.error('Error: --layer must be mcp, llm, or both');
      process.exit(1);
    }

    const envOverride: any = {};
    if (preset) envOverride['RAM_PRESET'] = preset;
    if (transport) envOverride['MCP_GATE_TRANSPORT'] = transport;

    const layersToStart = [];
    if (layer === 'mcp' || layer === 'both') layersToStart.push('src/mcp-gate/index.ts');
    if (layer === 'llm' || layer === 'both') layersToStart.push('src/llm-gate/index.ts');

    for (const src of layersToStart) {
      const { command: cmd, args: cmdArgs } = getRunPath(src);
      runCommand(cmd, cmdArgs, envOverride);
    }
  } else if (command === 'bench') {
    // Pass all args after bench to the run script
    const benchArgs = args.slice(1);
    runCommand(tsxPath, [path.join(ROOT_DIR, 'harness/run.ts'), ...benchArgs]);
  } else if (command === 'metrics') {
    runCommand(tsxPath, [path.join(ROOT_DIR, 'harness/metrics.ts')]);
  } else if (command === 'ledger:sync' || command === 'sync') {
    const syncArgs = args.slice(1);
    const { command: cmd, args: cmdArgs } = getRunPath('src/ledger/sync.ts');
    runCommand(cmd, [...cmdArgs, ...syncArgs]);
  } else if (command === 'setup-dashboard') {
    const { command: cmd, args: cmdArgs } = getRunPath('src/ledger/setup-dashboard.ts');
    runCommand(cmd, cmdArgs);
  } else if (command === 'ledger:reset') {
    const filesToNuke = [
      path.join(ROOT_DIR, 'output/ledger.sqlite'),
      path.join(ROOT_DIR, 'output/ledger.sqlite-wal'),
      path.join(ROOT_DIR, 'output/ledger.sqlite-shm'),
      path.join(ROOT_DIR, 'output/deferral_curve.svg'),
      path.join(ROOT_DIR, 'output/leaderboard.md')
    ];
    for (const f of filesToNuke) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
    console.log('Local SQLite ledger and benchmark outputs nuked successfully.');
    process.exit(0);
  } else if (command === 'config') {
    const { command: cmd, args: cmdArgs } = getRunPath('src/config.ts');
    // For config, if using node, we need to make sure we don't just import it but run it.
    // The config.ts has a block that checks if it's the main module.
    runCommand(cmd, cmdArgs);
  } else if (command === 'models:check') {
    const { command: cmd, args: cmdArgs } = getRunPath('src/models/check.ts');
    runCommand(cmd, cmdArgs);
  } else if (command === 'doctor') {
    const { command: cmd, args: cmdArgs } = getRunPath('src/doctor.ts');
    runCommand(cmd, cmdArgs);
  } else if (command === 'start' || command === 'stop' || command === 'restart') {
    const { command: cmd, args: cmdArgs } = getRunPath('src/setup/gate-command.ts');
    runCommand(cmd, [...cmdArgs, command]);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
