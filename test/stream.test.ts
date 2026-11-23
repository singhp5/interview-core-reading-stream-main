import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStream, summarize, type Config, type Reading, type WindowSummary } from '../src/index.ts';
import { generate } from '../scripts/generate.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 1_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({ deviceId, ts, seq, value });

/** mulberry32, so random tests are reproducible from a seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Messier than scripts/generate.ts: resends with a different value, resends of
 * invalid readings, heavy reordering, and very late arrivals, so every rule fires.
 */
function messy(seed: number, devices: number, perDevice: number): Reading[] {
  const rand = prng(seed);
  const arrivals: { at: number; reading: Reading }[] = [];
  for (let d = 0; d < devices; d++) {
    const deviceId = `d${d}`;
    for (let seq = 0; seq < perDevice; seq++) {
      const ts = seq * 700 + Math.floor(rand() * 500);
      const p = rand();
      const value = p < 0.03 ? null : p < 0.05 ? 500 : p < 0.06 ? NaN : Math.round(rand() * 1000) / 10;
      const delay = rand() < 0.05 ? 3_000 + rand() * 20_000 : rand() * 4_000;
      arrivals.push({ at: ts + delay, reading: { deviceId, ts, seq, value } });
      if (rand() < 0.08) {
        arrivals.push({ at: ts + delay + rand() * 10_000, reading: { deviceId, ts, seq, value: rand() * 50 } });
      }
    }
  }
  arrivals.sort((a, b) => a.at - b.at);
  return arrivals.map((a) => a.reading);
}

/** Run a stream over `readings`, checking each window comes out once. Returns them sorted. */
function runStream(readings: Reading[], cfg: Config): WindowSummary[] {
  const stream = createStream(cfg);
  const out: WindowSummary[] = [];
  for (const reading of readings) out.push(...stream.push(reading));
  out.push(...stream.end());

  const keys = out.map((w) => `${w.deviceId}@${w.windowStart}`);
  assert.equal(new Set(keys).size, keys.length, 'a window came out more than once');
  return out.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.windowStart - b.windowStart));
}

function assertSameWindows(actual: WindowSummary[], expected: WindowSummary[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const { avg, ...rest } = actual[i];
    const { avg: wantAvg, ...wantRest } = expected[i];
    assert.deepEqual(rest, wantRest);
    assert.ok(Math.abs(avg - wantAvg) <= 1e-9, `avg ${avg} vs ${wantAvg}`);
  }
}

test('gives the same windows as summarize on generated data', () => {
  for (const seed of [1, 7, 42]) {
    const readings = generate({ seed, devices: 5, minutes: 10 });
    assertSameWindows(runStream(readings, config), summarize(readings, config));
  }
});

test('gives the same windows as summarize on messy data, across window/lateness ratios', () => {
  const configs: Config[] = [
    config,
    { ...config, windowMs: 2_000 }, // many open windows at once
    { ...config, windowMs: 1_000, maxLatenessMs: 0 }, // nothing out of order is accepted
    { ...config, windowMs: 3_000, maxLatenessMs: 12_000 },
  ];
  for (const cfg of configs) {
    for (const seed of [3, 11, 99]) {
      const readings = messy(seed, 4, 2_000);
      const expected = summarize(readings, cfg);
      assert.ok(expected.length > 0);
      assertSameWindows(runStream(readings, cfg), expected);
    }
  }
});

test('a window closes exactly when the newest accepted ts is maxLatenessMs past its end', () => {
  const stream = createStream(config);
  assert.deepEqual(stream.push(r('a', 1_000, 1)), []);
  assert.deepEqual(stream.push(r('a', 64_999, 2)), []); // a reading at 59 999 could still arrive
  assert.deepEqual(stream.push(r('a', 65_000, 3)), [{ deviceId: 'a', windowStart: 0, count: 1, min: 1, max: 1, avg: 1, p95: 1 }]);
  assert.deepEqual(stream.end(), [{ deviceId: 'a', windowStart: 60_000, count: 2, min: 2, max: 3, avg: 2.5, p95: 3 }]);
});

test('dropped readings never close a window', () => {
  const stream = createStream(config);
  stream.push(r('a', 1_000, 1, 1));
  assert.deepEqual(stream.push(r('a', 500_000, null)), []); // invalid
  assert.deepEqual(stream.push(r('a', 500_000, 5, 1)), []); // duplicate of seq 1
  assert.equal(stream.end().length, 1);
});

test('a quiet device keeps its windows open while others move on', () => {
  const stream = createStream(config);
  stream.push(r('a', 1_000, 1));
  for (let t = 0; t < 600_000; t += 1_000) {
    for (const w of stream.push(r('b', t, 1))) assert.equal(w.deviceId, 'b');
  }
  const rest = stream.end();
  assert.deepEqual(
    rest.map((w) => w.deviceId),
    ['a', 'b'],
  );
});

test('a window can collect several out-of-order readings before it closes', () => {
  const stream = createStream({ ...config, windowMs: 10_000 });
  assert.deepEqual(stream.push(r('a', 12_000, 4)), []);
  assert.deepEqual(stream.push(r('a', 9_000, 2)), []);
  assert.deepEqual(stream.push(r('a', 7_500, 6)), []);
  assert.deepEqual(stream.push(r('a', 15_000, 1)), [{ deviceId: 'a', windowStart: 0, count: 2, min: 2, max: 6, avg: 4, p95: 6 }]);
});

