import { describe, expect, it } from 'vitest';
import { parseGraph } from '../../src/graph/load.js';
import {
  awaitingReview,
  cascadePlan,
  criticalPathLength,
  finished,
  incomplete,
  milestoneFixedPoint,
  milestonesDue,
  openQuestions,
  quiescent,
  ready,
  revocable,
  stallRoots,
  stalled,
} from '../../src/graph/query.js';
import { fixtureText, loadFixture, overlayWith } from './helpers.js';

const g = loadFixture('standard.yaml');
const none = new Set<string>();

describe('dependency semantics and readiness', () => {
  it('tasks without dependencies are ready; milestones never are', () => {
    expect(ready(g, new Map())).toEqual(['T1', 'T5']);
  });

  it('dependents become ready when dependencies complete', () => {
    const r = ready(g, overlayWith({ T1: 'done' }));
    expect(r).toContain('T2');
    expect(r).toContain('T3');
    expect(r).not.toContain('T4');
  });

  it('released cancellation satisfies, unreleased does not', () => {
    const released = overlayWith({ T1: { kind: 'cancelled', reason: 'x', releasesDependents: true } });
    expect(ready(g, released)).toEqual(expect.arrayContaining(['T2', 'T3']));
    const held = overlayWith({ T1: { kind: 'cancelled', reason: 'x', releasesDependents: false } });
    expect(ready(g, held)).toEqual(['T5']);
  });

  it('milestones excluded from ready and due when deps done', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', T5: 'done' });
    expect(ready(g, o)).toEqual([]);
    expect(milestonesDue(g, o)).toEqual(['MVP']);
  });
});

describe('critical path length', () => {
  it('counts task nodes on the longest chain of dependents', () => {
    const cp = criticalPathLength(g);
    expect(Object.fromEntries(cp)).toEqual({ T1: 2, T2: 1, T3: 0, T4: 0, T5: 0, MVP: 0 });
    expect(criticalPathLength(g)).toBe(cp); // cached per graph object
  });

  it('passes through a milestone to the tasks below it', () => {
    const chain = parseGraph(`nodes:
  - { id: T1, deps: [] }
  - { id: M1, kind: milestone, deps: [T1] }
  - { id: T9, deps: [M1] }
  - { id: X, kind: external, deps: [] }
  - { id: T10, deps: [X] }`);
    const cp = criticalPathLength(chain);
    expect(Object.fromEntries(cp)).toEqual({ T1: 1, M1: 1, T9: 0, X: 1, T10: 0 });
  });
});

describe('milestone completion', () => {
  it('chained automatic milestones complete in one pass', () => {
    const chain = loadFixture('chained-milestones.yaml');
    const { completions, overlay } = milestoneFixedPoint(chain, overlayWith({ T1: 'done' }), {
      integrationHead: 'abc',
      now: 1,
    });
    expect(completions.map((c) => c.id)).toEqual(['M1', 'M2']);
    expect(overlay.get('M2')?.status.kind).toBe('done');
    expect(milestonesDue(chain, overlay)).toEqual([]);
  });

  it('gated milestone is submitted with a pinned head and version 1', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done' });
    const { completions, overlay } = milestoneFixedPoint(g, o, { integrationHead: 'head1', now: 5 });
    expect(completions).toEqual([{ id: 'MVP', outcome: 'submitted', reviewVersion: 1, integrationSha: 'head1' }]);
    const e = overlay.get('MVP');
    expect(e?.status.kind).toBe('submitted');
    expect(e?.reviewVersion).toBe(1);
    expect(e?.integrationSha).toBe('head1');
  });
});

