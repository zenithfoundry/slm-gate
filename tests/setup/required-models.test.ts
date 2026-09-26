import { describe, expect, it } from '@jest/globals';
import { modelsFor } from '../../src/setup/required-models.js';

const base = { SLM_GATE_MODEL: 'gate-model', SLM_BRAIN_MODEL: 'brain-model', EMBED_MODEL: 'embed-model', SEMCACHE: false, DISTILL_ADAPTIVE: false };

describe('modelsFor', () => {
  it('needs only the two local models when nothing uses the embedding model', () => {
    expect(modelsFor(base).map(model => model.name)).toEqual(['gate-model', 'brain-model']);
  });

  it.each([
    [{ SEMCACHE: true }, 'the semantic cache'],
    [{ DISTILL_ADAPTIVE: true }, 'adaptive tool-output shrinking'],
    [{ SEMCACHE: true, DISTILL_ADAPTIVE: true }, 'the semantic cache and adaptive tool-output shrinking'],
  ])('adds the embedding model when %o, and says what it is for', (features, purpose) => {
    expect(modelsFor({ ...base, ...features })[2]).toEqual({ name: 'embed-model', setting: 'EMBED_MODEL', purpose });
  });
});
