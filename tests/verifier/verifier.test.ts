import { describe, expect, it } from '@jest/globals';
import { verify, VerifyConstraints, VerifyResult } from '../../src/verifier/index.js';

describe('Verifier', () => {
  interface TestCase {
    name: string;
    answer: string;
    samples: string[];
    constraints: VerifyConstraints;
    expectedFlagsByLevel: Record<number, string[]>;
  }

  const cases: TestCase[] = [
    {
      name: 'Clean answer',
      answer: 'clean',
      samples: ['clean', 'clean', 'clean'],
      constraints: { formatRe: /clean/ },
      expectedFlagsByLevel: {
        0: [],
        1: [],
        2: [],
        3: [],
        4: [],
        5: ['always_escalate']
      }
    },
    {
      name: 'Hedged answer',
      answer: 'I think it is clean',
      samples: ['I think it is clean', 'I think it is clean', 'I think it is clean'],
      constraints: { formatRe: /clean/ },
      expectedFlagsByLevel: {
        0: [],
        1: [],
        2: [],
        3: ['hedging'],
        4: ['hedging'],
        5: ['hedging', 'always_escalate']
      }
    },
    {
      name: 'Disagreeing samples',
      answer: 'clean',
      samples: ['sample A', 'sample B', 'sample C'],
      constraints: { formatRe: /clean/ },
      expectedFlagsByLevel: {
        0: [],
        1: [],
        2: [],
        3: [],
        4: ['disagreement'],
        5: ['disagreement', 'always_escalate']
      }
    }
  ];

  describe('Table-driven exact { escalate, flags } assertions', () => {
    for (const testCase of cases) {
      for (let level = 0; level <= 5; level++) {
        it(`should verify '${testCase.name}' correctly at level ${level}`, () => {
          const result = verify(testCase.answer, testCase.samples, testCase.constraints, level);
          const expectedFlags = testCase.expectedFlagsByLevel[level];
          const expectedEscalate = expectedFlags.length > 0;

          expect(result).toEqual({
            escalate: expectedEscalate,
            level: level,
            flags: expectedFlags
          });
        });
      }
    }
  });

  describe('Monotonicity constraint', () => {
    it('ensures escalation count is non-decreasing over levels for all inputs', () => {
      for (const testCase of cases) {
        let prevCount = -1;
        for (let level = 0; level <= 5; level++) {
          const result = verify(testCase.answer, testCase.samples, testCase.constraints, level);
          expect(result.flags.length).toBeGreaterThanOrEqual(prevCount);
          prevCount = result.flags.length;
        }
      }
    });
  });
  
  describe('Additional base assertions', () => {
    it('escalates on empty output at level 1+', () => {
      const result = verify('   ', ['   '], {}, 1);
      expect(result.escalate).toBe(true);
      expect(result.flags).toContain('empty');
    });

    it('escalates on format failure at level 2+', () => {
      const result = verify('bad', ['bad'], { formatRe: /good/ }, 2);
      expect(result.escalate).toBe(true);
      expect(result.flags).toContain('format_mismatch');
    });
  });
});
