import { describe, expect, it } from 'vitest';
import { classifyReload } from '../../src/graph/diff.js';
import { parseGraph } from '../../src/graph/load.js';
import { externals, finished, incomplete, ready, revocable, satisfied, stallRoots, stalled } from '../../src/graph/query.js';
import { overlayWith } from './helpers.js';

const text = (done: boolean) => `nodes:
  - { id: OPS-7, kind: external, done: ${done}, title: Provision DB }
  - { id: T1, deps: [] }
  - { id: T2, deps: [OPS-7, T1] }`;

describe('external nodes', () => {
  it('loads with its done flag and is never scheduled', () => {
    const g = parseGraph(text(true));
    expect(g.nodes.get('OPS-7')).toMatchObject({ kind: 'external', done: true, payload: { title: 'Provision DB' } });
    expect(externals(g)).toEqual([{ id: 'OPS-7', done: true }]);
    expect(ready(g, new Map())).toEqual(['T1']);
    expect(incomplete(g, new Map())).toEqual(['T1', 'T2']);
    expect(revocable(g, new Map(), 'OPS-7')).toMatchObject({ ok: false });
    expect(parseGraph('nodes: [{ id: A, kind: task, done: true }]').nodes.get('A')?.done).toBe(false);
  });

  it('satisfies dependents only when done', () => {
    const open = parseGraph(text(false));
    const done = parseGraph(text(true));
    const o = overlayWith({ T1: 'done' });
    expect(satisfied(open, o, 'OPS-7')).toBe(false);
    expect(satisfied(done, o, 'OPS-7')).toBe(true);
    expect(ready(open, o)).toEqual([]);
    expect(ready(done, o)).toEqual(['T2']);
  });

  it('an open external blocker is a stall root; finished ignores externals', () => {
    const open = parseGraph(text(false));
    const o = overlayWith({ T1: 'done' });
    expect(stalled(open, o, new Set())).toBe(true);
    expect(stallRoots(open, o)).toEqual(['T2']);
    const done = parseGraph(text(true));
    expect(finished(done, overlayWith({ T1: 'done', T2: 'done' }))).toBe(true);
  });

  it('flipping the flag on reload is compatible while the dependent is unstarted', () => {
    const before = parseGraph(text(false));
    const after = parseGraph(text(true));
    const o = overlayWith({ T1: 'done' });
    expect(classifyReload(before, after, o)).toMatchObject({ compatible: true, changed: ['OPS-7'] });
    expect(ready(after, o)).toEqual(['T2']);
  });
});
