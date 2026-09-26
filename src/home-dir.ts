/**
 * @fileoverview Where an install keeps its settings and data: `.env`, and `output/` (the ledger, logs,
 * markers and notices). Code and the shipped templates (`dist/`, `configs/`) stay in the install folder.
 *
 * - A git checkout keeps them in the checkout, as it always has.
 * - An npm install lives inside `node_modules`, which every upgrade replaces, so it uses `~/.slm-gate`.
 * - `SLM_GATE_HOME` overrides both. It says where `.env` is, so it comes from the environment (the shell,
 *   or a coding tool's MCP env block), not from `.env`. It is not a configuration key, so the
 *   automatically started model gate inherits it (src/setup/model-gate.ts `gateEnvironment`) and reads
 *   the same `.env`.
 *
 * No side effects: cli.ts imports this without loading the configuration.
 */
import path from 'node:path';

/**
 * @param params.installDir The install folder, where `dist/` and `configs/` are
 * @param params.env The process environment; only SLM_GATE_HOME is read, and blank counts as unset
 * @param params.userHome The user's home folder
 * @returns The absolute folder for `.env` and `output/`
 * @throws When SLM_GATE_HOME is not an absolute path: coding tools start slm-gate from any folder, so a
 *   relative one would point somewhere different each time
 */
export function resolveHomeDir(params: { installDir: string; env: NodeJS.ProcessEnv; userHome: string }): string {
  const explicit = params.env.SLM_GATE_HOME;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error(`SLM_GATE_HOME must be an absolute path, because coding tools start slm-gate from any folder; got "${explicit}".`);
    }
    return path.resolve(explicit);
  }
  return params.installDir.split(path.sep).includes('node_modules')
    ? path.join(params.userHome, '.slm-gate')
    : params.installDir;
}
