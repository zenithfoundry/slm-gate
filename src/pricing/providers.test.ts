/**
 * Model-naming and attribution guards.
 *
 * Model ids move fast. These tests pin the families that existed when the registry was
 * last verified (2026-09-13) so a stale pattern list fails loudly instead of silently
 * mis-attributing traffic or dropping it from every per-provider metric.
 */

import { providerFromModelId, providerFromAgentName, getProviderRegistry, __resetProviderRegistry, DEFAULT_PROVIDER_REGISTRY } from './providers.js';
import { calculateCostUsd, normalizeModelId, PRICING } from './index.js';

beforeEach(() => __resetProviderRegistry());

describe('current model families are attributed to the right provider', () => {
  it.each([
    // OpenAI — the o-series is retired; every text model is gpt-*, except daybreak aliases.
    ['gpt-6-astra', 'chatgpt'],
    ['gpt-5.6-sol', 'chatgpt'],
    ['gpt-5.6-terra', 'chatgpt'],
    ['gpt-5.6-luna', 'chatgpt'],
    ['gpt-5.6-cyber', 'chatgpt'],
    ['daybreak-red', 'chatgpt'],
    ['daybreak-blue', 'chatgpt'],
    // Anthropic — fable/mythos are frontier families outside the opus/sonnet/haiku tiers.
    ['claude-fable-5-1', 'claude'],
    ['claude-opus-5', 'claude'],
    ['claude-opus-5[1m]', 'claude'],
    ['claude-sonnet-5', 'claude'],
    ['claude-haiku-4-5-20251001', 'claude'],
    ['anthropic.claude-opus-5', 'claude'],
    // Google
    ['gemini-3.8-flash', 'gemini'],
    ['gemini-3.1-pro-preview', 'gemini'],
    ['gemini-3.5-flash-lite', 'gemini'],
  ])('%s -> %s', (model, expected) => {
    expect(providerFromModelId(model)).toBe(expected);
  });

  it('returns null for an unknown vendor rather than guessing', () => {
    expect(providerFromModelId('mistral-large-3')).toBeNull();
    expect(providerFromModelId(undefined)).toBeNull();
  });
});

describe('agent/host attribution', () => {
  it.each([
    ['claude-code', 'claude'],
    ['antigravity', 'gemini'],
    ['codex', 'chatgpt'],
    ['chatgpt-desktop', 'chatgpt'],
  ])('%s -> %s', (agent, expected) => {
    expect(providerFromAgentName(agent)).toBe(expected);
  });
});

describe('match patterns cannot be short enough to collide', () => {
  it('rejects the retired two-character o-series patterns', () => {
    // Regression guard: 'o1'/'o3'/'o4' were both stale AND unsafe under substring matching.
    for (const profile of Object.values(DEFAULT_PROVIDER_REGISTRY)) {
      for (const pattern of [...profile.modelPatterns, ...profile.agentPatterns]) {
        expect(pattern.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('no provider claims another provider flagship', () => {
    const flagships = ['gpt-6-astra', 'claude-fable-5-1', 'gemini-3.8-flash'];
    const owners = flagships.map(m => providerFromModelId(m));
    expect(new Set(owners).size).toBe(flagships.length);
  });
});

describe('pricing resolves for every current model', () => {
  it.each([
    'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    'gemini-3.8-flash', 'gemini-3.5-flash-lite',
  ])('%s has an exact pricing entry', (model) => {
    expect(PRICING[model]).toBeDefined();
  });

  it('resolves host-decorated and dated ids to their family rate', () => {
    expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5');
    // Dated snapshot resolves by longest-prefix match.
    expect(calculateCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0)).toBeCloseTo(1, 6);
  });

  it('prefers the more specific entry when one id prefixes another', () => {
    // gemini-3.5-flash-lite must not be priced as gemini-3.5-flash.
    expect(calculateCostUsd('gemini-3.5-flash-lite', 1_000_000, 0)).toBeCloseTo(0.30, 6);
    expect(calculateCostUsd('gemini-3.5-flash', 1_000_000, 0)).toBeCloseTo(1.50, 6);
  });

  it('prices Claude Opus 5 at its documented rate', () => {
    // Guard against a transcription error: Opus 5 is $5/$25, not Fable's $10/$50.
    expect(calculateCostUsd('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
  });

  it('does not treat a cloud Gemma model as a free local model', () => {
    expect(providerFromModelId('gemma-3-27b')).toBe('gemini');
  });
});

describe('window budgets come from configuration', () => {
  afterEach(() => {
    delete process.env.CLAUDE_WINDOW_BUDGET;
    __resetProviderRegistry();
  });

  it('defaults to null so no cycle metric is invented', () => {
    for (const profile of Object.values(getProviderRegistry())) {
      expect(profile.windowBudget).toBeNull();
    }
  });

  it('reads a budget from env without mutating the module defaults', () => {
    process.env.CLAUDE_WINDOW_BUDGET = '250';
    __resetProviderRegistry();
    expect(getProviderRegistry().claude.windowBudget).toBe(250);

    delete process.env.CLAUDE_WINDOW_BUDGET;
    __resetProviderRegistry();
    // A shallow registry copy would leave 250 stuck here forever.
    expect(getProviderRegistry().claude.windowBudget).toBeNull();
  });
});
