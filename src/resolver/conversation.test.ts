/**
 * @fileoverview The resolver with conversation memory (slice 4): the extraction prompt carries the summary and
 * tells the brain not to list decisions already made; a "Decided" line that settles a question pre-fills it as
 * a recommendation (source 'conversation', confidence 0.6) and is never auto-applied; without memory the
 * prompts are byte-for-byte what they were. Fake brain, no files.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SLM } from '../models/slm.js';
import { extractAmbiguities, resolveAmbiguities } from './index.js';

let slm: jest.Mocked<SLM>;
const fsRead = jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue([]);
const question = { id: 'q1', question: 'Which test runner should the new module use?', kind: 'tooling' };
const summary = 'Goal: add a module\nDecided:\n- Tests use Jest, never Vitest\nIn play:\n- src/new.ts';

beforeEach(() => {
  slm = { generateJSON: jest.fn(), generateText: jest.fn(), streamText: jest.fn() } as any;
  fsRead.mockClear();
});

describe('extraction with the conversation so far', () => {
  it('puts the summary in the prompt with the instruction not to repeat settled decisions', async () => {
    slm.generateJSON.mockResolvedValueOnce({ decisions: [] });
    await extractAmbiguities({ slm: slm, skillText: 'skill', task: 'task', conversation: summary });
    const prompt = String(slm.generateJSON.mock.calls[0][0].prompt);
    expect(prompt.startsWith('Conversation so far (do NOT list a decision it has already made):\n' + summary)).toBe(true);
  });

  it('is byte-for-byte the old prompt when there is no memory', async () => {
    slm.generateJSON.mockResolvedValueOnce({ decisions: [] }).mockResolvedValueOnce({ decisions: [] });
    await extractAmbiguities({ slm: slm, skillText: 'skill', task: 'task' });
    await extractAmbiguities({ slm: slm, skillText: 'skill', task: 'task', conversation: null });
    const [a, b] = slm.generateJSON.mock.calls.map(c => String(c[0].prompt));
    expect(a).toBe(b);
    expect(a.startsWith('Extract concrete open decisions')).toBe(true);
  });
});

describe('Decided lines pre-fill, never auto-apply', () => {
  it('offers a settled question as a recommendation with provenance, under askUser, and reads no file', async () => {
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })                     // extract
      .mockResolvedValueOnce({ answered: true, answer: 'Jest' })            // Decided line settles it
      .mockResolvedValueOnce({ risk: 'reversible' });                       // risk gate: even the lowest risk
    const out = await resolveAmbiguities({ slm: slm, fsRead: fsRead, skillText: 'skill', task: 'task', conversation: summary, decided: ['Tests use Jest, never Vitest'] });
    expect(out.autoApplied).toHaveLength(0);
    expect(out.askUser).toHaveLength(1);
    expect(out.askUser[0].recommendedAnswer).toBe('Jest');
    expect(out.askUser[0].provenance).toBe('conversation memory');
    expect(fsRead).not.toHaveBeenCalled();
  });

  it('falls through to the usual paths when no Decided line settles the question', async () => {
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })
      .mockResolvedValueOnce({ answered: false, answer: '' })
      .mockResolvedValueOnce({ answer: 'Jest', options: ['Vitest'] })       // convention path
      .mockResolvedValueOnce({ risk: 'low' });
    const out = await resolveAmbiguities({ slm: slm, fsRead: fsRead, skillText: 'skill', task: 'task', conversation: summary, decided: ['Unrelated decision'] });
    expect(out.askUser[0].provenance).toBeUndefined();
  });
});
