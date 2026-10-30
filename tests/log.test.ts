/**
 * @fileoverview One line per call on stderr, `level [scope] message key=value`, so greps by scope keep working
 * and values with spaces or an error's message stay on the one line.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { log } from '../src/log.js';

let lines: string[];

beforeEach(() => {
  lines = [];
  jest.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
});
afterEach(() => jest.restoreAllMocks());

describe('log', () => {
  it('writes one line with the level, the bracketed scope and the message', () => {
    log.info('mcp-gate', 'Server is running');
    expect(lines).toEqual(['info [mcp-gate] Server is running']);
  });

  it('appends fields as key=value, quoting values with spaces and an error by its message, skipping undefined', () => {
    log.warn('ledger', 'flush failed', { attempts: 3, reason: 'rate limited', error: new Error('boom'), skipped: undefined, ok: false });
    expect(lines).toEqual(['warn [ledger] flush failed attempts=3 reason="rate limited" error="boom" ok=false']);
  });

  it('keeps an object field on the same line as JSON', () => {
    log.error('llm-gate', 'bad', { page: { start: 1, end: 2 } });
    expect(lines).toEqual(['error [llm-gate] bad page={"start":1,"end":2}']);
  });
});
