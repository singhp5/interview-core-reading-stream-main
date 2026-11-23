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
export type StreamStats = { devices: number; openWindows: number; seenSeqs: number; heldValues: number };

/**
 * One device's open windows. `starts[head..]` holds their starts in ascending order,
 * so the oldest window is always at the front and closing never scans the rest.
 */
type OpenWindows = { aggs: Map<number, WindowAgg>; starts: number[]; head: number };

/** Compact `starts` once this many closed entries have built up at the front. */
const COMPACT_AFTER = 32;

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
 * running totals plus its values, for the exact p95), and the seqs within the
 * lateness horizon. None of it grows with how long the stream runs. See `NOTES.md`
 * for the argument and its limits.
 *
 * Time per reading: O(1) amortized to close windows, since they're kept in start
 * order and only the front is checked. Opening a window older than the newest open
 * one is a sorted insert, O(open windows) in the worst case; with readings nearly
 * in order that's rare, and it's an append otherwise.
 */
export function createStream(config: Config): Stream & { stats(): StreamStats } {
  const { windowMs, maxLatenessMs } = config;
  const acceptor = createAcceptor(config, { prune: true });
  const open = new Map<string, OpenWindows>();
  let ended = false;

  function checkNotEnded(): void {
    // After end() every window has been emitted; carrying on would emit some twice.
    if (ended) throw new Error('stream has already ended');
  }

  /** Add `start` to `w.starts`, keeping it sorted. Usually an append. */
  function insertStart(w: OpenWindows, start: number): void {
    const { starts } = w;
    if (starts.length === w.head || start > starts[starts.length - 1]) {
      starts.push(start);
      return;
    }
    let lo = w.head;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    starts.splice(lo, 0, start);
  }

  return {
    push(reading) {
      checkNotEnded();
      if (acceptor.offer(reading) !== 'accepted') return [];
      const { deviceId, ts } = reading;

      let w = open.get(deviceId);
      if (!w) open.set(deviceId, (w = { aggs: new Map(), starts: [], head: 0 }));
      const start = windowStartOf(ts, windowMs);
      let agg = w.aggs.get(start);
      if (!agg) {
        w.aggs.set(start, (agg = newAgg()));
        // A NaN ts gives a NaN window, which can never pass the close check below.
        // Kept out of the sorted list so it can't block the windows behind it; it
        // comes out at end(), as it would from summarize.
        if (!Number.isNaN(start)) insertStart(w, start);
      }
      addValue(agg, reading.value as number);

      // Close windows from the oldest up, until one is still reachable. They come out
      // in start order, which is already the output order for one device.
      const horizon = acceptor.newest(deviceId) - maxLatenessMs;
      const closed: WindowSummary[] = [];
      while (w.head < w.starts.length && w.starts[w.head] + windowMs <= horizon) {
        const s = w.starts[w.head++];
        closed.push(toSummary(deviceId, s, w.aggs.get(s)!));
        w.aggs.delete(s);
      }
      if (w.head >= COMPACT_AFTER && w.head * 2 >= w.starts.length) {
        w.starts = w.starts.slice(w.head);
        w.head = 0;
      }
      return closed;
    },

    end() {
      checkNotEnded();
      ended = true;
      const out: WindowSummary[] = [];
      for (const [deviceId, w] of open) {
        for (const [s, agg] of w.aggs) out.push(toSummary(deviceId, s, agg));
      }
      open.clear();
      return out.sort(compareSummaries);
    },

    stats() {
      let openWindows = 0;
      let heldValues = 0;
      for (const w of open.values()) {
        openWindows += w.aggs.size;
        for (const agg of w.aggs.values()) heldValues += agg.values.length;
      }
      return { ...acceptor.stats(), openWindows, heldValues };
    },
  };
}