test('memory stays bounded over a long run', () => {
  const devices = 3;
  const cfg = { ...config, windowMs: 2_000 };
  const stream = createStream(cfg);
  const rand = prng(5);
  const total = 1_000_000;
  const peaks: StreamPeak[] = [];
  let peak: StreamPeak = { openWindows: 0, seenSeqs: 0, heldValues: 0 };
  let emitted = 0;

  // Lazily make readings 1 s apart per device, shuffled in blocks so they arrive out of
  // order (some up to ~20 s late), with resends and invalid values mixed in.
  const block: Reading[] = [];
  let seq = 0;
  let produced = 0;
  const flush = () => {
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    for (const reading of block) {
      emitted += stream.push(reading).length;
      const s = stream.stats();
      if (s.openWindows > peak.openWindows) peak.openWindows = s.openWindows;
      if (s.seenSeqs > peak.seenSeqs) peak.seenSeqs = s.seenSeqs;
      if (s.heldValues > peak.heldValues) peak.heldValues = s.heldValues;
    }
    block.length = 0;
  };
  while (produced < total) {
    for (let d = 0; d < devices; d++) {
      const reading: Reading = { deviceId: `d${d}`, ts: seq * 1_000, seq, value: rand() < 0.01 ? null : rand() * 50 };
      block.push(reading);
      if (rand() < 0.02) block.push({ ...reading });
      produced++;
    }
    seq++;
    if (block.length >= 60) flush();
    if (produced % (total / 10) < devices) peaks.push({ ...peak });
  }
  flush();

  // Open windows per device: at most ceil(maxLatenessMs / windowMs) + 1.
  const windowBound = devices * (Math.ceil(cfg.maxLatenessMs / cfg.windowMs) + 1);
  assert.ok(peak.openWindows <= windowBound, `open windows peaked at ${peak.openWindows} > ${windowBound}`);
  // Values held for p95: readings are 1 s apart, so at most 2 accepted per 2 s window.
  assert.ok(peak.heldValues <= windowBound * 2, `held values peaked at ${peak.heldValues}`);
  // Seen seqs: a small constant per device (live horizon plus prune slack), not ~333k each.
  assert.ok(peak.seenSeqs <= devices * 256, `seen seqs peaked at ${peak.seenSeqs}`);
  // And the peak is reached early: after 10x more readings it has barely moved. A stream that
  // kept every reading or seq would be ~10x bigger by the end.
  const early = peaks[1];
  const late = peaks.at(-1)!;
  assert.ok(late.openWindows <= early.openWindows * 1.5, `open windows grew ${early.openWindows} -> ${late.openWindows}`);
  assert.ok(late.seenSeqs <= early.seenSeqs * 1.5, `seen seqs grew ${early.seenSeqs} -> ${late.seenSeqs}`);
  assert.ok(late.heldValues <= early.heldValues * 1.5, `held values grew ${early.heldValues} -> ${late.heldValues}`);
  assert.ok(emitted > 100_000);
});

type StreamPeak = { openWindows: number; seenSeqs: number; heldValues: number };

test('push and end after end() throw, so no window can come out twice', () => {
  const stream = createStream(config);
  stream.push(r('a', 1_000, 1));
  assert.equal(stream.end().length, 1);
  assert.throws(() => stream.push(r('a', 2_000, 2)), /already ended/);
  assert.throws(() => stream.end(), /already ended/);
});

test('closes windows in start order, even when they opened out of order', () => {
  const cfg = { ...config, windowMs: 1_000, maxLatenessMs: 10_000 };
  const stream = createStream(cfg);
  // Windows open as 9 s, 5 s, 7 s, 2 s; all four are closed by the reading at 20 s.
  for (const ts of [9_000, 5_000, 7_000, 2_000]) assert.deepEqual(stream.push(r('a', ts, 1)), []);
  assert.deepEqual(
    stream.push(r('a', 20_000, 1)).map((w) => w.windowStart),
    [2_000, 5_000, 7_000, 9_000],
  );
});

test('a NaN timestamp does not stop later windows from closing', () => {
  const readings = [r('a', NaN, 1), r('a', 1_000, 2), r('a', 70_000, 3)];
  const stream = createStream(config);
  assert.deepEqual(stream.push(readings[0]), []);
  assert.deepEqual(stream.push(readings[1]), []);
  assert.deepEqual(
    stream.push(readings[2]).map((w) => w.windowStart),
    [0],
  );
  const rest = stream.end();
  assert.equal(rest.length, 2);
  assert.ok(rest.some((w) => Number.isNaN(w.windowStart)));
  assert.equal(summarize(readings, config).length, 3);
});

test('time per reading does not grow with maxLatenessMs / windowMs', () => {
  // With L/W = 3600 a device has ~3600 open windows; closing must not scan them all.
  const time = (cfg: Config) => {
    const stream = createStream(cfg);
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) stream.push({ deviceId: 'a', ts: i * 1_000, seq: i, value: 1 });
    return performance.now() - t0;
  };
  time(config); // warm up
  const small = time(config);
  const large = time({ ...config, windowMs: 1_000, maxLatenessMs: 3_600_000 });
  // Before the fix this ratio was ~160x. Allow plenty of slack for noisy machines.
  assert.ok(large < small * 10 + 200, `L/W = 3600 took ${large.toFixed(0)} ms vs ${small.toFixed(0)} ms`);
});
