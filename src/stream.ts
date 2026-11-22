import type { Config, Reading, WindowSummary } from './types.ts';
import { createAcceptor } from './accept.ts';
import { addValue, compareSummaries, newAgg, toSummary, windowStartOf, type WindowAgg } from './window.ts';

export type Stream = {
  /** Accept one reading, in arrival order. Returns any windows that just became final. */
  push(reading: Reading): WindowSummary[];
  /** The input is over. Returns every window still open. */
  end(): WindowSummary[];
};

/** What the stream is holding right now. For tests that check memory stays bounded. */
export type StreamStats = { devices: number; openWindows: number; seenSeqs: number };

/**
 * Tier 2. A streaming version of `summarize` that holds bounded memory.
 * See "Tier 2" in the README.
 *
 * A device's window `[start, start + windowMs)` is final once
 * `newest - maxLatenessMs >= start + windowMs`: from then on, any reading that
 * could land in it is more than `maxLatenessMs` behind `newest`, so it's dropped.
 * `newest` only moves on that device's accepted readings, so a quiet device keeps
 * its windows open until `end()`.
 *
 * Held per device: at most `ceil(maxLatenessMs / windowMs) + 1` open windows (each
 * a constant-size running total), and the seqs within the lateness horizon. See
 * `NOTES.md` for the argument and its limits.
 */
export function createStream(config: Config): Stream & { stats(): StreamStats } {
  const { windowMs, maxLatenessMs } = config;
  const acceptor = createAcceptor(config, { prune: true });
  const open = new Map<string, Map<number, WindowAgg>>();

  return {
    push(reading) {
      if (acceptor.offer(reading) !== 'accepted') return [];
      const { deviceId, ts } = reading;

      let byStart = open.get(deviceId);
      if (!byStart) open.set(deviceId, (byStart = new Map()));
      const start = windowStartOf(ts, windowMs);
      let agg = byStart.get(start);
      if (!agg) byStart.set(start, (agg = newAgg()));
      addValue(agg, reading.value as number);

      // Close every window of this device that no future accepted reading can reach.
      // The reading just added can't be in one: its window ends after ts >= horizon.
      const horizon = acceptor.newest(deviceId) - maxLatenessMs;
      const closed: WindowSummary[] = [];
      for (const [s, a] of byStart) {
        if (s + windowMs <= horizon) {
          closed.push(toSummary(deviceId, s, a));
          byStart.delete(s);
        }
      }
      return closed.sort(compareSummaries);
    },

    end() {
      const out: WindowSummary[] = [];
      for (const [deviceId, byStart] of open) {
        for (const [s, a] of byStart) out.push(toSummary(deviceId, s, a));
      }
      open.clear();
      return out.sort(compareSummaries);
    },

    stats() {
      let openWindows = 0;
      for (const byStart of open.values()) openWindows += byStart.size;
      return { ...acceptor.stats(), openWindows };
    },
  };
}
