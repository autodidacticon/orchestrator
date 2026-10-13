import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.js';
import { parseGraph } from '../../src/graph/load.js';
import type { Graph, Id } from '../../src/graph/model.js';
import { admit, chainPolicy, fifoPolicy, scopesOverlap, staticPrefix, type ScheduleContext } from '../../src/loop/schedule.js';
import type { Overlay } from '../../src/state/status.js';
import { loadFixture, overlayWith } from '../graph/helpers.js';

const standard = loadFixture('standard.yaml');

function ctx(graph: Graph, overlay: Overlay = new Map(), extra: Partial<ScheduleContext> = {}): ScheduleContext {
  const running = [...overlay.values()].filter((e) => e.status.kind === 'running').length;
  return { graph, overlay, capacity: 4, maxWaiting: 4, runningCount: running, waitingCount: 0, held: [], ...extra };
}

const launches = (policy = chainPolicy(defaultConfig()), graph = standard, ready: Id[], overlay: Overlay = new Map(), extra: Partial<ScheduleContext> = {}) =>
  admit([], ready, ctx(graph, overlay, extra), policy).launches;

describe('ordering chain', () => {
  it('the default chain puts the longer critical path first on the standard fixture', () => {
    expect(launches(undefined, standard, ['T5', 'T1'])).toEqual(['T1', 'T5']);
    expect(launches(undefined, standard, ['T3', 'T2'], overlayWith({ T1: 'done' }))).toEqual(['T2', 'T3']);
  });

  it('equal critical path falls through to priority, then to file order; a missing priority sorts last', () => {
    const g = parseGraph(`nodes:
  - { id: A, deps: [] }
  - { id: B, deps: [], priority: 2 }
  - { id: C, deps: [], priority: 1 }
  - { id: D, deps: [], priority: 2 }
  - { id: E, deps: [], priority: oops }
  - { id: F, deps: [], priority: "3" }`);
    expect(launches(undefined, g, ['A', 'B', 'C', 'D', 'E', 'F'], new Map(), { capacity: 10 })).toEqual(['C', 'B', 'D', 'F', 'A', 'E']);
    const plain = parseGraph('nodes:\n  - { id: A, deps: [] }\n  - { id: B, deps: [] }\n  - { id: C, deps: [] }');
    expect(launches(undefined, plain, ['C', 'A', 'B'])).toEqual(['A', 'B', 'C']);
  });

  it('priority never outranks the critical path in the default chain, but does when listed first', () => {
    const g = parseGraph(`nodes:
  - { id: urgentLeaf, deps: [], priority: 1 }
  - { id: chainHead, deps: [] }
  - { id: T2, deps: [chainHead] }
  - { id: T3, deps: [T2] }`);
    expect(launches(undefined, g, ['urgentLeaf', 'chainHead'])).toEqual(['chainHead', 'urgentLeaf']);
    const priorityFirst = chainPolicy(defaultConfig({ scheduling: { order: ['priority', 'criticalPath', 'fifo'], scopes: true } }));
    expect(launches(priorityFirst, g, ['urgentLeaf', 'chainHead'])).toEqual(['urgentLeaf', 'chainHead']);
  });

  it("order: ['fifo'] reproduces the v1 order, as does fifoPolicy", () => {
    const fifo = chainPolicy(defaultConfig({ scheduling: { order: ['fifo'], scopes: false } }));
    const overlay = overlayWith({ T1: 'done' });
    expect(launches(fifo, standard, ['T3', 'T2'], overlay)).toEqual(['T2', 'T3']);
    expect(launches(fifo, standard, ['T5', 'T1'])).toEqual(['T1', 'T5']);
    expect(launches(fifoPolicy, standard, ['T5', 'T1'])).toEqual(['T5', 'T1']);
  });

  it('resumables take free slots first and are not ordered', () => {
    const overlay = overlayWith({ T1: 'done', T4: 'waiting' });
    const a = admit(['T4'], ['T2', 'T3'], ctx(standard, overlay, { capacity: 1 }), chainPolicy(defaultConfig()));
    expect(a).toEqual({ resumes: ['T4'], launches: [], deferred: [] });
    const b = admit(['T4'], ['T2', 'T3'], ctx(standard, overlay, { capacity: 2 }), chainPolicy(defaultConfig()));
    expect(b).toEqual({ resumes: ['T4'], launches: ['T2'], deferred: [] });
  });

  it('an unknown stage fails config validation naming it', () => {
    expect(() => defaultConfig({ scheduling: { order: ['criticalPath', 'nope'] } } as never)).toThrow(/nope/);
    expect(defaultConfig().scheduling).toEqual({ order: ['criticalPath', 'priority', 'fifo'], scopes: true });
  });
});

