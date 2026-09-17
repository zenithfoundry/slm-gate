/**
 * Spec tests for human-readable duration rendering.
 *
 * The bug this exists to prevent is the one that started this work: a cycle metric that
 * read '0.18934' and required the reader to multiply by 60 before it meant anything.
 */

import { describe, it, expect } from '@jest/globals';
import { formatDuration } from './duration.js';

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds with one decimal', () => {
    // 0.18934 minutes — the figure that was unreadable on the dashboard.
    expect(formatDuration(0.18934 * 60)).toBe('11.4s');
    expect(formatDuration(0.09744 * 60)).toBe('5.8s');
  });

  it('drops a trailing zero rather than printing 12.0s', () => {
    expect(formatDuration(12)).toBe('12s');
  });

  it('renders a minute or more as minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m 00s');
    expect(formatDuration(252)).toBe('4m 12s');
  });

  it('pads the seconds so columns line up', () => {
    expect(formatDuration(305)).toBe('5m 05s');
  });

  it('carries instead of rendering a 60th second', () => {
    // 299.6s floors to 4 minutes and rounds to 60 seconds, which would read '4m 60s'.
    expect(formatDuration(299.6)).toBe('5m 00s');
  });

  it('renders an hour or more as hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h 00m');
    expect(formatDuration(3723)).toBe('1h 02m');
    // A fully freed 5-hour window.
    expect(formatDuration(300 * 60)).toBe('5h 00m');
  });

  it('carries instead of rendering a 60th minute', () => {
    expect(formatDuration(3599.7)).toBe('1h 00m');
    expect(formatDuration(7199)).toBe('2h 00m');
  });

  it('renders nothing-saved and unmeasurable inputs as 0s rather than NaN', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(Infinity)).toBe('0s');
  });
});
