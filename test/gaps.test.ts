import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGaps, type Config, type Reading } from '../src/index.ts';
import { generate } from '../scripts/generate.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 1_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({ deviceId, ts, seq, value });

test('no readings, or one reading, gives no gaps', () => {
  assert.deepEqual(detectGaps([], config), []);
  assert.deepEqual(detectGaps([r('a', 1_000, 1)], config), []);
});

test('exactly gapMs apart is not a gap; one more ms is', () => {
  assert.deepEqual(detectGaps([r('a', 0, 1), r('a', 10_000, 1)], config), []);
  assert.deepEqual(detectGaps([r('a', 0, 1), r('a', 10_001, 1)], config), [{ deviceId: 'a', start: 0, end: 10_001 }]);
});

test('uses ts order, not arrival order', () => {
  // Arrives 20 s, 16 s, 4 s, 0 s; in ts order the only gap is 4 s -> 16 s.
  const readings = [r('a', 20_000, 1), r('a', 16_000, 1), r('a', 4_000, 1), r('a', 0, 1)];
  assert.deepEqual(detectGaps(readings, { ...config, maxLatenessMs: 100_000 }), [
    { deviceId: 'a', start: 4_000, end: 16_000 },
  ]);
});

test('dropped readings do not fill a gap', () => {
  const readings = [
    r('a', 0, 1),
    r('a', 6_000, null), // invalid
    r('a', 20_000, 1),
    r('a', 12_000, 1), // too late: 8 s behind 20 s
  ];
  assert.deepEqual(detectGaps(readings, config), [{ deviceId: 'a', start: 0, end: 20_000 }]);
});

test('sorted by deviceId (plain string order), then start', () => {
  const readings = [
    r('b', 0, 1),
    r('b', 20_000, 1),
    r('a', 0, 1),
    r('a', 20_000, 1),
    r('a', 40_000, 1),
    r('B', 0, 1),
    r('B', 20_000, 1),
  ];
  assert.deepEqual(
    detectGaps(readings, config).map((g) => [g.deviceId, g.start]),
    [
      ['B', 0],
      ['a', 0],
      ['a', 20_000],
      ['b', 0],
    ],
  );
});

test('finds the one planned silence per device in generated data', () => {
  // The generator silences each device once for 15-30 s; readings are ~1 s apart otherwise,
  // with late arrivals occasionally dropped, which can't open a 10 s hole on their own.
  const gaps = detectGaps(generate({ seed: 7, devices: 5, minutes: 10 }), config);
  assert.deepEqual(
    gaps.map((g) => g.deviceId),
    ['dev-01', 'dev-02', 'dev-03', 'dev-04', 'dev-05'],
  );
  for (const g of gaps) assert.ok(g.end - g.start >= 15_000 && g.end - g.start <= 32_000);
});
