/**
 * @fileoverview `slm-gate init`: creates the settings file (`.env` in the settings folder, src/home-dir.ts).
 *
 * It copies the full template (`.env.example`, every setting explained) and fills in only the lines that
 * depend on this computer, with the values doctor recommends for its RAM. It assumes no coding tool, AI
 * provider or toolbox: PROVIDER is left blank, and so are keys and DOWNSTREAM_MCP. An existing settings
 * file is never replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ramPresets, recommendNumCtx, recommendPreset } from '../hardware.js';

/** The template lines `init` fills in for a computer with `ramGb` of RAM. */
export function settingsForRam(ramGb: number): { preset: string; models: string[]; lines: Record<string, string> } {
  const preset = recommendPreset(ramGb);
  const { brain, gate } = ramPresets[preset];
  return {
    preset,
    models: [...new Set([brain, gate])],
    lines: {
      RAM_PRESET: preset,
      SLM_BRAIN_MODEL: brain,
      SLM_GATE_MODEL: gate,
      SLM_GATE_TESTING_MODEL: gate,
      NUM_CTX: String(recommendNumCtx(ramGb)),
      PROVIDER: '',
    },
  };
}

/**
 * Sets `KEY=value` lines in a settings template.
 *
 * @param template The template text
 * @param lines The values to set, by key
 * @returns The template with those lines set
 * @throws When a key is not on exactly one line of its own: the template changed, and guessing where the
 *   setting goes could leave the file with a value slm-gate never reads
 */
export function fillSettings(template: string, lines: Record<string, string>): string {
  return Object.entries(lines).reduce((text, [key, value]) => {
    const line = new RegExp(`^${key}=.*$`, 'gm');
    const found = text.match(line)?.length ?? 0;
    if (found !== 1) throw new Error(`.env.example has ${found} ${key}= lines; expected exactly 1.`);
    return text.replace(line, `${key}=${value}`);
  }, template);
}

/**
 * Creates the settings file for this computer, unless one exists.
 *
 * @param params.installDir The install folder, where `.env.example` is
 * @param params.homeDir The settings folder
 * @param params.ramGb This computer's RAM, in GB
 * @returns Whether the file was created, where it is, the RAM preset and the models to download
 */
export function initSettings(params: { installDir: string; homeDir: string; ramGb: number }): {
  created: boolean; envPath: string; preset: string; models: string[];
} {
  const envPath = path.join(params.homeDir, '.env');
  const { preset, models, lines } = settingsForRam(params.ramGb);
  if (fs.existsSync(envPath)) return { created: false, envPath, preset, models };

  const template = fs.readFileSync(path.join(params.installDir, '.env.example'), 'utf8');
  const text = fillSettings(template, lines);
  fs.mkdirSync(params.homeDir, { recursive: true });
  // 'wx' fails rather than replace a file created meanwhile; 0o600 because the file may later hold keys.
  fs.writeFileSync(envPath, text, { flag: 'wx', mode: 0o600 });
  return { created: true, envPath, preset, models };
}
