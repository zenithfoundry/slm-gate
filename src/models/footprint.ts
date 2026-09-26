import ollama from 'ollama';
import { CONFIG } from '../config.js';
import { detectHardware, MIN_RAM_GB, modelsForRam, recommendPreset } from '../hardware.js';

/**
 * Warms up the provided SLM models by sending a single, short prompt.
 * This forces the Ollama backend to load the model into memory, reducing latency on subsequent requests.
 * 
 * @param client - The Ollama client instance (defaults to the global imported ollama instance).
 * @returns A promise that resolves when the warmup chats are dispatched (or fail gracefully).
 * 
 * @example
 * // Warms up models configured in SLM_BRAIN_MODEL and SLM_GATE_MODEL
 * await warmup();
 */
export async function warmup(client = ollama): Promise<void> {
  const modelsToWarm = new Set([CONFIG.SLM_BRAIN_MODEL, CONFIG.SLM_GATE_MODEL]);
  
  try {
    const listResponse = await client.list();
    const availableModels = listResponse.models || [];
    
    for (const model of modelsToWarm) {
      if (!availableModels.some(m => m.name === model || m.model === model)) {
        console.warn(`not pulled — run ollama pull ${model}`);
      } else {
        try {
          await client.chat({
            model: model,
            messages: [{ role: 'user', content: 'hi' }],
            options: { num_predict: 1 }
          });
        } catch (e) {
          // Ignore error during warmup chat
        }
      }
    }
  } catch (err) {
    console.error('Failed to connect to Ollama for warmup:', err);
  }
}

/**
 * Fetches the footprint (size in bytes) of specific models from the Ollama backend.
 * 
 * @param models - An array of model strings to check (e.g., ['qwen3:14b', 'qwen3:1.7b']).
 * @param client - The Ollama client instance (defaults to the global imported ollama instance).
 * @returns A promise that resolves to an object mapping each model name to its size in bytes.
 * 
 * @example
 * const sizes = await getModelsFootprint(['qwen3:14b']);
 * console.log(`Size: ${sizes['qwen3:14b']} bytes`);
 */
export async function getModelsFootprint(models: string[], client = ollama): Promise<{ [key: string]: number }> {
  const result: { [key: string]: number } = {};
  try {
    const listResponse = await client.list();
    const availableModels = listResponse.models || [];
    
    for (const model of models) {
      const found = availableModels.find(m => m.name === model || m.model === model);
      if (found && found.size) {
        result[model] = found.size;
      }
    }
  } catch (err) {
    // Ignore error
  }
  return result;
}

/**
 * Generates and prints a detailed footprint report of the configured SLM models.
 * Used primarily for diagnostic purposes to ensure the user's models fit within their RAM budget.
 * 
 * @param client - The Ollama client instance.
 * @throws {Error} If the Ollama backend is completely unreachable.
 * 
 * @example
 * await footprintReport();
 * // Outputs:
 * // === SLM Footprint Report ===
 * // - qwen3:14b: 8.50 GB
 * // - qwen3:1.7b: 1.10 GB
 * // Total footprint: 9.60 GB
 * // Current RAM preset: custom
 * // 
 * // --- Recommendations (24GB RAM Detected) ---
 * // * Dedicated AI Node:   ram-24 (Max capacity)
 * // * Primary Workhorse:   ram-16 (Leaves headroom for apps)
 * // -----------------------------------------------
 */
export async function footprintReport(client = ollama): Promise<void> {
  console.log(`\n=== SLM Footprint Report ===`);
  const modelsToCheck = new Set([CONFIG.SLM_BRAIN_MODEL, CONFIG.SLM_GATE_MODEL]);
  let totalBytes = 0;
  
  try {
    const listResponse = await client.list();
    const availableModels = listResponse.models || [];
    
    for (const model of modelsToCheck) {
      const found = availableModels.find(m => m.name === model || m.model === model);
      if (found && found.size) {
        const sizeGB = (found.size / (1024 * 1024 * 1024)).toFixed(2);
        console.log(`- ${model}: ${sizeGB} GB`);
        totalBytes += found.size;
      } else {
        console.log(`- ${model}: not pulled — run ollama pull ${model}`);
      }
    }
    
    const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    console.log(`Total footprint: ${totalGB} GB`);
    console.log(`Current RAM preset: ${CONFIG.RAM_PRESET}`);

    try {
      const hw = detectHardware();
      const workhorseRamGB = Math.max(MIN_RAM_GB, hw.totalRamGB - 8);
      const dedicatedPreset = recommendPreset(hw.totalRamGB);
      const workhorsePreset = recommendPreset(workhorseRamGB);

      const dedicatedModels = modelsForRam(hw.totalRamGB);
      const workhorseModels = modelsForRam(workhorseRamGB);

      console.log(`\n--- Recommendations (${hw.totalRamGB}GB RAM Detected) ---\n`);
      
      console.log(`OPTION A: Dedicated AI Node (Preset: ${dedicatedPreset})`);
      console.log(`- Recommended Models: ${dedicatedModels.brain} (Brain) + ${dedicatedModels.gate} (Gate)`);
      console.log(`- Target Workload: Machines where SLM-Gate is the primary running application.`);
      console.log(`- Note: This maximizes AI capabilities but leaves minimal RAM for other heavy applications.\n`);

      console.log(`OPTION B: Primary Workhorse (Preset: ${workhorsePreset})`);
      console.log(`- Recommended Models: ${workhorseModels.brain} (Brain) + ${workhorseModels.gate} (Gate)`);
      console.log(`- Target Workload: Daily driver machines running browsers, IDEs, or databases simultaneously.`);
      console.log(`- Note: If you choose to run Option A's larger models on a workhorse machine, you MUST actively free up system RAM before starting. Otherwise, the OS will swap heavily, causing severe UI lag and slow token generation.`);
      console.log(`-----------------------------------------------`);
    } catch {
      // In case hardware detection fails gracefully
    }
  } catch (err) {
    throw new Error('Could not fetch model sizes. Is Ollama running?');
  }
}
