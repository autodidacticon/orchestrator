/**
 * Pure queries over (graph, overlay). See specs/task-graph.
 */
import { entryOf, isSatisfied, isStarted, type Overlay, type Status } from '../state/status.js';
import type { Graph, Id } from './model.js';

export function deps(g: Graph, id: Id): readonly Id[] {
  return g.nodes.get(id)?.deps ?? [];
}

export function dependents(g: Graph, id: Id): readonly Id[] {
  return g.dependents.get(id) ?? [];
}

/** Transitive dependency closure of `id`, excluding `id` itself. */
export function closure(g: Graph, id: Id): Set<Id> {
  const out = new Set<Id>();
  const stack = [...deps(g, id)];
  while (stack.length) {
    const next = stack.pop() as Id;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...deps(g, next));
  }
  return out;
}

export function tasks(g: Graph): Id[] {
  return [...g.nodes.values()].filter((n) => n.kind === 'task').map((n) => n.id);
}

export function milestones(g: Graph): Id[] {
  return [...g.nodes.values()].filter((n) => n.kind === 'milestone').map((n) => n.id);
}

export function satisfied(overlay: Overlay, id: Id): boolean {
  return isSatisfied(entryOf(overlay, id).status);
}

export function depsSatisfied(g: Graph, overlay: Overlay, id: Id): boolean {
  return deps(g, id).every((d) => satisfied(overlay, d));
}

function withStatus(g: Graph, overlay: Overlay, pred: (s: Status, id: Id) => boolean): Id[] {
  const out: Id[] = [];
  for (const id of g.nodes.keys()) {
    if (pred(entryOf(overlay, id).status, id)) out.push(id);
  }
  return out;
}

/** Unstarted tasks whose deps are all satisfied. Never contains milestones. File order. */
export function ready(g: Graph, overlay: Overlay): Id[] {
  const out: Id[] = [];
  for (const node of g.nodes.values()) {
    if (node.kind !== 'task') continue;
    if (entryOf(overlay, node.id).status.kind !== 'unstarted') continue;
    if (depsSatisfied(g, overlay, node.id)) out.push(node.id);
  }
  return out;
}

export function milestonesDue(g: Graph, overlay: Overlay): Id[] {
  const out: Id[] = [];
  for (const node of g.nodes.values()) {
    if (node.kind !== 'milestone') continue;
    if (entryOf(overlay, node.id).status.kind !== 'unstarted') continue;
    if (depsSatisfied(g, overlay, node.id)) out.push(node.id);
  }
  return out;
}

export function incomplete(g: Graph, overlay: Overlay): Id[] {
  return withStatus(g, overlay, (s) => s.kind !== 'done' && s.kind !== 'cancelled');
}

export function awaitingReview(g: Graph, overlay: Overlay): Id[] {
  return withStatus(g, overlay, (s) => s.kind === 'submitted');
}

export function openQuestions(g: Graph, overlay: Overlay): Id[] {
  return withStatus(
    g,
    overlay,
    (s) =>
      (s.kind === 'waiting' && s.answer === undefined) ||
      (s.kind === 'blocked' &&
        (s.reason.kind === 'needsDecision' || s.reason.kind === 'needsAccess') &&
        s.reason.answer === undefined),
  );
}

export function finished(g: Graph, overlay: Overlay): boolean {
  return incomplete(g, overlay).length === 0;
}

/**
 * Stalled: nothing ready, nothing live, nothing awaiting review, work remains.
 * `live` is the set of task ids with a live process (running or waiting).
 */
export function stalled(g: Graph, overlay: Overlay, live: ReadonlySet<Id>): boolean {
  return (
    ready(g, overlay).length === 0 &&
    live.size === 0 &&
    awaitingReview(g, overlay).length === 0 &&
    incomplete(g, overlay).length > 0
  );
}

/** Incomplete nodes that are failed or blocked, or depend on an unreleased cancellation. */
export function stallRoots(g: Graph, overlay: Overlay): Id[] {
  const out: Id[] = [];
  for (const id of incomplete(g, overlay)) {
    const s = entryOf(overlay, id).status;
    if (s.kind === 'failed' || s.kind === 'blocked') {
      out.push(id);
      continue;
    }
    const onCancelled = deps(g, id).some((d) => {
      const ds = entryOf(overlay, d).status;
      return ds.kind === 'cancelled' && !ds.releasesDependents;
    });
    if (onCancelled) out.push(id);
  }
  return out;
}

export type Revocable = { ok: true } | { ok: false; blockers: Id[]; reason: string };

/** done/cancelled nodes may be reopened only if no dependent is started. */
export function revocable(g: Graph, overlay: Overlay, id: Id): Revocable {
  const s = entryOf(overlay, id).status;
  if (s.kind !== 'done' && s.kind !== 'cancelled') {
    return { ok: false, blockers: [], reason: `node ${id} is ${s.kind}, not done or cancelled` };
  }
  const blockers = dependents(g, id).filter((d) => isStarted(entryOf(overlay, d).status));
  if (blockers.length) {
    return { ok: false, blockers, reason: `dependents started: ${blockers.join(', ')}` };
  }
  return { ok: true };
}

export interface QuiescenceContext {
  /** Task ids whose process is alive. */
  live: ReadonlySet<Id>;
  now: number;
  /** Verifier results not yet applied to the overlay. */
  pendingVerifierResults: number;
}

/**
 * Quiescent: every running/waiting entry has a live process and an unexpired
 * lease, no verifier result is unapplied, and no milestone is due.
 */
export function quiescent(g: Graph, overlay: Overlay, ctx: QuiescenceContext): boolean {
  if (ctx.pendingVerifierResults > 0) return false;
  if (milestonesDue(g, overlay).length > 0) return false;
  for (const id of g.nodes.keys()) {
    const e = entryOf(overlay, id);
    if (e.status.kind === 'running' || e.status.kind === 'waiting') {
      if (!ctx.live.has(id)) return false;
      if (!e.lease || e.lease.expiresAt <= ctx.now) return false;
    }
  }
  return true;
}

export interface MilestoneCompletion {
  id: Id;
  outcome: 'done' | 'submitted';
  reviewVersion?: number;
  integrationSha?: string;
}

/**
 * Pure milestone fixed point: returns the sequence of completions that a tick
 * would apply, computing against a working copy of the overlay. Does not
 * mutate `overlay`.
 */
export function milestoneFixedPoint(
  g: Graph,
  overlay: Overlay,
  ctx: { integrationHead: string; now: number },
): { completions: MilestoneCompletion[]; overlay: Map<Id, import('../state/status.js').Entry> } {
  const work = new Map(overlay);
  const completions: MilestoneCompletion[] = [];
  // Bounded by the number of milestones; each iteration completes at least one.
  for (let guard = 0; guard <= g.nodes.size; guard++) {
    const due = milestonesDue(g, work);
    if (due.length === 0) break;
    for (const id of due) {
      const node = g.nodes.get(id);
      const prev = entryOf(work, id);
      if (node?.gated) {
        const reviewVersion = prev.reviewVersion + 1;
        work.set(id, {
          ...prev,
          status: { kind: 'submitted' },
          reviewVersion,
          integrationSha: ctx.integrationHead,
          updatedAt: ctx.now,
        });
        completions.push({ id, outcome: 'submitted', reviewVersion, integrationSha: ctx.integrationHead });
      } else {
        work.set(id, { ...prev, status: { kind: 'done' }, updatedAt: ctx.now });
        completions.push({ id, outcome: 'done' });
      }
    }
  }
  return { completions, overlay: work };
}
