import type { Config, Reading, WindowSummary } from './types.ts';
import { createAcceptor } from './accept.ts';
import { addValue, compareSummaries, newAgg, toSummary, windowStartOf, type WindowAgg } from './window.ts';

/**
 * Tier 1. Clean `readings` (given in arrival order) and summarize each
 * device's accepted readings per window. See "Rules" in the README.
 */
export function summarize(readings: Reading[], config: Config): WindowSummary[] {
  const acceptor = createAcceptor(config);
  const windows = new Map<string, Map<number, WindowAgg>>();

  for (const reading of readings) {
    if (acceptor.offer(reading) !== 'accepted') continue;
    let byStart = windows.get(reading.deviceId);
    if (!byStart) windows.set(reading.deviceId, (byStart = new Map()));
    const start = windowStartOf(reading.ts, config.windowMs);
    let agg = byStart.get(start);
    if (!agg) byStart.set(start, (agg = newAgg()));
    addValue(agg, reading.value as number);
  }

  const out: WindowSummary[] = [];
  for (const [deviceId, byStart] of windows) {
    for (const [start, agg] of byStart) out.push(toSummary(deviceId, start, agg));
  }
  return out.sort(compareSummaries);
}
