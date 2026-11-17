/**
 * Gaps in the daemon's clock: time during which the daemon did not run (a machine asleep, a frozen process). A note
 * is one reading of the clock the daemon remembers; two consecutive notes more than `gapAfterMs` apart are a gap from
 * the earlier note to the later one. Awake time between two instants is their difference less the parts inside gaps.
 * The hold runs from the end of the latest gap this process noted until `holdMs` later. Pure arithmetic: no store and
 * no limit. See specs/health-monitoring "Gap in the daemon's clock" and "Hold after a gap".
 */

export interface Gap {
  from: number;
  to: number;
  gapMs: number;
  /** `to` plus the hold; equal to `to` when the hold is off. */
  holdUntil: number;
}

/** Anything that turns two instants into awake time. */
export interface AwakeClock {
  awakeMs(from: number, to: number): number;
}

export class GapClock implements AwakeClock {
  /** Every gap known to this process: loaded from earlier events and noted here. */
  private readonly gaps: Array<{ from: number; to: number }> = [];
  /** Gaps noted and not yet written to the store. */
  private pendingGaps: Gap[] = [];
  private last: number | undefined;
  private holdEnd: number | undefined;
  private latestEnd: number | undefined;

  /** `gapAfterMs` 0 turns the rule off; `holdMs` 0 turns the hold off. */
  constructor(
    readonly gapAfterMs: number,
    readonly holdMs: number,
  ) {}

  /** Whether the rule is on. */
  get enabled(): boolean {
    return this.gapAfterMs > 0;
  }

  /**
   * Gaps written by an earlier process of the same run. They count towards awake time only: they set no hold and are
   * not the reference of the next note, so the first note of this process is never a gap.
   */
  load(earlier: Iterable<{ from: number; to: number }>): void {
    for (const g of earlier) if (Number.isFinite(g.from) && Number.isFinite(g.to) && g.to > g.from) this.gaps.push({ from: g.from, to: g.to });
  }

  /**
   * Take a note at `now`. Returns the gap it found, if any. The first note is never a gap, and a note earlier than the
   * one before it is not a gap and becomes the new reference. With the rule off nothing is noted.
   */
  note(now: number): Gap | undefined {
    if (!this.enabled) return undefined;
    const last = this.last;
    this.last = now;
    if (last === undefined || now - last <= this.gapAfterMs) return undefined;
    const gap: Gap = { from: last, to: now, gapMs: now - last, holdUntil: now + this.holdMs };
    this.gaps.push({ from: gap.from, to: gap.to });
    this.pendingGaps.push(gap);
    this.holdEnd = this.holdMs > 0 ? gap.holdUntil : undefined;
    this.latestEnd = now;
    return gap;
  }

  /** Gaps noted and not yet written, oldest first. */
  pending(): readonly Gap[] {
    return this.pendingGaps;
  }

  /** Forget the first `n` pending gaps once they are written. */
  written(n: number): void {
    this.pendingGaps = this.pendingGaps.slice(n);
  }

  /** The end of the latest gap this process noted. */
  lastGapEnd(): number | undefined {
    return this.latestEnd;
  }

  /** Whether `now` is inside the hold of the latest gap this process noted. */
  inHold(now: number): boolean {
    return this.holdEnd !== undefined && now < this.holdEnd;
  }

  /** `to - from` less the parts inside gaps (written or not); 0 for an empty or reversed interval; never above the wall time. */
  awakeMs(from: number, to: number): number {
    if (!(to > from)) return 0;
    const parts: Array<[number, number]> = [];
    for (const g of this.gaps) {
      const a = Math.max(from, g.from);
      const b = Math.min(to, g.to);
      if (b > a) parts.push([a, b]);
    }
    let asleep = 0;
    if (parts.length) {
      parts.sort((x, y) => x[0] - y[0]);
      let [a, b] = parts[0]!;
      for (const [c, d] of parts.slice(1)) {
        if (c <= b) {
          b = Math.max(b, d);
        } else {
          asleep += b - a;
          [a, b] = [c, d];
        }
      }
      asleep += b - a;
    }
    return Math.max(0, to - from - asleep);
  }
}

/** The interval of the note timer: every second, or a quarter of `gapAfterMs` when that is shorter; at least 1 ms. */
export function noteIntervalMs(gapAfterMs: number): number {
  return Math.max(1, Math.min(1000, Math.floor(gapAfterMs / 4)));
}
