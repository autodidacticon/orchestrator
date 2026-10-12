import { describe, expect, it } from 'vitest';
import { defaultEntry, type Status, STATUS_KINDS, type StatusKind } from '../../src/state/status.js';
import { type Actor, applyTransition, findTransition, TRANSITIONS, TransitionError } from '../../src/state/transitions.js';
import { asStatus } from '../graph/helpers.js';

const ACTORS: Actor[] = ['orchestrator', 'agent', 'verifier', 'human'];
const NON_TERMINAL: StatusKind[] = ['unstarted', 'running', 'waiting', 'submitted', 'failed', 'blocked'];

function entryWith(kind: StatusKind) {
  return { ...defaultEntry(), status: asStatus(kind) as Status };
}

describe('transition table', () => {
  it('every row is allowed for its node kinds and actor', () => {
    for (const row of TRANSITIONS) {
      const froms = row.from === 'nonTerminal' ? NON_TERMINAL : [row.from];
      const kinds = row.nodeKind === 'any' ? (['task', 'milestone'] as const) : [row.nodeKind];
      for (const from of froms) {
        for (const kind of kinds) {
          expect(findTransition(kind, from, row.to, row.actor, row.trigger)).toBeDefined();
          expect(() => applyTransition(entryWith(from), asStatus(row.to), { nodeId: 'n', nodeKind: kind, actor: row.actor, trigger: row.trigger, now: 1 })).not.toThrow();
        }
      }
    }
  });

  it('every non-row is rejected', () => {
    const allowed = new Set<string>();
    for (const row of TRANSITIONS) {
      const froms = row.from === 'nonTerminal' ? NON_TERMINAL : [row.from];
      const kinds = row.nodeKind === 'any' ? ['task', 'milestone'] : [row.nodeKind];
      for (const f of froms) for (const k of kinds) allowed.add(`${k}|${f}|${row.to}|${row.actor}`);
    }
    let rejected = 0;
    for (const kind of ['task', 'milestone'] as const) {
      for (const from of STATUS_KINDS) {
        for (const to of STATUS_KINDS) {
          for (const actor of ACTORS) {
            const key = `${kind}|${from}|${to}|${actor}`;
            const ok = findTransition(kind, from, to, actor) !== undefined;
            expect(ok).toBe(allowed.has(key));
            if (!ok) {
              rejected++;
              expect(() => applyTransition(entryWith(from), asStatus(to), { nodeId: 'n', nodeKind: kind, actor, now: 1 })).toThrow(TransitionError);
            }
          }
        }
      }
    }
    expect(rejected).toBeGreaterThan(400);
  });

  it('unstarted -> done directly is rejected for a task; milestones never run', () => {
    expect(findTransition('task', 'unstarted', 'done', 'orchestrator')).toBeUndefined();
    expect(findTransition('milestone', 'unstarted', 'running', 'orchestrator')).toBeUndefined();
    expect(findTransition('milestone', 'unstarted', 'done', 'orchestrator')).toBeDefined();
  });

  it('counter effects per row', () => {
    const base = { ...defaultEntry(), attempts: 1, integrationRetries: 1, launches: 2 };
    const run = applyTransition({ ...base, status: { kind: 'unstarted' } }, { kind: 'running' }, { nodeId: 'n', nodeKind: 'task', actor: 'orchestrator', trigger: 'admitted', now: 1 });
    expect(run.launches).toBe(3);
    const failedByAgent = applyTransition({ ...base, status: { kind: 'running' } }, asStatus('failed'), { nodeId: 'n', nodeKind: 'task', actor: 'agent', now: 1 });
    expect(failedByAgent.attempts).toBe(2);
    const conflict = applyTransition({ ...base, status: { kind: 'submitted' } }, { kind: 'unstarted' }, { nodeId: 'n', nodeKind: 'task', actor: 'verifier', trigger: 'conflict', now: 1 });
    expect(conflict.integrationRetries).toBe(2);
    expect(conflict.attempts).toBe(1);
    const unblocked = applyTransition({ ...base, status: asStatus('blocked') }, { kind: 'unstarted' }, { nodeId: 'n', nodeKind: 'task', actor: 'human', now: 1 });
    expect(unblocked.attempts).toBe(0);
    expect(unblocked.integrationRetries).toBe(0);
    expect(unblocked.launches).toBe(2);
    const gated = applyTransition({ ...base, status: { kind: 'unstarted' } }, { kind: 'submitted' }, { nodeId: 'm', nodeKind: 'milestone', actor: 'orchestrator', now: 1, patch: { integrationSha: 'abc' } });
    expect(gated.reviewVersion).toBe(1);
    expect(gated.integrationSha).toBe('abc');
    const retry = applyTransition({ ...base, status: asStatus('failed') }, { kind: 'unstarted' }, { nodeId: 'n', nodeKind: 'task', actor: 'orchestrator', trigger: 'retry', now: 1 });
    expect(retry.attempts).toBe(1);
  });

  it('leaving running clears the lease unless patched', () => {
    const lease = { launchId: 'l', token: 't', claimedAt: 0, expiresAt: 9, baseSha: 's', graphRev: 'r' };
    const e = { ...defaultEntry(), status: { kind: 'running' } as Status, lease };
    expect(applyTransition(e, { kind: 'submitted' }, { nodeId: 'n', nodeKind: 'task', actor: 'agent', now: 1 }).lease).toBeUndefined();
    expect(applyTransition(e, asStatus('waiting'), { nodeId: 'n', nodeKind: 'task', actor: 'agent', now: 1, patch: { lease } }).lease).toEqual(lease);
  });
});
