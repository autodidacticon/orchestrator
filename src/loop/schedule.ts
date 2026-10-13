/**
 * Admission policy. Resumables first, then ready candidates ordered by the
 * configured stage chain and walked against the scopes held by tasks that hold
 * a slot, bounded by capacity. Waiting tasks hold no run slot but keep their
 * scope. See specs/scheduling-policy.
 */
import type { Config, StageName } from '../config.js';
import type { Graph, GraphNode, Id } from '../graph/model.js';
import { criticalPathLength } from '../graph/query.js';
import type { Overlay } from '../state/status.js';

export interface ScheduleContext {
  graph: Graph;
  overlay: Overlay;
  capacity: number;
  maxWaiting: number;
  runningCount: number;
  waitingCount: number;
  /** Tasks holding their scope: running, waiting, submitted, or with a claimable launch. */
  held: Id[];
}

export interface Policy {
  /** Drop candidates that must not run now (budgets). None yet. */
  filter(candidates: Id[], ctx: ScheduleContext): Id[];
  /** Order candidates; ties keep the given (graph file) order. */
  order(candidates: Id[], ctx: ScheduleContext): Id[];
  /** The held ids whose scope overlaps the candidate's; empty admits it. */
  conflicts(candidate: Id, held: Id[], ctx: ScheduleContext): Id[];
}

/** The v1 policy: graph file order, no scopes. */
export const fifoPolicy: Policy = {
  filter: (c) => c,
  order: (c) => c,
  conflicts: () => [],
};

export type Comparator = (a: Id, b: Id) => number;
/** A stage builds its comparator once per pass from the context. */
export type Stage = (ctx: ScheduleContext) => Comparator;

/** `priority` from a payload as a number, lower more urgent; absent or not finite is undefined. */
export function priorityOf(node: GraphNode | undefined): number | undefined {
  const raw = node?.payload['priority'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

export const stages: Record<StageName, Stage> = {
  /** Longer critical path first. */
  criticalPath: (ctx) => {
    const length = criticalPathLength(ctx.graph);
    return (a, b) => (length.get(b) ?? 0) - (length.get(a) ?? 0);
  },
  /** Lower number first; a missing or non-numeric priority sorts last. */
  priority: (ctx) => {
    const rank = new Map<Id, number | undefined>();
    const of = (id: Id): number | undefined => {
      if (!rank.has(id)) rank.set(id, priorityOf(ctx.graph.nodes.get(id)));
      return rank.get(id);
    };
    return (a, b) => {
      const pa = of(a);
      const pb = of(b);
      if (pa === pb) return 0;
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    };
  },
  /** Graph file order. */
  fifo: (ctx) => {
    const index = new Map<Id, number>();
    let i = 0;
    for (const id of ctx.graph.nodes.keys()) index.set(id, i++);
    return (a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0);
  },
};

/** The configured chain as one stable lexicographic sort, plus the scope filter when enabled. */
export function chainPolicy(config: Pick<Config, 'scheduling'>): Policy {
  const { order, scopes } = config.scheduling;
  return {
    filter: (c) => c,
    order: (candidates, ctx) => {
      const comparators = order.map((name) => stages[name](ctx));
      return [...candidates].sort((a, b) => {
        for (const cmp of comparators) {
          const r = cmp(a, b);
          if (r !== 0) return r;
        }
        return 0;
      });
    },
    conflicts: (candidate, held, ctx) => {
      if (!scopes) return [];
      const scope = scopeOf(ctx.graph.nodes.get(candidate));
      if (!scope) return [];
      return held.filter((h) => {
        const other = scopeOf(ctx.graph.nodes.get(h));
        return other !== undefined && scopesOverlap(scope, other);
      });
    },
  };
}

/** A node's declared scope; absent, malformed, or empty means unconstrained. */
export function scopeOf(node: GraphNode | undefined): string[] | undefined {
  const raw = node?.payload['scope'];
  if (!Array.isArray(raw)) return undefined;
  const globs = raw.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim());
  return globs.length ? globs : undefined;
}

const GLOB_CHARS = /[*?[{]/;

/**
 * The longest leading run of path segments containing none of `*`, `?`, `[`, `{`.
 * `**` and a bare `*` have an empty prefix. See specs/scheduling-policy "Scope overlap rule".
 */
export function staticPrefix(glob: string): string[] {
  const segments = glob.replace(/^\.\//, '').split('/').filter((s) => s !== '' && s !== '.');
  const out: string[] = [];
  for (const s of segments) {
    if (GLOB_CHARS.test(s)) break;
    out.push(s);
  }
  return out;
}

function isPathPrefix(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/** Two globs overlap iff the static prefix of one is a path-prefix of the other's, or they are equal. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return isPathPrefix(pa, pb) || isPathPrefix(pb, pa);
}

/** Two scopes overlap iff any glob of one overlaps any glob of the other. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

/** A candidate skipped by the scope filter this pass. See specs/operator-control "Status report: deferred candidates". */
export interface Deferral {
  id: Id;
  reason: 'scopeOverlap';
  /** The held or earlier-admitted ids whose scopes it overlaps. */
  with: Id[];
}

export interface Admission {
  resumes: Id[];
  launches: Id[];
  deferred: Deferral[];
}

/**
 * Resumables are waiting tasks with an answer persisted; they take free slots
 * first and are not ordered. Ready candidates are ordered by the policy, then
 * walked: a candidate overlapping a held id or one admitted earlier in this
 * pass is deferred, the rest are admitted up to the free capacity.
 */
export function admit(resumables: Id[], ready: Id[], ctx: ScheduleContext, policy: Policy): Admission {
  let free = Math.max(0, ctx.capacity - ctx.runningCount);
  const resumes = resumables.slice(0, free);
  free -= resumes.length;
  const ordered = policy.order(policy.filter(ready, ctx), ctx);
  const held = [...ctx.held];
  const launches: Id[] = [];
  const deferred: Deferral[] = [];
  for (const id of ordered) {
    const overlapping = policy.conflicts(id, held, ctx);
    if (overlapping.length) {
      deferred.push({ id, reason: 'scopeOverlap', with: overlapping });
      continue;
    }
    if (launches.length >= free) continue;
    launches.push(id);
    held.push(id);
  }
  return { resumes, launches, deferred };
}
