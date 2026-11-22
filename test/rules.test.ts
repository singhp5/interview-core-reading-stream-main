// Extra Tier 1 tests for cases the given tests don't pin down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type Config, type Reading } from '../src/index.ts';
import { createAcceptor } from '../src/accept.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 1_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({ deviceId, ts, seq, value });

test('an invalid reading followed by a valid resend: both are dropped', () => {
  assert.deepEqual(summarize([r('a', 1_000, null, 7), r('a', 1_000, 5, 7), r('a', 2_000, 1)], config), [
    { deviceId: 'a', windowStart: 0, count: 1, min: 1, max: 1, avg: 1, p95: 1 },
  ]);
});

test('the resend of a reading dropped as late is dropped too', () => {
  // The original at 1 s is too late (behind 10 s), and its resend is both late and a duplicate.
  const out = summarize([r('a', 10_000, 1), r('a', 1_000, 2, 7), r('a', 1_000, 2, 7)], config);
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 1, min: 1, max: 1, avg: 1, p95: 1 }]);
});

test('a dropped duplicate does not move the newest timestamp forward', () => {
  // The duplicate at 100 s (an inconsistent resend) is dropped, so 10 s is still on time.
  const out = summarize([r('a', 9_000, 1, 7), r('a', 100_000, 2, 7), r('a', 10_000, 3)], config);
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 2, min: 1, max: 3, avg: 2, p95: 3 }]);
});

test('a late reading does not move the newest timestamp', () => {
  const out = summarize([r('a', 10_000, 1), r('a', 4_000, 1), r('a', 5_000, 1)], config);
  assert.equal(out[0].count, 2);
});

test('-Infinity is invalid', () => {
  assert.deepEqual(summarize([r('a', 1_000, -Infinity)], config), []);
});

test('reports why each reading was dropped', () => {
  const acc = createAcceptor(config);
  const verdicts = [r('a', 10_000, 1, 1), r('a', 10_000, 1, 1), r('a', 1_000, 1, 2), r('a', 11_000, 999, 3)].map((x) =>
    acc.offer(x),
  );
  assert.deepEqual(verdicts, ['accepted', 'duplicate', 'late', 'invalid']);
});

test('negative timestamps fall in the window below zero', () => {
  const out = summarize([r('a', -1, 1), r('a', 0, 2)], config);
  assert.deepEqual(
    out.map((w) => w.windowStart),
    [-60_000, 0],
  );
});

test('sorts with plain string comparison, not locale order', () => {
  const out = summarize([r('b', 1_000, 1), r('B', 1_000, 1), r('a', 1_000, 1), r('A', 1_000, 1)], config);
  assert.deepEqual(
    out.map((w) => w.deviceId),
    ['A', 'B', 'a', 'b'],
  );
});

test('several devices across several windows', () => {
  const out = summarize(
    [r('b', 61_000, 4), r('a', 1_000, 1), r('b', 1_000, 2), r('a', 62_000, 3), r('a', 63_000, 5), r('b', 2_000, 6)],
    { ...config, maxLatenessMs: 100_000 },
  );
  assert.deepEqual(out, [
    { deviceId: 'a', windowStart: 0, count: 1, min: 1, max: 1, avg: 1, p95: 1 },
    { deviceId: 'a', windowStart: 60_000, count: 2, min: 3, max: 5, avg: 4, p95: 5 },
    { deviceId: 'b', windowStart: 0, count: 2, min: 2, max: 6, avg: 4, p95: 6 },
    { deviceId: 'b', windowStart: 60_000, count: 1, min: 4, max: 4, avg: 4, p95: 4 },
  ]);
});

test('does not modify the input', () => {
  const input = [r('a', 3_000, 1), r('a', 1_000, null), r('a', 2_000, 7)];
  const copy = structuredClone(input);
  Object.freeze(input);
  input.forEach((x) => Object.freeze(x));
  summarize(input, config);
  assert.deepEqual(input, copy);
});
