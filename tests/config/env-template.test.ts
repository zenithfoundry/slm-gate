import { describe, expect, it } from '@jest/globals';
import { parse } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_ENV_KEYS, envSchema } from '../../src/config.js';

// The template is the one list of settings a person sees, and the schema is the one list the code reads.
// They must be the same list, and the template must ship the code's defaults, or `slm-gate init` writes a
// file that behaves differently from no file at all.
const template = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
const templateValues = parse(template);

describe('.env.example and the configuration schema', () => {
  it('list exactly the same settings', () => {
    expect(Object.keys(templateValues).sort()).toEqual([...CONFIG_ENV_KEYS].sort());
  });

  it('name each setting on exactly one line of its own, so init can fill it in', () => {
    for (const key of CONFIG_ENV_KEYS) {
      expect([key, template.match(new RegExp(`^${key}=`, 'gm'))?.length]).toEqual([key, 1]);
    }
  });

  it('ship the built-in defaults, so a settings file and no settings file behave the same', () => {
    const setInTemplate = Object.fromEntries(Object.entries(templateValues).filter(([, value]) => value !== ''));
    expect(envSchema.parse(setInTemplate)).toEqual(envSchema.parse({}));
  });
});