describe('terminal conditions', () => {
  it('finished when everything is done', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', T5: 'done', MVP: 'done' });
    expect(finished(g, o)).toBe(true);
    expect(stalled(g, o, none)).toBe(false);
    expect(incomplete(g, o)).toEqual([]);
  });

  it('failed root task stalls with that root', () => {
    const o = overlayWith({ T1: 'failed', T5: 'done' });
    expect(stalled(g, o, none)).toBe(true);
    expect(stallRoots(g, o)).toEqual(['T1']);
  });

  it('unreleased cancellation surfaces dependents', () => {
    const o = overlayWith({ T1: { kind: 'cancelled', reason: 'x', releasesDependents: false }, T5: 'done' });
    expect(stalled(g, o, none)).toBe(true);
    expect(stallRoots(g, o)).toEqual(expect.arrayContaining(['T2', 'T3']));
    expect(stallRoots(g, o)).not.toContain('T1');
  });

  it('waiting agent is not a stall and is an open question', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'waiting', T5: 'done' });
    expect(stalled(g, o, new Set(['T4']))).toBe(false);
    expect(openQuestions(g, o)).toEqual(['T4']);
  });

  it('gated milestone under review is not a stall', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', T5: 'done', MVP: 'submitted' });
    expect(stalled(g, o, none)).toBe(false);
    expect(awaitingReview(g, o)).toEqual(['MVP']);
  });

  it('quiescent requires live processes, unexpired leases, no pending results, no due milestones', () => {
    const o = overlayWith({ T1: 'running' });
    const base = { live: new Set(['T1']), now: 10, pendingVerifierResults: 0 };
    expect(quiescent(g, o, base)).toBe(false); // no lease
    const e = o.get('T1')!;
    e.lease = { launchId: 'l', token: 't', claimedAt: 0, expiresAt: 100, baseSha: 's', graphRev: g.rev };
    expect(quiescent(g, o, base)).toBe(true);
    expect(quiescent(g, o, { ...base, live: new Set() })).toBe(false);
    expect(quiescent(g, o, { ...base, now: 1000 })).toBe(false);
    expect(quiescent(g, o, { ...base, pendingVerifierResults: 1 })).toBe(false);
    const due = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done' });
    expect(quiescent(g, due, { live: new Set(), now: 0, pendingVerifierResults: 0 })).toBe(false);
  });
});

describe('revocable guard', () => {
  it('refused while a dependent runs, allowed after it fails', () => {
    expect(revocable(g, overlayWith({ T1: 'done', T2: 'running' }), 'T1')).toMatchObject({ ok: false, blockers: ['T2'] });
    expect(revocable(g, overlayWith({ T1: 'done', T2: 'failed', T3: 'blocked' }), 'T1')).toEqual({ ok: true, resets: [] });
    expect(revocable(g, overlayWith({ T1: 'done', T2: 'done' }), 'T1')).toMatchObject({ ok: false, blockers: ['T2'] });
    expect(revocable(g, overlayWith({ T1: 'running' }), 'T1')).toMatchObject({ ok: false });
  });

  it('milestones are transparent: a done milestone resets instead of blocking; a started task behind it blocks', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', MVP: 'done' });
    expect(revocable(g, o, 'T3')).toEqual({ ok: true, resets: ['MVP'] });
    expect(revocable(g, o, 'MVP')).toEqual({ ok: true, resets: [] });
    // Resets are reached only through milestone-only paths; MVP sits behind T3, a task, so T1 does not reset it.
    expect(revocable(g, o, 'T1')).toMatchObject({ ok: false, blockers: ['T2', 'T3'], resets: [] });
    const g8 = parseGraph(`${fixtureText('standard.yaml')}  - { id: T8, deps: [MVP] }\n`);
    const o8 = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', MVP: 'done', T8: 'running' });
    expect(revocable(g8, o8, 'T3')).toMatchObject({ ok: false, blockers: ['T8'], resets: ['MVP'] });
    const sub = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', MVP: 'submitted' });
    expect(revocable(g, sub, 'T4')).toEqual({ ok: true, resets: ['MVP'] });
  });

  it('cascade plan is the started closure, dependents before their dependencies', () => {
    const o = overlayWith({ T1: 'done', T2: 'running', T3: 'done', T4: 'done', MVP: 'submitted' });
    const plan = cascadePlan(g, o, 'T1');
    expect(plan.map((s) => s.id).sort()).toEqual(['MVP', 'T1', 'T2', 'T3', 'T4']);
    expect(plan).toContainEqual({ id: 'T2', from: 'running' });
    expect(plan).toContainEqual({ id: 'MVP', from: 'submitted' });
    expect(plan).toContainEqual({ id: 'T1', from: 'done' });
    const at = (id: string) => plan.findIndex((s) => s.id === id);
    expect(at('T4')).toBeLessThan(at('T2'));
    expect(at('MVP')).toBeLessThan(at('T3'));
    expect(at('MVP')).toBeLessThan(at('T4'));
    expect(at('T1')).toBe(plan.length - 1);
    expect(cascadePlan(g, overlayWith({ T1: 'done' }), 'T1')).toEqual([{ id: 'T1', from: 'done' }]);
  });
});
