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
    expect(l1).toMatchObject({ runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
    expect(l2).toMatchObject({ runner: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T2' })[0]?.payload).toMatchObject({ runner: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T2' })[0]?.payload).not.toHaveProperty('effortRequested');
    const s = h.orch.status();
    expect(s.liveLaunches.find((l) => l.taskId === 'T1')).toMatchObject({ runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
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
    expect(h.orch.selectionFor('T2')).toEqual({ runner: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('the runner kind is fixed on the row at preparation; an override reaches launches prepared afterwards only', async () => {
    const h = makeHarness({ graph, config: { capacity: 2 } });
    open.push(h);
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    expect(l1.runner).toBe('claude-code');
    expect(h.orch.briefInput(l1).runner).toEqual({ kind: 'claude-code', commitPolicy: 'agent' });
    expect(h.orch.setConfig({ runnerKind: 'codex' })).toMatchObject({ ok: true });
    expect(h.store.getLaunch(l1.launchId)?.runner).toBe('claude-code');
    await h.submit('T1', { acceptance: [{ criterion: 'a', evidence: 'done' }] });
    await h.orch.settle();
    await h.orch.tick();
    const l3 = h.launchOf('T3');
    // T3 has no selectors, so it takes codex's own defaults, never the Claude model.
    expect(l3).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T3' })[0]?.payload).toMatchObject({ runner: 'codex', model: 'gpt-6-astra' });
    expect(h.orch.status().liveLaunches.find((l) => l.taskId === 'T3')).toMatchObject({ runner: 'codex' });
    // Dispatched by the row: T3 went to the codex fake, T1 and T2 to the claude-code fake.
    expect(h.runners.codex.spawned.map((l) => l.taskId)).toEqual(['T3']);
    expect(h.runners['claude-code'].spawned.map((l) => l.taskId).sort()).toEqual(['T1', 'T2']);
  });

  it('under run kind codex a task without selectors is prepared with the codex defaults, and the brief input carries the kind', async () => {
    const h = makeHarness({ graph, config: { capacity: 2, runner: { kind: 'codex' } } });
    open.push(h);
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    expect(l1).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T1' })[0]?.payload).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    expect(h.orch.status().liveLaunches.find((l) => l.taskId === 'T1')).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    const brief = h.orch.briefInput(l1);
    // Codex's default sandbox cannot commit in a linked worktree, so its commit policy derives to daemon.
    expect(l1.commitPolicy).toBe('daemon');
    expect(brief.runner).toEqual({ kind: 'codex', commitPolicy: 'daemon', sandbox: 'workspace-write' });
    expect(brief.allowedTools).toBeUndefined();
    // A task selector still wins under codex.
    expect(h.launchOf('T2')).toMatchObject({ runner: 'codex', model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('effort ultra falls back to max under claude-code and records what was asked; codex keeps ultra', async () => {
    const ultra = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a], effort: ultra }';
    const claude = makeHarness({ graph: ultra });
    open.push(claude);
    await claude.orch.tick();
    expect(claude.launchOf('T1')).toMatchObject({ runner: 'claude-code', effort: 'max' });
    expect(claude.store.listEvents({ kind: 'launch.created', taskId: 'T1' })[0]?.payload).toMatchObject({ runner: 'claude-code', effort: 'max', effortRequested: 'ultra' });
    expect(claude.orch.selectionFor('T1')).toEqual({ runner: 'claude-code', model: 'claude-opus-5-5', effort: 'max', effortRequested: 'ultra' });

    const codex = makeHarness({ graph: ultra, config: { runner: { kind: 'codex' } } });
    open.push(codex);
    await codex.orch.tick();
    expect(codex.launchOf('T1')).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'ultra' });
    expect(codex.store.listEvents({ kind: 'launch.created', taskId: 'T1' })[0]?.payload).not.toHaveProperty('effortRequested');
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
