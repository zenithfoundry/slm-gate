/**
 * @fileoverview Human-readable duration rendering for terminal output and reports.
 *
 * This lives apart from `minutesFreed` in pricing/providers.ts on purpose: that function
 * owns the *arithmetic*, this one owns the *presentation*, and only some consumers can use
 * it. The Langfuse dashboard cannot: a numeric score row carries `value: number` and no
 * unit field, and the card aggregates rows server-side, so there is no point at which a
 * formatted string could be attached. Anywhere we build the final string ourselves — the
 * sync summary table, the bench leaderboard — renders through here so they cannot drift.
 */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/**
 * Renders a duration in the largest unit that still reads as a real amount of time.
 *
 * Below a minute it stays in seconds with one decimal, because that is the range these
 * estimates actually live in; above it, minutes and seconds; above an hour, hours and
 * minutes. The point is that the reader never has to multiply anything.
 *
 * @param seconds Duration in seconds. Non-finite and non-positive inputs render as '0s'.
 * @returns e.g. '11.4s', '4m 12s', '1h 02m'
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';

  if (seconds < SECONDS_PER_MINUTE) {
    return `${Number(seconds.toFixed(1))}s`;
  }

  // Round to whole seconds BEFORE choosing a unit. Rounding inside each branch let 3599.7s
  // pick the minutes branch and then carry to '60m 00s' instead of '1h 00m'.
  const whole = Math.round(seconds);

  if (whole < SECONDS_PER_HOUR) {
    const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
    const remainder = whole % SECONDS_PER_MINUTE;
    return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  }

  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const remainder = Math.round((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  // The same carry one unit up: 7199s is 1h 59.98m, which rounds to a 60th minute.
  if (remainder === SECONDS_PER_MINUTE) return `${hours + 1}h 00m`;
  return `${hours}h ${String(remainder).padStart(2, '0')}m`;
}
