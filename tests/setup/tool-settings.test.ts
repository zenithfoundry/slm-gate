import { describe, expect, it } from '@jest/globals';
import { toolSettings, UNROUTABLE_TOOLS } from '../../src/setup/tool-settings.js';

describe('toolSettings (printed by `slm-gate doctor`)', () => {
  const lines = (port: number) => toolSettings(port).flatMap(setting => setting.lines);

  it('uses the configured port in every address, so a changed port prints the lines to update', () => {
    const addresses = lines(9123).join('\n').match(/http:\/\/localhost:\d+/g) ?? [];
    expect(addresses.length).toBeGreaterThan(10);
    expect(new Set(addresses)).toEqual(new Set(['http://localhost:9123']));
  });

  it('gives Claude Code the address without /v1 and Codex the address with /v1', () => {
    const [claudeCode, codex] = toolSettings(8787);
    expect(claudeCode.lines[0]).toContain('"ANTHROPIC_BASE_URL": "http://localhost:8787" }');
    expect(codex.lines).toContain('  base_url = "http://localhost:8787/v1"');
    expect(codex.lines).toContain('  requires_openai_auth = true');
  });

  it('explains why each unroutable tool cannot use the gate', () => {
    expect(UNROUTABLE_TOOLS.map(entry => entry.tool).join(' ')).toContain('Cursor');
    for (const entry of UNROUTABLE_TOOLS) expect(entry.reason.length).toBeGreaterThan(10);
  });
});
