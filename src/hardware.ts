import { execSync } from 'node:child_process';
import os from 'node:os';

/**
 * Represents the detected hardware capabilities of the host system.
 * This information is used to make smart defaults for memory-intensive operations.
 */
export interface HardwareInfo {
  /** Total system RAM in Gigabytes */
  totalRamGB: number;
  /** CPU architecture (e.g., 'x64', 'arm64') */
  arch: string;
  /** OS platform (e.g., 'darwin', 'linux', 'win32') */
  platform: string;
  /** True if running on Apple Silicon (M1/M2/M3/M4 chips) */
  isAppleSilicon: boolean;
  /** The primary hardware accelerator available for ML workloads */
  accelerator: 'metal' | 'cuda' | 'cpu';
  /** True if the system shares RAM between CPU and GPU (e.g., Apple Silicon) */
  unifiedMemory: boolean;
}


/**
 * Detects the host machine's hardware capabilities.
 * Determines total RAM, OS platform, and available ML accelerators.
 * 
 * @param mockOs - Optional mock OS module for unit testing.
 * @returns {HardwareInfo} An object detailing the host's hardware profile.
 * 
 * @example
 * const hw = detectHardware();
 * if (hw.accelerator === 'cuda') {
 *   console.log('NVIDIA GPU detected!');
 * }
 */
export function detectHardware(mockOs?: { totalmem: () => number; arch: () => string; platform: () => string }): HardwareInfo {
  const osModule = mockOs || os;
  const totalRamGB = Math.round(osModule.totalmem() / (1024 * 1024 * 1024));
  const arch = osModule.arch();
  const platform = osModule.platform();
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
  
  let accelerator: 'metal' | 'cuda' | 'cpu' = 'cpu';
  
  // Apple Silicon inherently supports Metal
  if (isAppleSilicon) {
    accelerator = 'metal';
  } else {
    // Attempt to detect NVIDIA GPUs by running nvidia-smi
    try {
      execSync('nvidia-smi', { stdio: 'ignore' });
      accelerator = 'cuda';
    } catch {
      // Ignore errors (e.g., command not found or no GPU), fallback to 'cpu' remains
    }
  }

  // Apple Silicon uses a unified memory architecture where CPU and GPU share the same RAM pool
  const unifiedMemory = isAppleSilicon;

  return { totalRamGB, arch, platform, isAppleSilicon, accelerator, unifiedMemory };
}

/** slm-gate needs at least this much RAM: both local models, their context, and room for your other apps. */
export const MIN_RAM_GB = 16;

/**
 * Recommends a RAM preset for a computer with MIN_RAM_GB of RAM or more. A size between two presets gets
 * the smaller one (48–63 GB → ram-48). More than 128 GB gets `custom`: start from the 128 GB models
 * (modelsForRam) and choose bigger ones yourself, e.g. with llmfit (https://github.com/AlexsJones/llmfit).
 * `slm-gate init` and `slm-gate doctor` both use this.
 *
 * @param totalRamGB - The total physical RAM in gigabytes.
 * @returns {string} The recommended RAM preset key (e.g., 'ram-16').
 *
 * @example
 * const preset = recommendPreset(48);
 * // returns 'ram-48'
 */
export function recommendPreset(totalRamGB: number): string {
  if (totalRamGB > 128) return 'custom';
  if (totalRamGB >= 128) return 'ram-128';
  if (totalRamGB >= 64) return 'ram-64';
  if (totalRamGB >= 48) return 'ram-48';
  if (totalRamGB >= 32) return 'ram-32';
  if (totalRamGB >= 24) return 'ram-24';
  return 'ram-16';
}

/**
 * Recommends a safe context window size (NUM_CTX) based on available RAM.
 * Ensures that there is enough memory to hold KV caches for both SLM models if running in dual-model mode.
 * 
 * @param totalRamGB - The total physical RAM in gigabytes.
 * @param dualModel - Whether the system is running both a brain and a gate model concurrently (defaults to true).
 * @returns {number} The recommended NUM_CTX context length.
 * 
 * @example
 * const numCtx = recommendNumCtx(16);
 * // returns 4096
 */
export function recommendNumCtx(totalRamGB: number, dualModel: boolean = true): number {
  return totalRamGB >= 24 ? 8192 : 4096;
}

/**
 * Pre-defined model pairs tailored to different RAM tiers: the one table config.ts, doctor, init and
 * `models:check` all read. Each preset specifies a 'brain' model (for complex reasoning) and a 'gate' model
 * (for fast routing/classification); every name must exist in Ollama's library. `custom` is the pair used
 * when RAM_PRESET=custom and no SLM_*_MODEL is set.
 */
export const ramPresets: Record<string, { brain: string, gate: string }> = {
  'ram-16':  { brain: 'qwen2.5-coder:3b', gate: 'qwen2.5-coder:0.5b' },
  'ram-24':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
  'ram-32':  { brain: 'qwen2.5:7b',       gate: 'qwen2.5-coder:3b' },
  'ram-48':  { brain: 'qwen3.5:9b',       gate: 'qwen2.5-coder:3b' },
  'ram-64':  { brain: 'qwen3.5:9b',       gate: 'qwen3.5:4b' },
  'ram-128': { brain: 'qwen3:14b',        gate: 'qwen3:8b' },
  'custom':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
};

/**
 * The models for a computer with this much RAM: its preset's pair, or above 128 GB (preset `custom`) the
 * 128 GB pair, which certainly fits and is the starting point for choosing bigger models.
 */
export function modelsForRam(totalRamGB: number): { brain: string, gate: string } {
  const preset = recommendPreset(totalRamGB);
  return ramPresets[preset === 'custom' ? 'ram-128' : preset];
}

/**
 * Parses a RAM preset string to extract its numeric ranking/size in GB.
 * This is used to logically compare if a user's configured preset is too demanding for their hardware.
 * 
 * @param preset - The RAM preset string (e.g., 'ram-16' or 'custom').
 * @returns {number} The numeric equivalent of the preset in GB.
 * 
 * @example
 * const rank = getPresetRank('ram-16');
 * // returns 16
 */
export function getPresetRank(preset: string): number {
  const match = preset.match(/^ram-(\d+)$/);
  if (match) return parseInt(match[1], 10);
  
  // `custom` without model names uses the custom pair (qwen3.5:4b + qwen2.5-coder:3b), a ram-24 class load
  return 24;
}
