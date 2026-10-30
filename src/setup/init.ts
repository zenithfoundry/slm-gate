/**
 * @fileoverview `slm-gate init`: creates the settings file (`.env` in the settings folder, src/home-dir.ts).
 *
 * It copies the template (`.env.example`, every setting explained) and fills in the lines that depend on
 * this computer (the models and context doctor recommends for its RAM), the lines of the chosen profile,
 * and the AI provider when one was given. Keys and a toolbox's own settings are left for the user. An
 * existing settings file is never replaced.
 */
import { parse } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_RAM_GB, modelsForRam, recommendNumCtx, recommendPreset } from '../hardware.js';
import { modelsFor } from './required-models.js';
import type { ProviderId } from '../pricing/plans.js';

export type ProfileName = 'starter' | 'proven' | 'toolbox';

/**
 * The settings profiles `init --profile` offers: the few lines each sets on top of the template's defaults.
 * Models and NUM_CTX never come from a profile; they come from the RAM table (settingsForRam).
 *
 * - starter: the template as shipped. Tool results shrunk in both gates, conversation memory on, the two
 *   local models pinned; no third model, no toolbox.
 * - proven: the maintainer's daily settings (2026-10-30). Skill text shortened under the fidelity guard, the
 *   repository index on for find_existing, and one brain run per common-practice answer instead of three.
 * - toolbox: proven, with the tech-lead-stack toolbox behind the MCP gate and its adapter on. Edit
 *   DOWNSTREAM_MCP afterwards if the toolbox runs from a checkout rather than npm.
 */
export const PROFILES: Record<ProfileName, { summary: string; lines: Record<string, string> }> = {
  starter: {
    summary: 'the defaults: shrinks tool results in both gates and remembers each conversation',
    lines: {},
  },
  proven: {
    summary: "the maintainer's daily settings: skill text shortened too, repository index on, one brain run per answer",
    lines: { DISTILL_SKILLS: 'on', REPO_INDEX: 'on', SELF_CONSISTENCY_K: '1' },
  },
  toolbox: {
    summary: 'proven, with the tech-lead-stack toolbox behind the MCP gate',
    lines: {
      DISTILL_SKILLS: 'on',
      REPO_INDEX: 'on',
      SELF_CONSISTENCY_K: '1',
      DOWNSTREAM_MCP: '{"command":"npx","args":["-y","tech-lead-stack@1"]}',
      TLS_ADAPTER: 'on',
      DISTILL_PRESERVE_PATH: 'configs/preserve/tls.json',
    },
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];
export const PROVIDER_NAMES: ProviderId[] = ['claude', 'chatgpt', 'gemini'];

/**
 * Every line `init` sets for a computer and a choice of profile and provider: the RAM lines, then the
 * profile's, then PROVIDER. This is what `init --show` prints.
 */
export function settingsFor(params: { ramGb: number; profile: ProfileName; provider?: ProviderId }): {
  preset: string; lines: Record<string, string>;
} {
  const { preset, lines } = settingsForRam(params.ramGb);
  return {
    preset,
    lines: { ...lines, ...PROFILES[params.profile].lines, ...(params.provider ? { PROVIDER: params.provider } : {}) },
  };
}

/**
 * The template lines `init` fills in for a computer with `ramGb` of RAM: the same preset, models and
 * NUM_CTX doctor recommends (src/hardware.ts). Above 128 GB the preset is `custom`, with the 128 GB models.
 *
 * @throws When `ramGb` is below MIN_RAM_GB, which slm-gate does not support
 */
export function settingsForRam(ramGb: number): { preset: string; lines: Record<string, string> } {
  if (ramGb < MIN_RAM_GB) {
    throw new Error(`slm-gate needs at least ${MIN_RAM_GB} GB of RAM; this is set up for ${ramGb} GB.`);
  }
  const preset = recommendPreset(ramGb);
  const { brain, gate } = modelsForRam(ramGb);
  return {
    preset,
    lines: {
      RAM_PRESET: preset,
      SLM_BRAIN_MODEL: brain,
      SLM_GATE_MODEL: gate,
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
 * The local models a settings file needs, by the start-up check's rule (src/setup/required-models.ts), so
 * following init's download step leaves nothing for that check to report.
 */
function modelsIn(settingsText: string): string[] {
  const settings = parse(settingsText);
  // As config.ts reads them: on, true or 1 is on; anything else, blank included, is off (both default to off).
  const isOn = (value?: string) => ['on', 'true', '1'].includes((value ?? '').toLowerCase());
  const models = modelsFor({
    SLM_GATE_MODEL: settings.SLM_GATE_MODEL ?? '',
    SLM_BRAIN_MODEL: settings.SLM_BRAIN_MODEL ?? '',
    EMBED_MODEL: settings.EMBED_MODEL ?? '',
    SEMCACHE: isOn(settings.SEMCACHE),
    DISTILL_ADAPTIVE: isOn(settings.DISTILL_ADAPTIVE),
  });
  return [...new Set(models.map(model => model.name).filter(Boolean))];
}

/**
 * Creates the settings file for this computer, unless one exists.
 *
 * @param params.installDir The install folder, where `.env.example` is
 * @param params.homeDir The settings folder
 * @param params.ramGb This computer's RAM, in GB
 * @param params.profile The profile whose lines to set (default: starter)
 * @param params.provider The AI provider the coding tool uses, when known
 * @returns Whether the file was created, where it is, the RAM preset and the models to download
 */
export function initSettings(params: {
  installDir: string; homeDir: string; ramGb: number; profile?: ProfileName; provider?: ProviderId;
}): { created: boolean; envPath: string; preset: string; models: string[] } {
  const envPath = path.join(params.homeDir, '.env');
  const { preset, lines } = settingsFor({ ramGb: params.ramGb, profile: params.profile ?? 'starter', provider: params.provider });
  if (fs.existsSync(envPath)) return { created: false, envPath, preset, models: modelsIn(fs.readFileSync(envPath, 'utf8')) };

  const template = fs.readFileSync(path.join(params.installDir, '.env.example'), 'utf8');
  const text = fillSettings(template, lines);
  fs.mkdirSync(params.homeDir, { recursive: true });
  // 'wx' fails rather than replace a file created meanwhile; 0o600 because the file may later hold keys.
  fs.writeFileSync(envPath, text, { flag: 'wx', mode: 0o600 });
  return { created: true, envPath, preset, models: modelsIn(text) };
}
