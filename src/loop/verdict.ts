/**
 * The work verdict per runner kind: one rule, in the daemon, that tells a worker loop whether work of its kind is in
 * sight. The daemon classifies; each loop keeps its own reaction to a class. See specs/operator-control "Work verdict".
 *
 * Pure, with no runtime import from the daemon: the remote worker loop imports this module too.
 */

/** The verdicts, strongest first: a kind's verdict is the first of these whose condition applies. */
export const WORK_VERDICTS = ['finished', 'stalled', 'paused', 'claim', 'standby', 'human', 'idle'] as const;
export type WorkVerdict = (typeof WORK_VERDICTS)[number];

/** Run-level facts behind the verdict, the same for every kind. */
export interface WorkRunFacts {
  finished: boolean;
  stalled: boolean;
  paused: boolean;
  /** Tasks under verification (submitted, awaiting the verifier). */
  verifying: number;
  /** Questions without an answer. */
  openQuestions: number;
  /** Milestones awaiting a human review (verifying tasks excluded). */
  milestonesAwaitingReview: number;
}

/** A kind's counts: parked launches, launches being prepared plus prepare retries, and launches being worked. */
export interface WorkCounts {
  claimable: number;
  preparing: number;
  /** Live launches of the kind whose task is running or waiting on that launch (the predicate of claim()). */
  working: number;
}

export interface KindWork extends WorkCounts {
  verdict: WorkVerdict;
}

/** The verdict for one kind: the first class of WORK_VERDICTS that applies. */
export function workVerdict(run: WorkRunFacts, kind: WorkCounts): WorkVerdict {
  if (run.finished) return 'finished';
  if (run.stalled) return 'stalled';
  if (run.paused) return 'paused';
  if (kind.claimable > 0) return 'claim';
  if (kind.preparing > 0 || kind.working > 0 || run.verifying > 0) return 'standby';
  if (run.openQuestions > 0 || run.milestonesAwaitingReview > 0) return 'human';
  return 'idle';
}

/** The verdict and counts for every kind in `counts`. */
export function workByKindOf<K extends string>(run: WorkRunFacts, counts: Record<K, WorkCounts>): Record<K, KindWork> {
  const out = {} as Record<K, KindWork>;
  for (const kind of Object.keys(counts) as K[]) {
    const c = counts[kind];
    out[kind] = { verdict: workVerdict(run, c), claimable: c.claimable, preparing: c.preparing, working: c.working };
  }
  return out;
}

/** The verdict for every kind with zero counts: `idle`, or `paused` when paused (a body without a graph). */
export function emptyWorkByKind<K extends string>(kinds: readonly K[], paused: boolean): Record<K, KindWork> {
  const counts = {} as Record<K, WorkCounts>;
  for (const k of kinds) counts[k] = { claimable: 0, preparing: 0, working: 0 };
  return workByKindOf({ finished: false, stalled: false, paused, verifying: 0, openQuestions: 0, milestonesAwaitingReview: 0 }, counts);
}

/** The word of the list that comes first in WORK_VERDICTS; `idle` for an empty list; unknown words are ignored. */
export function strongestVerdict(list: readonly string[]): WorkVerdict {
  let best = WORK_VERDICTS.length - 1;
  for (const word of list) {
    const i = (WORK_VERDICTS as readonly string[]).indexOf(word);
    if (i >= 0 && i < best) best = i;
  }
  return WORK_VERDICTS[best]!;
}
