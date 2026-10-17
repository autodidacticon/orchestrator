import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './harness.js';

// See specs/model-selection "Resolution fixed at preparation" and "Selection visible to operators".
const graph = `nodes:
  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }
  - { id: T2, deps: [], description: d, acceptanceCriteria: [a], effort: high, model: claude-sonnet-5-5 }
  - { id: T3, deps: [T1], description: d, acceptanceCriteria: [a] }`;

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

describe('model and effort per launch', () => {
  it('a task selector wins over the run default, the choice is fixed at preparation, and status and the event show it', async () => {
    const h = makeHarness({ graph, config: { capacity: 2 } });
    open.push(h);
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const l2 = h.launchOf('T2');
    expect(l1).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(l2).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T2' })[0]?.payload).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    const s = h.orch.status();
    expect(s.liveLaunches.find((l) => l.taskId === 'T1')).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(s.liveLaunches.find((l) => l.taskId === 'T2')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(s.config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
    expect(s.config.effort).toEqual({ value: 'medium', source: 'default', applied: true });

    // An override reaches launches prepared afterwards only.
    expect(h.orch.setConfig({ model: 'claude-haiku-5-5', effort: 'low' })).toMatchObject({ ok: true, applied: ['model', 'effort'] });
    expect(h.orch.configReport().config.model).toEqual({ value: 'claude-haiku-5-5', source: 'argument', applied: true });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    await h.submit('T1', { acceptance: [{ criterion: 'a', evidence: 'done' }] });
    await h.orch.settle();
    await h.orch.tick();
    const l3 = h.launchOf('T3');
    expect(l3).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    // The task selector still wins for a task that declares one.
    expect(h.orch.selectionFor('T2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('a retry resolves again from the run default in force when it is prepared', async () => {
    const h = makeHarness({ graph: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }', config: { capacity: 1, maxAttempts: 2 } });
    open.push(h);
    await h.orch.tick();
    const first = h.launchOf('T1');
    expect(first.effort).toBe('medium');
    h.orch.setConfig({ effort: 'high' });
    await h.failTask('T1');
    await h.orch.tick();
    const second = h.launchOf('T1');
    expect(second.launchId).not.toBe(first.launchId);
    expect(second).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  });
});
