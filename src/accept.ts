import type { Config, Reading } from './types.ts';

/** What happened to a reading. Only `'accepted'` readings count towards anything. */
export type Verdict = 'accepted' | 'invalid' | 'duplicate' | 'late';

export type AcceptorOptions = {
  /**
   * Forget state that can no longer change a verdict, so memory stays bounded.
   * Relies on the README's promise that a resend has the same `ts` as the original;
   * see `NOTES.md`. Off by default, so the batch functions follow the rules literally.
   */
  prune?: boolean;
};

export type Acceptor = {
  /** Decide whether `reading` is accepted, and update the state. Call in arrival order. */
  offer(reading: Reading): Verdict;
  /** Newest accepted `ts` for a device, or `-Infinity` if none yet. */
  newest(deviceId: string): number;
  /** For tests: how many devices and remembered seqs are held right now. */
  stats(): { devices: number; seenSeqs: number };
};

type DeviceState = {
  /** Newest `ts` accepted so far. Only accepted readings move it. */
  newest: number;
  /** Every `seq` seen for this device (pruned mode: only those that still matter), mapped to its `ts`. */
  seen: Map<number, number>;
  /** Pruned mode: prune again once `seen` reaches this size. */
  pruneAt: number;
};

/** Never prune below this many seqs; pruning tiny maps isn't worth the scan. */
const MIN_PRUNE_SIZE = 64;

/**
 * The accept/drop rules from the README, shared by `summarize`, `detectGaps` and
 * `createStream` so they can't drift apart.
 *
 * Every rule is "drop if true", so the order of the checks doesn't change the
 * verdict, only which reason is reported. What matters is the state updates:
 * - every arrival's `seq` is remembered, even if the reading is dropped (rule 2);
 * - only an accepted reading moves `newest` forward (rule 3).
 */
export function createAcceptor(config: Config, { prune = false }: AcceptorOptions = {}): Acceptor {
  const { maxLatenessMs } = config;
  const { min, max } = config.validRange;
  const devices = new Map<string, DeviceState>();

  function stateFor(deviceId: string): DeviceState {
    let d = devices.get(deviceId);
    if (!d) {
      d = { newest: -Infinity, seen: new Map(), pruneAt: MIN_PRUNE_SIZE };
      devices.set(deviceId, d);
    }
    return d;
  }

  /**
   * Drop seqs whose `ts` is more than `maxLatenessMs` behind `newest`. A resend of
   * one of them has the same `ts`, so it would be dropped as too late anyway.
   * Runs only when the map has doubled since the last prune, so it's amortized O(1).
   */
  function pruneSeen(d: DeviceState): void {
    const horizon = d.newest - maxLatenessMs;
    for (const [seq, ts] of d.seen) {
      if (ts < horizon) d.seen.delete(seq);
    }
    d.pruneAt = Math.max(MIN_PRUNE_SIZE, d.seen.size * 2);
  }

  return {
    offer({ deviceId, ts, seq, value }) {
      const d = stateFor(deviceId);
      const late = d.newest - ts > maxLatenessMs;

      // Pruned mode: a late reading stays late (newest only grows), and so would
      // any resend of it, so there's no need to remember its seq.
      if (prune && late) return 'late';

      const duplicate = d.seen.has(seq);
      if (!duplicate) {
        d.seen.set(seq, ts);
        if (prune && d.seen.size >= d.pruneAt) pruneSeen(d);
      }

      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return 'invalid';
      if (duplicate) return 'duplicate';
      if (late) return 'late';

      if (ts > d.newest) d.newest = ts;
      return 'accepted';
    },

    newest(deviceId) {
      return devices.get(deviceId)?.newest ?? -Infinity;
    },

    stats() {
      let seenSeqs = 0;
      for (const d of devices.values()) seenSeqs += d.seen.size;
      return { devices: devices.size, seenSeqs };
    },
  };
}
