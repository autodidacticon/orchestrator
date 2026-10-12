/**
 * Admission policy. v1: FIFO in graph file order, resumables first,
 * bounded by capacity. Waiting tasks hold no run slot.
 */
import type { Graph, Id } from '../graph/model.js';
import type { Overlay } from '../state/status.js';

export interface ScheduleContext {
  graph: Graph;
  overlay: Overlay;
  capacity: number;
  maxWaiting: number;
  runningCount: number;
  waitingCount: number;
}

export interface Policy {
  /** Drop candidates that must not run now (conflicts, budgets). v1: none. */
  filter(candidates: Id[], ctx: ScheduleContext): Id[];
  /** Order candidates. v1: as given (graph file order). */
  order(candidates: Id[], ctx: ScheduleContext): Id[];
}

export const fifoPolicy: Policy = {
  filter: (c) => c,
  order: (c) => c,
};

export interface Admission {
  resumes: Id[];
  launches: Id[];
}

/** Resumables are waiting tasks with an answer persisted. */
export function admit(resumables: Id[], ready: Id[], ctx: ScheduleContext, policy: Policy): Admission {
  let free = Math.max(0, ctx.capacity - ctx.runningCount);
  const resumes = resumables.slice(0, free);
  free -= resumes.length;
  const ordered = policy.order(policy.filter(ready, ctx), ctx);
  return { resumes, launches: ordered.slice(0, free) };
}
