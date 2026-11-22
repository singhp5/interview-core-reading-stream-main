import type { WindowSummary } from './types.ts';

/** Start of the tumbling window that `ts` falls in. `+ 0` turns a `-0` into `0`. */
export function windowStartOf(ts: number, windowMs: number): number {
  return Math.floor(ts / windowMs) * windowMs + 0;
}

/**
 * Running totals for one device's window, plus its values for the exact p95.
 * The values make it O(readings in the window), not constant; see `NOTES.md`.
 */
export type WindowAgg = { count: number; min: number; max: number; sum: number; values: number[] };

export function newAgg(): WindowAgg {
  return { count: 0, min: Infinity, max: -Infinity, sum: 0, values: [] };
}

export function addValue(agg: WindowAgg, value: number): void {
  agg.count++;
  if (value < agg.min) agg.min = value;
  if (value > agg.max) agg.max = value;
  agg.sum += value;
  agg.values.push(value);
}

/**
 * Exact 95th percentile by the nearest-rank method: the smallest value with at least
 * 95% of the values at or below it, i.e. `sorted[ceil(0.95 * n) - 1]`. Always one of
 * the actual values. The rank is computed as `95 * n / 100` so it's exact whenever
 * `0.95 * n` is a whole number (a plain `0.95 * n` happens to be fine too, for n up to 1e7).
 */
export function p95(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil((95 * sorted.length) / 100) - 1];
}

export function toSummary(deviceId: string, windowStart: number, agg: WindowAgg): WindowSummary {
  return {
    deviceId,
    windowStart,
    count: agg.count,
    min: agg.min,
    max: agg.max,
    avg: agg.sum / agg.count,
    p95: p95(agg.values),
  };
}

/** Plain string comparison (not `localeCompare`), as the README asks. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order for output: `deviceId`, then `windowStart`. */
export function compareSummaries(a: WindowSummary, b: WindowSummary): number {
  return compareIds(a.deviceId, b.deviceId) || a.windowStart - b.windowStart;
}
