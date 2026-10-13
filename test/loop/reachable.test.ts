import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quiescent, stallRoots, stalled } from '../../src/graph/query.js';
import { scopeOf, scopesOverlap } from '../../src/loop/schedule.js';
import { makeHarness } from './harness.js';

/**
 * Reachable-state property: random action sequences through the real tick,
 * then `quiescent and stalled` implies stallRoots is non-empty.
 */
type Action =
  | { t: 'tick' }
  | { t: 'submit'; i: number }
  | { t: 'fail'; i: number }
  | { t: 'block'; i: number }
  | { t: 'answer'; i: number }
  | { t: 'die'; i: number }
  | { t: 'cancel'; i: number; release: boolean }
  | { t: 'verifierFail'; i: number }
  | { t: 'conflict'; i: number }
  | { t: 'accept'; i: number }
  | { t: 'reject'; i: number }
  | { t: 'unblock'; i: number }
  | { t: 'cascade'; i: number }
  | { t: 'advance' };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ t: 'tick' }),
  fc.record({ t: fc.constant('submit' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('fail' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('block' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('answer' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('die' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('cancel' as const), i: fc.nat(9), release: fc.boolean() }),
  fc.record({ t: fc.constant('verifierFail' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('conflict' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('accept' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('reject' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('unblock' as const), i: fc.nat(9) }),
  fc.record({ t: fc.constant('cascade' as const), i: fc.nat(9) }),
  fc.constant<Action>({ t: 'advance' }),
);

/** A small glob set so random scopes overlap often; `undefined` leaves the node unconstrained. */
const scopeArb = fc.option(fc.subarray(['src/**', 'src/api/**', 'src/ui/**', 'docs/*', '**', 'package.json'], { minLength: 1, maxLength: 2 }), { nil: undefined });

const graphArb = fc
  .integer({ min: 2, max: 7 })
  .chain((n) =>
    fc.tuple(
      fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      fc.array(fc.array(fc.nat(n - 1), { maxLength: 3 }), { minLength: n, maxLength: n }),
      fc.array(scopeArb, { minLength: n, maxLength: n }),
    ),
  )
  .map(([ms, gated, deps, scopes]) => {
    const lines = ms.map((m, i) => {
      const d = [...new Set((deps[i] ?? []).filter((x) => x < i).map((x) => `N${x}`))];
      const scope = !m && scopes[i] ? `, scope: [${scopes[i]!.map((g) => JSON.stringify(g)).join(', ')}]` : '';
      return `  - { id: N${i}, kind: ${m ? 'milestone' : 'task'}, gated: ${m && gated[i] ? 'true' : 'false'}, deps: [${d.join(', ')}]${scope} }`;
    });
    return `nodes:\n${lines.join('\n')}`;
  });

describe('reachable-state stall property', () => {
  it('quiescent and stalled implies stallRoots is non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, fc.array(actionArb, { maxLength: 40 }), async (graph, actions) => {
        const h = makeHarness({ graph, config: { capacity: 2, maxWaiting: 2, maxWaitMs: 5000, leaseTtlMs: 10_000 } });
        try {
          await h.orch.loadGraph();
          const ids = [...h.orch.graph().nodes.keys()];
          const pick = (i: number) => ids[i % ids.length]!;
          const seqs = new Map<string, number>();
          const nextSeq = (l: string) => {
            const s = (seqs.get(l) ?? 0) + 1;
            seqs.set(l, s);
            return s;
          };
          await h.orch.tick();
          for (const a of actions) {
            const id = 'i' in a ? pick(a.i) : '';
            const entry = id ? h.orch.entry(id) : undefined;
            const live = id ? h.store.listLaunches({ taskId: id, status: 'live' })[0] : undefined;
            switch (a.t) {
              case 'tick':
                await h.orch.tick();
                break;
              case 'advance':
                h.advance(6000);
                break;
              case 'submit':
                if (live && entry?.status.kind === 'running') await h.orch.agentCall(live.launchId, live.token, 'report', { seq: nextSeq(live.launchId), kind: 'submit', summary: 's' });
                break;
              case 'fail':
                if (live && entry?.status.kind === 'running') await h.orch.agentCall(live.launchId, live.token, 'report', { seq: nextSeq(live.launchId), kind: 'fail', why: 'w' });
                break;
              case 'block':
                if (live && entry?.status.kind === 'running') void h.orch.agentCall(live.launchId, live.token, 'block', { seq: nextSeq(live.launchId), kind: 'needsDecision', message: 'q' });
                await new Promise((r) => setImmediate(r));
                break;
              case 'answer':
                h.orch.answer(id, 'a');
                break;
              case 'die':
                if (live) h.runner.die(live.launchId);
                break;
              case 'cancel':
                h.orch.cancel(id, 'c', a.release);
                break;
              case 'verifierFail':
                h.verifier.on(id, { kind: 'failed', reason: { kind: 'checkFailed', output: 'x' } });
                break;
              case 'conflict':
                h.verifier.on(id, { kind: 'conflict', files: ['f'], since: [] });
                break;
              case 'accept':
                if (entry?.status.kind === 'submitted' && entry.integrationSha) h.orch.acceptMilestone(id, entry.integrationSha, entry.reviewVersion);
                break;
              case 'reject':
                h.orch.rejectMilestone(id, 'n');
                break;
              case 'unblock':
                h.orch.unblock(id);
                break;
              case 'cascade':
                h.orch.reopen(id, { cascade: true });
                break;
            }
          }
          // Reach quiescence: settle verification and ticks.
          for (let i = 0; i < 6; i++) await h.orch.settle();
          const g = h.orch.graph();
          const o = h.orch.overlay();
          const live = new Set<string>();
          for (const [id, e] of o) if (e.status.kind === 'running' || e.status.kind === 'waiting') live.add(id);
          const quiet = quiescent(g, o, { live, now: h.now.value, pendingVerifierResults: h.store.listJobs({ applied: false }).length });
          if (quiet && stalled(g, o, live)) {
            expect(stallRoots(g, o).length).toBeGreaterThan(0);
          }
          // Scope filter: no two running or waiting tasks overlap, and every deferral names a task holding its scope.
          const holders = [...o].filter(([id, e]) => g.nodes.get(id)?.kind === 'task' && ['running', 'waiting', 'submitted'].includes(e.status.kind)).map(([id]) => id);
          for (const a of live) {
            for (const b of live) {
              if (a >= b) continue;
              const sa = scopeOf(g.nodes.get(a));
              const sb = scopeOf(g.nodes.get(b));
              if (sa && sb) expect(scopesOverlap(sa, sb), `${a} and ${b} run with overlapping scopes`).toBe(false);
            }
          }
          for (const d of h.orch.status().deferred) {
            expect(d.reason).toBe('scopeOverlap');
            expect(d.with.length).toBeGreaterThan(0);
            for (const w of d.with) expect(holders, `${d.id} deferred behind ${w}, which holds no scope`).toContain(w);
          }
          // After cascades: no started task depends on an unstarted node.
          for (const [id, e] of o) {
            if (g.nodes.get(id)?.kind !== 'task') continue;
            if (!['running', 'waiting', 'submitted', 'done'].includes(e.status.kind)) continue;
            for (const d of g.nodes.get(id)!.deps) expect(o.get(d)?.status.kind ?? 'unstarted', `${id} (${e.status.kind}) depends on ${d}`).not.toBe('unstarted');
          }
          // Store invariants: at most one live launch per task; milestones never running.
          const liveLaunches = h.store.listLaunches({ status: 'live' });
          expect(new Set(liveLaunches.map((l) => l.taskId)).size).toBe(liveLaunches.length);
          for (const [id, e] of o) {
            if (g.nodes.get(id)?.kind === 'milestone') expect(['running', 'waiting']).not.toContain(e.status.kind);
          }
        } finally {
          h.cleanup();
        }
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
