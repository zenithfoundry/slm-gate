import { jest } from '@jest/globals';
import { extractAmbiguities, resolveEach, gateDecisions, resolveAmbiguities, prepareSkillContext } from './index.js';
import { estimateTokens } from '../utils/elision.js';

describe('prepareSkillContext (the skill text one resolver prompt may hold)', () => {
  const section = (title: string, lines: number) => [`## ${title}`, ...Array.from({ length: lines }, (_, i) => `${title} body line ${i} with some words in it`)].join('\n');
  const long = ['# Skill', 'intro line', section('Steps', 120), section('Rules', 120), section('Notes', 120)].join('\n');

  it('returns a short skill unchanged', () => {
    const out = prepareSkillContext('# Small\none line', 3000);
    const tokEst = estimateTokens('# Small\none line');
    expect(out).toEqual({ text: '# Small\none line', tokEst, originalTokEst: tokEst, trimmed: false });
  });

  it('trims a long skill under the budget and keeps every heading', () => {
    const budget = 400;
    const out = prepareSkillContext(long, budget);
    expect(out.trimmed).toBe(true);
    expect(out.tokEst).toBe(estimateTokens(out.text));
    expect(out.originalTokEst).toBe(estimateTokens(long));
    expect(out.tokEst).toBeLessThanOrEqual(budget + 20);
    for (const heading of ['# Skill', '## Steps', '## Rules', '## Notes']) expect(out.text).toContain(heading);
    expect(out.text).toContain('Notes body line 0');
    expect(out.text).toContain('…');
  });

  it('gives each section its own share instead of only the head of the document', () => {
    const out = prepareSkillContext(long, 400);
    expect(out.text).not.toContain('Steps body line 119');
    expect(out.text).toContain('Rules body line 0');
  });
});
import { SLM } from '../models/slm.js';
import { ResolvedItem } from './types.js';
import { CONFIG } from '../config.js';

describe('Resolver Module', () => {
  let mockSlm: jest.Mocked<SLM>;
  
  beforeEach(() => {
    mockSlm = {
      generateJSON: jest.fn(),
      generateText: jest.fn(),
      streamText: jest.fn()
    } as any;
  });

  describe('extractAmbiguities', () => {
    it('should extract decisions using the brain model', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({
        decisions: [{ id: '1', question: 'Use React?', kind: 'framework' }]
      });

      const result = await extractAmbiguities(mockSlm, 'Some skill', 'Some task');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('resolveEach', () => {
    it('should use evidence when repoRoot is set and patterns match', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({ patterns: ['package.json'] });
      mockSlm.generateJSON.mockResolvedValueOnce({ answer: 'React', options: ['Vue'] }); // For answering from evidence

      const fsRead = jest.fn<import('./index.js').FsReadFn>().mockResolvedValue(['{"dependencies":{"react":"*"}}']);
      
      const result = await resolveEach(mockSlm, fsRead, [{ id: '1', question: 'React?', kind: 'fw' }], '/repo');
      
      expect(result[0].confidence).toBeGreaterThanOrEqual(0.9);
      expect(result[0].source).toBe('evidence');
      expect(result[0].answer).toBe('React');
    });
  });

  describe('gateDecisions', () => {
    it('should put high confidence low risk items in autoApplied', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({ risk: 'low' });

      const items: ResolvedItem[] = [
        { id: '1', question: 'Q?', answer: 'A', confidence: 0.9, source: 'evidence' }
      ];

      const result = await gateDecisions(mockSlm, items);
      
      expect(result.autoApplied).toHaveLength(1);
      expect(result.askUser).toHaveLength(0);
      expect(result.autoApplied[0].id).toBe('1');
    });

    it('should ALWAYS put security items in askUser, regardless of confidence', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({ risk: 'security' });

      const items: ResolvedItem[] = [
        { id: '1', question: 'Q?', answer: 'A', confidence: 0.99, source: 'evidence' }
      ];

      const result = await gateDecisions(mockSlm, items);
      
      expect(result.autoApplied).toHaveLength(0);
      expect(result.askUser).toHaveLength(1);
      expect(result.askUser[0].id).toBe('1');
    });

    it('should ALWAYS put destructive items in askUser, regardless of confidence', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({ risk: 'destructive' });

      const items: ResolvedItem[] = [
        { id: '1', question: 'Q?', answer: 'A', confidence: 0.99, source: 'evidence' }
      ];

      const result = await gateDecisions(mockSlm, items);
      
      expect(result.autoApplied).toHaveLength(0);
      expect(result.askUser).toHaveLength(1);
    });

    it('should put low confidence low risk items in askUser', async () => {
      mockSlm.generateJSON.mockResolvedValueOnce({ risk: 'low' });

      const items: ResolvedItem[] = [
        { id: '1', question: 'Q?', answer: 'A', confidence: 0.5, source: 'convention' }
      ];

      const result = await gateDecisions(mockSlm, items);
      
      expect(result.autoApplied).toHaveLength(0);
      expect(result.askUser).toHaveLength(1);
    });
  });
});
