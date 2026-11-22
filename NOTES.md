# Notes

## What I did

- **Tier 1, `summarize`.** Done. All the given tests pass, plus `test/rules.test.ts`, which covers cases they leave open:
  - an invalid reading followed by a valid resend (the README's own example);
  - the resend of a reading that was dropped as late;
  - `-Infinity`;
  - negative `ts`;
  - sort order with mixed case;
  - several devices across several windows;
  - not modifying the input.
- **Tier 2, `detectGaps`.** Done, with tests in `test/gaps.test.ts`.
- **Tier 2, `createStream`.** Done, with tests in `test/stream.test.ts` that:
  - check its output matches `summarize` on both the provided generator and a deliberately messier one (resends with a changed value, resends of invalid readings, arrivals up to 20 s late), across four window/lateness ratios;
  - check each window comes out exactly once;
  - check a window closes at exactly the right reading, and that a quiet device keeps its windows open;
  - run a million readings and check memory stays flat. I confirmed this last test fails, holding about 1M seqs, when pruning is switched off.

**Structure.** The three drop rules live in one place, `src/accept.ts`, used by all three functions so they can't drift apart. The window helpers (running totals, sort order) are in `src/window.ts`. The exports and signatures in `src/index.ts` haven't changed. `createStream` also returns a `stats()` method, which is the test hook for checking memory.

## How the rules are applied

Each rule is "drop if true", so the order of the checks only changes which reason is reported, never whether a reading is dropped. What matters is the state:

- **Every arriving `seq` is remembered**, even when the reading is dropped.
- **Only accepted readings move the device's newest `ts`.**

## Why the stream's memory is bounded

**When a window closes.** A device's window `[s, s+W)` closes once `newest − L ≥ s + W`, where `newest` is that device's newest accepted `ts`, `L` is `maxLatenessMs` and `W` is `windowMs`. After that point, any reading that could land in the window is more than `L` behind `newest`, so it would be dropped. `newest` never goes down, so a closed window can never be reopened.

**Open windows.** Every open window satisfies `newest − L − W < s ≤ newest`, so a device has at most `ceil(L/W) + 1` of them. Each one holds a running total of constant size, not the readings themselves.

**Remembered seqs.** A resend has the same `ts` as the original, so a seq whose `ts < newest − L` can be forgotten: any resend of it would be dropped as late anyway. The map is cleared out only when it has doubled in size, so it never holds more than `max(64, 2 × the seqs within the lateness horizon)`, and the cost per reading stays O(1) on average. A reading that's already late isn't stored at all.

In the million-reading test, this works out to about 60 seqs and at most 4 open windows per device, no matter how long the run is.

## Known limits (documented rather than fixed, as agreed)

1. **Devices that never get a reading accepted.** If a device only sends invalid readings, its `newest` never moves, so nothing is ever cleared out and its seen-set keeps growing.
2. **Invalid readings with timestamps far in the future.** These sit ahead of the horizon until the device's accepted readings catch up with them.
3. **An unlimited number of devices.** State is kept per device and never removed.
4. **The memory bound depends on resends keeping the original `ts`.** If a resend came with a different `ts`, the stream could let a duplicate through that `summarize` would drop. `summarize` and `detectGaps` don't prune, so they follow the rules exactly as written whatever the timestamps.

Fixing 1–3 properly means putting a cap on what we hold, for example removing idle devices after a while or capping seqs per device. That gives up exactness: an occasional duplicate could get through. I'd want to agree that trade-off with the people consuming the data first.

## Assumptions

- `push` after `end()` isn't defined. The stream doesn't guard against it.
- Window starts use `Math.floor`, so a negative `ts` falls into the window below zero. A `-0` window start is normalized to `0`.
- Within a single `push`/`end` call, windows come back sorted, even though the README allows any order.

## What I skipped, and why

- **p95 (Tier 3).** `WindowSummary` is compared with `deepEqual` in tests, including the hidden ones you run. Adding a field, even an optional one, risks breaking those, so I'd want to agree the shape first. If we went ahead: exact p95 in `summarize` (keep each window's values), and an approximate one in the stream, using a fixed-size sketch such as a t-digest or a fixed histogram over `validRange`, since keeping every value in a window isn't bounded.

## Next, with more time

- Caps for limits 1–3 above, behind an option, with tests that show the cost in exactness.
- Property-based tests that compare the stream with `summarize` over many random seeds, instead of a handful of fixed ones.
- A `--gaps` flag on the CLI.

## AI use

I used Claude Code for this. It read the repo and summarized the rules and open questions first, then we agreed scope and a plan before any code was written. The transcript is in `transcripts/`.
