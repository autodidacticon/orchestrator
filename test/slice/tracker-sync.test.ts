import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { setTracker } from '../../src/state/store.js';
import { drainOnce, FakeTracker, relayOnce } from './fake-tracker.js';
import { makeSlice, type SliceHarness } from './harness.js';

const open: SliceHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.cleanup();
});

const trackerCfg = (over: Partial<Config['tracker']> = {}): Config['tracker'] => ({
  enabled: 'auto', maxAttempts: 3, parentInProgress: true, commentOnDone: false, commentOnFail: false, doneAt: 'integration', answersFromComments: true, ...over,
});

const node = (id: string, deps: string[], behavior: string, kind?: string) =>
  `  - { id: ${id}, title: "${id} title", deps: [${deps.join(', ')}], behavior: "${behavior}"${kind ? `, kind: ${kind}, gated: true` : ''}, url: "https://tracker.example/${id}", trackerState: open }`;

async function slice(graph: string, over: Partial<Config['tracker']> = {}, record = true): Promise<SliceHarness> {
  const h = await makeSlice({ graph, config: { tracker: trackerCfg(over), leaseTtlMs: 60_000, maxAttempts: 2 } });
  if (record) setTracker(h.store, { kind: 'linear', workspace: 'acme', recordedAt: 1 });
  open.push(h);
  return h;
}

