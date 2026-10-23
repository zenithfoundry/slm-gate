/**
 * @fileoverview Model pinning: with both of slm-gate's models loaded nothing happens; when a model it does not
 * use has displaced one of its own, the stranger is unloaded and the missing model warmed back in; an
 * unreachable Ollama or SLM_PIN_MODELS=off is reported as skipped. A fake Ollama client records the calls.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    OLLAMA_HOST: 'http://fake',
    OLLAMA_KEEP_ALIVE: '12h',
    NUM_CTX: 8192,
    SLM_PIN_MODELS: true,
    SLM_GATE_MODEL: 'gate:3b',
    SLM_BRAIN_MODEL: 'brain:4b',
    EMBED_MODEL: 'embed',
    SEMCACHE: false,
    DISTILL_ADAPTIVE: false,
  },
}));

const { CONFIG } = await import('../../src/config.js');
const { pinModels, describePin } = await import('../../src/models/pin.js');

/**
 * A stand-in Ollama client: `loaded` is what `ps` reports; every generate call is recorded. An unload
 * (keep-alive 0) drops the model from the list, as the real server does a moment later.
 */
function fakeClient(loaded: string[]) {
  const calls: { model: string; keep_alive: unknown }[] = [];
  const list = [...loaded];
  return {
    calls,
    client: {
      ps: async () => ({ models: list.map(name => ({ name })) }),
      generate: async (req: { model: string; keep_alive?: unknown }) => {
        calls.push({ model: req.model, keep_alive: req.keep_alive });
        if (req.keep_alive === 0) list.splice(list.indexOf(req.model), 1);
        return {};
      },
    } as any,
  };
}

describe('pinModels', () => {
  it('does nothing while both models are loaded', async () => {
    const { client, calls } = fakeClient(['gate:3b', 'brain:4b']);
    const result = await pinModels(client);
    expect(result).toEqual({ resident: ['gate:3b', 'brain:4b'], warmed: [], unloaded: [], skipped: null });
    expect(calls).toEqual([]);
    expect(describePin(result)).toBeNull();
  });

  it('unloads a stranger that displaced one of its models and warms the missing one back in', async () => {
    const { client, calls } = fakeClient(['brain:4b', 'other:2b']);
    const result = await pinModels(client);
    expect(result.unloaded).toEqual(['other:2b']);
    expect(result.warmed).toEqual(['gate:3b']);
    expect(calls).toEqual([
      { model: 'other:2b', keep_alive: 0 },
      { model: 'gate:3b', keep_alive: '12h' },
    ]);
    expect(describePin(result)).toContain('unloaded other:2b');
  });

  it('treats a name without a tag as :latest when matching', async () => {
    const { client, calls } = fakeClient(['gate:3b', 'brain:4b']);
    (CONFIG as any).SLM_BRAIN_MODEL = 'brain:4b';
    await pinModels(client);
    expect(calls).toEqual([]);
  });

  it('warms a missing model without unloading anything when no stranger is loaded', async () => {
    const { client, calls } = fakeClient(['brain:4b']);
    const result = await pinModels(client);
    expect(result.unloaded).toEqual([]);
    expect(result.warmed).toEqual(['gate:3b']);
    expect(calls).toHaveLength(1);
  });

  it('reports a skipped pass when Ollama cannot be reached or the setting is off', async () => {
    const down = { ps: async () => { throw new Error('ECONNREFUSED'); }, generate: async () => ({}) } as any;
    expect((await pinModels(down)).skipped).toContain('ECONNREFUSED');
    (CONFIG as any).SLM_PIN_MODELS = false;
    expect((await pinModels(fakeClient(['x']).client)).skipped).toBe('SLM_PIN_MODELS=off');
    (CONFIG as any).SLM_PIN_MODELS = true;
  });
});
