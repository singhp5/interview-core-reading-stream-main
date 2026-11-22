// Tier 3: exact p95 by nearest rank, sorted[ceil(0.95 * n) - 1].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type Config, type Reading } from '../src/index.ts';
import { p95 } from '../src/window.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

/** 1..n in a scrambled (but fixed) order. */
const scrambled = (n: number) => Array.from({ length: n }, (_, i) => ((i * 37) % n) + 1);

test('one value is its own p95', () => {
  assert.equal(p95([7]), 7);
});

test('nearest rank: picks the ceil(0.95 n)-th smallest value', () => {
  assert.equal(p95(scrambled(20)), 19); // rank 19
  assert.equal(p95(scrambled(21)), 20); // rank ceil(19.95) = 20
  assert.equal(p95(scrambled(100)), 95); // rank 95
  assert.equal(p95([5, 1]), 5); // rank ceil(1.9) = 2
});

test('when 0.95 n is a whole number, that rank is used, not the next one', () => {
  assert.equal(p95(scrambled(60)), 57);
  assert.equal(p95(scrambled(140)), 133);
});

test('sorts numerically, not as strings', () => {
  assert.equal(p95([10, 9, -5, 100, 2]), 100);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => (i === 0 ? 100 : i))), 19);
});

test('summarize reports p95 per window, from accepted readings only', () => {
  const readings: Reading[] = scrambled(20).map((v, i) => ({ deviceId: 'a', ts: 1_000 + i, seq: i, value: v }));
  readings.push({ deviceId: 'a', ts: 2_000, seq: 99, value: 999 }); // invalid, must not count
  readings.push({ deviceId: 'a', ts: 2_000, seq: 3, value: 120 }); // duplicate, must not count
  const [w] = summarize(readings, config);
  assert.equal(w.count, 20);
  assert.equal(w.p95, 19);
});

test('does not reorder the window values it is given', () => {
  const values = [3, 1, 2];
  p95(values);
  assert.deepEqual(values, [3, 1, 2]);
});