async function post(h: SliceHarness, route: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('tracker sync through a fake tracker', () => {
  const G = ['nodes:', node('T1', [], 'blockAndWait:pick'), node('T2', ['T1'], 'commitAndSubmit'), node('T3', [], 'fail:cannot'), node('T5', [], 'hang'), node('MVP', ['T2'], '', 'milestone'), ''].join('\n');

  it('mirrors states and comments per issue through question, answer, exhaustion, publication, review, acceptance, and cancellation', async () => {
    const h = await slice(G);
    const tracker = new FakeTracker();
    const base = h.orch.apiBaseUrl;
    await h.orch.tick();
    // T1 may already be waiting on its question by the time the tick returns.
    expect([...h.orch.status().byStatus.running, ...h.orch.status().byStatus.waiting].sort()).toEqual(['T1', 'T3', 'T5']);
    await drainOnce(base, tracker);
    expect(tracker.states('T1')).toEqual(['started']);
    expect(tracker.states('T3')).toEqual(['started']);
    expect(tracker.states('T5')).toEqual(['started']);
    expect(tracker.states('MVP')).toEqual([]);

    await h.waitFor(() => h.orch.entry('T1').status.kind === 'waiting');
    await h.waitFor(() => h.orch.entry('T3').status.kind === 'blocked', 30_000);
    await drainOnce(base, tracker);
    expect(tracker.comments('T1')).toEqual([expect.stringContaining('pick')]);
    expect(tracker.comments('T1')[0]).toContain('- a\n- b');
    expect(tracker.issue('T1').comments[0]!.body).toMatch(/\n\n— orchestrator run \S+ · event \d+$/);
    expect(tracker.comments('T3')).toEqual([expect.stringContaining('attempts exhausted')]);
    expect(tracker.comments('T3')[0]).toContain('What would unblock it: y');
    expect(tracker.states('T3')).toEqual(['started']);

    expect((await post(h, '/v1/tasks/T1/answer', { text: 'b' })).status).toBe(200);
    await h.waitFor(() => h.orch.entry('MVP').status.kind === 'submitted', 30_000);
    await drainOnce(base, tracker);
    expect(tracker.states('T1')).toEqual(['started', 'completed']);
    expect(tracker.states('T2')).toEqual(['started', 'completed']);
    expect(tracker.states('MVP')).toEqual(['started']);
    const mvp = h.orch.entry('MVP');
    expect(tracker.comments('MVP')).toEqual([expect.stringContaining(`version 1 at ${mvp.integrationSha}`)]);
    expect(tracker.comments('MVP')[0]).toContain('- T2');
    expect(tracker.comments('T1')).toHaveLength(1);

    expect((await post(h, `/v1/milestones/MVP/accept`, { sha: mvp.integrationSha, version: 1 })).status).toBe(200);
    expect((await post(h, '/v1/tasks/T5/cancel', { reason: 'not needed' })).status).toBe(200);
    await h.orch.tick();
    await drainOnce(base, tracker);
    expect(tracker.states('MVP')).toEqual(['started', 'completed']);
    expect(tracker.comments('MVP')).toEqual([expect.stringContaining('ready for review'), `Milestone accepted: version 1 at ${mvp.integrationSha}.`]);
    expect(tracker.states('T5')).toEqual(['started', 'canceled']);
    expect(tracker.comments('T5')).toEqual([]);
    expect(tracker.comments('T2')).toEqual([]);

    const status = h.orch.status();
    expect(status.outboxPending).toBe(0);
    expect(status.trackerErrors).toEqual([]);
    const applied = h.store.listOutbox({ status: 'applied' });
    expect(applied.length).toBeGreaterThanOrEqual(12);
    expect(applied.every((e) => e.result && typeof e.result === 'object' && ('stateId' in (e.result as object) || 'commentId' in (e.result as object)))).toBe(true);
  }, 60_000);

  it('the same run without a tracker recorded produces no effects', async () => {
    const h = await slice(G, {}, false);
    await h.orch.tick();
    expect([...h.orch.status().byStatus.running, ...h.orch.status().byStatus.waiting].sort()).toEqual(['T1', 'T3', 'T5']);
    expect(h.store.listOutbox()).toEqual([]);
    expect(h.orch.status().outboxPending).toBe(0);
  });

  it('a drainer that died after posting is reconciled by the marker; rejections retry to the cap and hold later effects for the issue', async () => {
    const G2 = ['nodes:', node('T1', [], 'blockAndWait:pick'), node('T2', [], 'commitAndSubmit'), ''].join('\n');
    const h = await slice(G2);
    const tracker = new FakeTracker();
    const base = h.orch.apiBaseUrl;
    await h.orch.tick();
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'waiting');
    await h.waitFor(() => h.orch.entry('T2').status.kind === 'done', 30_000);
    const pending = h.store.listOutbox({ status: 'pending' });
    expect(pending.map((e) => [e.taskId, e.kind])).toEqual([
      ['T1', 'setState'], ['T2', 'setState'], ['T1', 'comment'], ['T2', 'setState'],
    ]);
    // A previous drainer posted the question and died before acknowledging.
    const question = pending.find((e) => e.taskId === 'T1' && e.kind === 'comment')!;
    const { commentId: earlier } = tracker.postComment('T1', `${String(question.payload['body'])}\n\n${String(question.payload['marker'])}`);
    // The tracker rejects T2's state.
    tracker.rejectState.set('T2', 'workflow has no started state');

    const first = await drainOnce(base, tracker);
    expect(first.rejected).toEqual([{ id: pending[1]!.id, error: 'workflow has no started state' }]);
    expect(first.skipped).toEqual([pending[3]!.id]);
    expect(tracker.issue('T1').comments).toHaveLength(1);
    expect(h.store.getOutbox(question.id)).toMatchObject({ status: 'applied', result: { commentId: earlier, found: true } });
    expect(h.store.getOutbox(pending[1]!.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(h.store.getOutbox(pending[3]!.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(tracker.states('T2')).toEqual([]);

    await drainOnce(base, tracker);
    const third = await drainOnce(base, tracker);
    expect(third.rejected).toHaveLength(1);
    expect(h.store.getOutbox(pending[1]!.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(h.orch.status().trackerErrors).toEqual([{ id: pending[1]!.id, taskId: 'T2', kind: 'setState', attempts: 3, error: 'workflow has no started state' }]);
    expect(h.store.getOutbox(pending[3]!.id)).toMatchObject({ status: 'pending', attempts: 0 });

    tracker.rejectState.delete('T2');
    const fourth = await drainOnce(base, tracker);
    expect(fourth.applied).toEqual([pending[3]!.id]);
    expect(tracker.states('T2')).toEqual(['completed']);
    expect(h.orch.status().outboxPending).toBe(0);
  }, 60_000);

  it('done at milestone acceptance end to end, and a human comment answers the question once', async () => {
    const G3 = ['nodes:', node('T1', [], 'blockAndWait:pick'), node('MVP', ['T1'], '', 'milestone'), ''].join('\n');
    const h = await slice(G3, { doneAt: 'milestoneAccepted' });
    const tracker = new FakeTracker();
    const base = h.orch.apiBaseUrl;
    const relayed = new Set<string>();
    await h.orch.tick();
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'waiting');
    await drainOnce(base, tracker);
    expect(await relayOnce(base, tracker, relayed)).toEqual([]);
    const human = tracker.humanComment('T1', 'b');
    const relays = await relayOnce(base, tracker, relayed);
    expect(relays).toMatchObject([{ task: 'T1', commentId: human, status: 200 }]);
    await h.waitFor(() => h.orch.entry('MVP').status.kind === 'submitted', 30_000);
    expect(await relayOnce(base, tracker, relayed)).toEqual([]);
    const late = await post(h, '/v1/tasks/T1/answer', { text: 'b again' });
    expect(late.status).toBe(409);
    expect(String(late.body['reason'])).toMatch(/T1 is done/);

    await drainOnce(base, tracker);
    expect(tracker.states('T1')).toEqual(['started']);
    expect(tracker.comments('T1')).toEqual([expect.stringContaining('pick'), expect.stringMatching(/^Integrated as [0-9a-f]+; the issue closes when its milestone is accepted\.$/)]);
    expect(tracker.states('MVP')).toEqual(['started']);
    const mvp = h.orch.entry('MVP');
    expect((await post(h, '/v1/milestones/MVP/accept', { sha: mvp.integrationSha, version: 1 })).status).toBe(200);
    await h.orch.tick();
    await drainOnce(base, tracker);
    expect(tracker.states('T1')).toEqual(['started', 'completed']);
    expect(tracker.states('MVP')).toEqual(['started', 'completed']);
    expect(h.orch.status().finished).toBe(true);
  }, 60_000);
});