describe('scope overlap rule', () => {
  it('takes the static prefix up to the first glob segment', () => {
    expect(staticPrefix('src/api/**')).toEqual(['src', 'api']);
    expect(staticPrefix('src/{api,ui}/**')).toEqual(['src']);
    expect(staticPrefix('src/api-*/**')).toEqual(['src']);
    expect(staticPrefix('**')).toEqual([]);
    expect(staticPrefix('*')).toEqual([]);
    expect(staticPrefix('./docs/README.md')).toEqual(['docs', 'README.md']);
    expect(staticPrefix('lib/')).toEqual(['lib']);
    expect(staticPrefix('a/[bc]/d')).toEqual(['a']);
    expect(staticPrefix('a/b?/d')).toEqual(['a']);
  });

  it.each([
    ['src/api/**', 'src/api/**', true, 'equal globs'],
    ['src/**', 'src/api/handlers.ts', true, 'prefix against a literal file'],
    ['src/api/handlers.ts', 'src/api/**', true, 'a literal file against a directory glob'],
    ['src/api/**', 'src/ui/**', false, 'disjoint siblings'],
    ['**', 'docs/README.md', true, 'double star overlaps everything'],
    ['*', 'docs/README.md', true, 'bare star overlaps everything'],
    ['src/{api,ui}/**', 'src/ui/**', true, 'brace in a segment'],
    ['src/api-*/**', 'src/ui/**', true, 'star in a segment ends the prefix'],
    ['src/api.ts', 'src/api', false, 'segments compare whole'],
    ['package.json', 'package-lock.json', false, 'distinct files'],
    ['docs/*', 'src/**', false, 'different roots'],
  ])('%s vs %s overlap=%s (%s)', (a, b, expected) => {
    expect(scopesOverlap([a], [b])).toBe(expected);
    expect(scopesOverlap([b], [a])).toBe(expected);
  });

  it('scopes overlap when any pair of globs does', () => {
    expect(scopesOverlap(['src/ui/**', 'package.json'], ['src/api/**', 'package.json'])).toBe(true);
    expect(scopesOverlap(['src/ui/**', 'docs/**'], ['src/api/**', 'README.md'])).toBe(false);
  });
});

describe('scope filter at admission', () => {
  const g = parseGraph(`nodes:
  - { id: A, deps: [], scope: ["src/api/**"] }
  - { id: B, deps: [], scope: ["src/api/users/**"] }
  - { id: C, deps: [], scope: ["src/ui/**"] }
  - { id: D, deps: [] }
  - { id: E, deps: [], scope: ["src/**"] }`);
  const policy = chainPolicy(defaultConfig());

  it('defers a candidate overlapping a held id, naming it', () => {
    const a = admit([], ['B', 'C', 'D'], ctx(g, overlayWith({ A: 'running' }), { held: ['A'] }), policy);
    expect(a).toEqual({ resumes: [], launches: ['C', 'D'], deferred: [{ id: 'B', reason: 'scopeOverlap', with: ['A'] }] });
  });

  it('defers a candidate overlapping one admitted earlier in the same pass, even with capacity to spare', () => {
    const a = admit([], ['A', 'B', 'C', 'D', 'E'], ctx(g), policy);
    expect(a.launches).toEqual(['A', 'C', 'D']);
    expect(a.deferred).toEqual([
      { id: 'B', reason: 'scopeOverlap', with: ['A'] },
      { id: 'E', reason: 'scopeOverlap', with: ['A', 'C'] },
    ]);
  });

  it('records deferrals even when capacity is already full and lists every overlapping id', () => {
    const a = admit([], ['E'], ctx(g, overlayWith({ A: 'running', C: 'submitted' }), { capacity: 1, held: ['A', 'C'] }), policy);
    expect(a).toEqual({ resumes: [], launches: [], deferred: [{ id: 'E', reason: 'scopeOverlap', with: ['A', 'C'] }] });
  });

  it('unconstrained tasks never conflict; scopes: false defers nothing', () => {
    expect(admit([], ['D'], ctx(g, overlayWith({ E: 'running' }), { held: ['E'] }), policy).launches).toEqual(['D']);
    const off = chainPolicy(defaultConfig({ scheduling: { order: ['criticalPath', 'priority', 'fifo'], scopes: false } }));
    expect(admit([], ['A', 'B', 'E'], ctx(g), off)).toEqual({ resumes: [], launches: ['A', 'B', 'E'], deferred: [] });
    expect(fifoPolicy.conflicts('B', ['A'], ctx(g))).toEqual([]);
  });
});
