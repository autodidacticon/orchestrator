import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type GraphNode, type Id, makeGraph } from '../../src/graph/model.js';
import { criticalPathLength, dependents, depsSatisfied, milestoneFixedPoint, milestonesDue, ready, revocable } from '../../src/graph/query.js';
import { defaultEntry, type Entry, isStarted, type Status } from '../../src/state/status.js';
import { asStatus } from './helpers.js';

/** Random DAG: node i may depend only on nodes < i, so it is acyclic by construction. */
export const dagArb = fc
  .integer({ min: 1, max: 12 })
  .chain((n) =>
    fc.tuple(
      fc.array(fc.boolean(), { minLength: n, maxLength: n }), // isMilestone
      fc.array(fc.boolean(), { minLength: n, maxLength: n }), // gated
      fc.array(fc.array(fc.integer({ min: 0, max: n - 1 }), { maxLength: 4 }), { minLength: n, maxLength: n }),
    ),
  )
  .map(([ms, gated, rawDeps]) => {
    const nodes = new Map<Id, GraphNode>();
    const n = ms.length;
    for (let i = 0; i < n; i++) {
      const id = `N${i}`;
      const deps = [...new Set((rawDeps[i] ?? []).filter((d) => d < i).map((d) => `N${d}`))];
      nodes.set(id, { id, kind: ms[i] ? 'milestone' : 'task', gated: Boolean(gated[i]), done: false, deps, payload: {} });
    }
    return makeGraph('rev', nodes);
  });

const statusArb: fc.Arbitrary<Status> = fc.oneof(
  fc.constant<Status>({ kind: 'unstarted' }),
  fc.constant<Status>({ kind: 'done' }),
  fc.constant<Status>(asStatus('running')),
  fc.constant<Status>(asStatus('failed')),
  fc.constant<Status>(asStatus('blocked')),
  fc.boolean().map<Status>((r) => ({ kind: 'cancelled', reason: 'r', releasesDependents: r })),
);

function overlayArb(ids: Id[]) {
  return fc.array(statusArb, { minLength: ids.length, maxLength: ids.length }).map((ss) => {
    const m = new Map<Id, Entry>();
    ids.forEach((id, i) => m.set(id, { ...defaultEntry(), status: ss[i] as Status }));
    return m;
  });
}

describe('graph properties', () => {
  it('ready contains only unstarted tasks with satisfied deps', () => {
    fc.assert(
      fc.property(
        dagArb.chain((g) => fc.tuple(fc.constant(g), overlayArb([...g.nodes.keys()]))),
        ([g, o]) => {
          for (const id of ready(g, o)) {
            expect(g.nodes.get(id)?.kind).toBe('task');
            expect(o.get(id)?.status.kind).toBe('unstarted');
            expect(depsSatisfied(g, o, id)).toBe(true);
          }
        },
      ),
    );
  });

  it('marking a ready node done never removes another node from ready', () => {
    fc.assert(
      fc.property(
        dagArb.chain((g) => fc.tuple(fc.constant(g), overlayArb([...g.nodes.keys()]))),
        ([g, o]) => {
          const before = ready(g, o);
          for (const id of before) {
            const next = new Map(o);
            next.set(id, { ...defaultEntry(), status: { kind: 'done' } });
            const after = new Set(ready(g, next));
            for (const other of before) {
              if (other !== id) expect(after.has(other)).toBe(true);
            }
          }
        },
      ),
    );
  });

  it('revocable blockers are the started non-milestone nodes reachable through milestone-only paths, never a milestone', () => {
    fc.assert(
      fc.property(
        dagArb.chain((g) => fc.tuple(fc.constant(g), overlayArb([...g.nodes.keys()]))),
        ([g, o]) => {
          for (const [id, e] of o) {
            if (e.status.kind !== 'done' && e.status.kind !== 'cancelled') continue;
            const expected = new Set<string>();
            const seen = new Set<string>();
            const walk = (n: string): void => {
              for (const d of dependents(g, n)) {
                if (seen.has(d)) continue;
                seen.add(d);
                if (g.nodes.get(d)?.kind === 'milestone') walk(d);
                else if (isStarted(o.get(d)!.status)) expected.add(d);
              }
            };
            walk(id);
            const r = revocable(g, o, id);
            const blockers = r.ok ? [] : r.blockers;
            expect(new Set(blockers)).toEqual(expected);
            for (const b of blockers) expect(g.nodes.get(b)?.kind).not.toBe('milestone');
            for (const m of r.resets) expect(g.nodes.get(m)?.kind).toBe('milestone');
          }
        },
      ),
    );
  });

  it('critical path length is monotone along dependencies and a milestone takes the maximum over its dependents', () => {
    fc.assert(
      fc.property(dagArb, (g) => {
        const cp = criticalPathLength(g);
        for (const node of g.nodes.values()) {
          const weight = node.kind === 'task' ? 1 : 0;
          for (const d of node.deps) expect(cp.get(d)!).toBeGreaterThanOrEqual(cp.get(node.id)! + weight);
          if (dependents(g, node.id).length === 0) expect(cp.get(node.id)).toBe(0);
          if (node.kind === 'milestone') {
            const below = dependents(g, node.id).map((d) => cp.get(d)! + (g.nodes.get(d)?.kind === 'task' ? 1 : 0));
            expect(cp.get(node.id)).toBe(below.length ? Math.max(...below) : 0);
          }
        }
      }),
    );
  });

  it('milestone fixed point leaves no milestone due', () => {
    fc.assert(
      fc.property(
        dagArb.chain((g) => fc.tuple(fc.constant(g), overlayArb([...g.nodes.keys()]))),
        ([g, o]) => {
          const { overlay } = milestoneFixedPoint(g, o, { integrationHead: 'h', now: 0 });
          expect(milestonesDue(g, overlay)).toEqual([]);
        },
      ),
    );
  });
});
