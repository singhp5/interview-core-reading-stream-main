import type { Config, Gap, Reading } from './types.ts';
import { createAcceptor } from './accept.ts';
import { compareIds } from './window.ts';

/**
 * Tier 2. Report every gap in each device's accepted readings.
 * See "Tier 2" in the README.
 */
export function detectGaps(readings: Reading[], config: Config): Gap[] {
  const acceptor = createAcceptor(config);
  const timestamps = new Map<string, number[]>();

  for (const reading of readings) {
    if (acceptor.offer(reading) !== 'accepted') continue;
    let list = timestamps.get(reading.deviceId);
    if (!list) timestamps.set(reading.deviceId, (list = []));
    list.push(reading.ts);
  }

  const out: Gap[] = [];
  for (const [deviceId, list] of timestamps) {
    list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) {
      if (list[i] - list[i - 1] > config.gapMs) out.push({ deviceId, start: list[i - 1], end: list[i] });
    }
  }
  return out.sort((a, b) => compareIds(a.deviceId, b.deviceId) || a.start - b.start);
}
