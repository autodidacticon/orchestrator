import { describe, expect, it } from 'vitest';
import { GapClock, noteIntervalMs } from '../../src/health/gaps.js';

// See specs/health-monitoring "Gap in the daemon's clock".
const AFTER = 60_000;

/** A clock with one gap from `from` to `to`, noted by two readings. */
function withGap(from: number, to: number, hold = 0): GapClock {
  const c = new GapClock(AFTER, hold);
  c.note(from);
  expect(c.note(to)).toEqual({ from, to, gapMs: to - from, holdUntil: to + hold });
  return c;
}

describe('GapClock: notes', () => {
  it('the first note is never a gap, however far it is from anything', () => {
    const c = new GapClock(AFTER, 0);
    expect(c.note(5_000_000)).toBeUndefined();
    expect(c.pending()).toEqual([]);
    expect(c.awakeMs(0, 10_000_000)).toBe(10_000_000);
  });

  it('two notes more than gapAfterMs apart are a gap; at exactly gapAfterMs they are not', () => {
    const c = new GapClock(AFTER, 0);
    c.note(0);
    expect(c.note(AFTER)).toBeUndefined();
    expect(c.note(2 * AFTER + 1)).toEqual({ from: AFTER, to: 2 * AFTER + 1, gapMs: AFTER + 1, holdUntil: 2 * AFTER + 1 });
    expect(c.pending()).toHaveLength(1);
  });

  it('a note earlier than the one before it is not a gap and becomes the new reference', () => {
    const c = new GapClock(AFTER, 0);
    c.note(1_000_000);
    expect(c.note(10_000)).toBeUndefined();
    expect(c.pending()).toEqual([]);
    // The reference is now 10_000: a note within gapAfterMs of it is no gap, though far below the first note.
    expect(c.note(10_000 + AFTER)).toBeUndefined();
    expect(c.awakeMs(0, 2_000_000)).toBe(2_000_000);
    // And one past gapAfterMs of the new reference is a gap from it.
    expect(c.note(10_000 + 3 * AFTER)).toMatchObject({ from: 10_000 + AFTER, to: 10_000 + 3 * AFTER });
  });

  it('gapAfterMs 0 turns the rule off: nothing is ever a gap', () => {
    const c = new GapClock(0, AFTER);
    expect(c.enabled).toBe(false);
    c.note(0);
    expect(c.note(10_000_000)).toBeUndefined();
    expect(c.inHold(10_000_001)).toBe(false);
    expect(c.awakeMs(0, 10_000_000)).toBe(10_000_000);
  });

  it('pending gaps are forgotten once written; written gaps still count', () => {
    const c = withGap(0, 500_000);
    c.note(500_100);
    c.note(900_000);
    expect(c.pending()).toHaveLength(2);
    c.written(1);
    expect(c.pending()).toEqual([{ from: 500_100, to: 900_000, gapMs: 399_900, holdUntil: 900_000 }]);
    c.written(1);
    expect(c.pending()).toEqual([]);
    expect(c.awakeMs(0, 1_000_000)).toBe(1_000_000 - 500_000 - 399_900);
  });
});

describe('GapClock: awake time', () => {
  const from = 1_000_000;
  const to = 2_000_000;
  const wall = to - from;
  // Each case: the gap, and the awake time of [from, to].
  const cases: Array<[string, number, number, number]> = [
    ['before the interval', 100_000, 900_000, wall],
    ['ending at the start', 100_000, from, wall],
    ['across the start', 500_000, 1_200_000, wall - 200_000],
    ['inside', 1_300_000, 1_500_000, wall - 200_000],
    ['the whole interval', from, to, 0],
    ['covering the interval', 500_000, 2_500_000, 0],
    ['across the end', 1_900_000, 2_400_000, wall - 100_000],
    ['starting at the end', to, 2_400_000, wall],
    ['after the interval', 2_100_000, 3_000_000, wall],
  ];
  for (const [name, gFrom, gTo, awake] of cases) {
    it(`a gap ${name}`, () => {
      const c = withGap(gFrom, gTo);
      const got = c.awakeMs(from, to);
      expect(got).toBe(awake);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(wall);
    });
  }

  it('is never below 0 nor above the wall time, for empty, reversed and overlapping intervals', () => {
    const c = withGap(1_300_000, 1_500_000);
    c.load([{ from: 1_400_000, to: 1_700_000 }]); // overlaps the noted gap
    expect(c.awakeMs(from, from)).toBe(0);
    expect(c.awakeMs(to, from)).toBe(0);
    expect(c.awakeMs(from, to)).toBe(wall - 400_000);
    for (let a = 0; a <= 3_000_000; a += 250_000) {
      for (let b = a; b <= 3_000_000; b += 250_000) {
        const got = c.awakeMs(a, b);
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThanOrEqual(b - a);
      }
    }
  });

  it('loaded gaps count towards awake time but are not pending, set no hold and are no reference for the next note', () => {
    const c = new GapClock(AFTER, AFTER);
    c.load([{ from: 1_000_000, to: 1_500_000 }]);
    expect(c.pending()).toEqual([]);
    expect(c.inHold(1_500_001)).toBe(false);
    expect(c.lastGapEnd()).toBeUndefined();
    expect(c.awakeMs(900_000, 1_600_000)).toBe(200_000);
    expect(c.note(5_000_000)).toBeUndefined();
  });
});

describe('GapClock: the hold', () => {
  it('runs from the end of the latest gap until holdMs later; a second gap starts it again', () => {
    const c = withGap(0, 500_000, AFTER);
    expect(c.inHold(500_000)).toBe(true);
    expect(c.inHold(500_000 + AFTER - 1)).toBe(true);
    expect(c.inHold(500_000 + AFTER)).toBe(false);
    c.note(500_000 + 10_000);
    expect(c.note(800_000)).toMatchObject({ holdUntil: 800_000 + AFTER });
    expect(c.inHold(800_000 + AFTER - 1)).toBe(true);
    expect(c.lastGapEnd()).toBe(800_000);
  });

  it('holdMs 0 turns the hold off', () => {
    const c = withGap(0, 500_000, 0);
    expect(c.inHold(500_000)).toBe(false);
  });
});

describe('noteIntervalMs', () => {
  it('is a second, or a quarter of gapAfterMs when shorter, and never 0', () => {
    expect(noteIntervalMs(60_000)).toBe(1000);
    expect(noteIntervalMs(2_000)).toBe(500);
    expect(noteIntervalMs(3)).toBe(1);
  });
});
