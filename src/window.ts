import type { WindowSummary } from './types.ts';

/** Start of the tumbling window that `ts` falls in. `+ 0` turns a `-0` into `0`. */
export function windowStartOf(ts: number, windowMs: number): number {
  return Math.floor(ts / windowMs) * windowMs + 0;
}

/** Running totals for one device's window. Constant size, whatever the count. */
export type WindowAgg = { count: number; min: number; max: number; sum: number };

export function newAgg(): WindowAgg {
  return { count: 0, min: Infinity, max: -Infinity, sum: 0 };
}

export function addValue(agg: WindowAgg, value: number): void {
  agg.count++;
  if (value < agg.min) agg.min = value;
  if (value > agg.max) agg.max = value;
  agg.sum += value;
}

export function toSummary(deviceId: string, windowStart: number, agg: WindowAgg): WindowSummary {
  return { deviceId, windowStart, count: agg.count, min: agg.min, max: agg.max, avg: agg.sum / agg.count };
}

/** Plain string comparison (not `localeCompare`), as the README asks. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order for output: `deviceId`, then `windowStart`. */
export function compareSummaries(a: WindowSummary, b: WindowSummary): number {
  return compareIds(a.deviceId, b.deviceId) || a.windowStart - b.windowStart;
}
