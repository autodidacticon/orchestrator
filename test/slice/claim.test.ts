import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function http(h: SliceHarness, method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const G = `nodes:
  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: T2, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: T3, deps: [T1], behavior: hang, description: d, acceptanceCriteria: [a] }
`;

describe('claim and release over the real API', () => {
  it('claims oldest first or by name, fences until claimed, re-claims idempotently, and reports workers', async () => {
    h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    await h.orch.tick();
    const [l1] = h.store.listLaunches({ taskId: 'T1' });
    const [l2] = h.store.listLaunches({ taskId: 'T2' });
    expect(l1?.status).toBe('claimable');
    expect((await http(h, 'POST', `/v1/launches/${l2!.launchId}/heartbeat`, {}, l2!.token)).status).toBe(401);
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w1', access: 'remote' })).status).toBe(501);
    expect((await http(h, 'POST', '/v1/claims', { workerId: '' })).status).toBe(400);

    const c1 = await http(h, 'POST', '/v1/claims', { workerId: 'w1' });
    expect(c1.status).toBe(200);
    expect(c1.body).toMatchObject({ launchId: l1!.launchId, taskId: 'T1', token: l1!.token, worktree: l1!.worktree, baseSha: l1!.baseSha, apiUrl: h.orch.apiBaseUrl, branch: 'task/T1/l1' });
    expect(existsSync(String(c1.body['briefPath']))).toBe(true);
    expect((c1.body['brief'] as { taskId: string; task: Record<string, unknown> }).task['description']).toBe('d');
    const claimed = h.store.getLaunch(l1!.launchId)!;
    expect(claimed).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(claimed.pid).toBeUndefined();
    const lease = h.orch.entry('T1').lease!;
    expect(lease.expiresAt - claimed.worker!.claimedAt).toBe(60_000);
    expect((await http(h, 'POST', `/v1/launches/${l1!.launchId}/heartbeat`, {}, l1!.token)).status).toBe(200);
    expect(h.store.listEvents({ kind: 'operator.claim' })).toHaveLength(3);

    const again = await http(h, 'POST', '/v1/claims', { workerId: 'w1' });
    expect(again.body).toMatchObject({ launchId: l1!.launchId, token: l1!.token, repeated: true });
    expect(h.store.getLaunch(l1!.launchId)?.worker).toEqual(claimed.worker);
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w1', taskId: 'T2' })).status).toBe(409);
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w2', taskId: 'T1' })).body).toMatchObject({ state: 'live' });
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w2', taskId: 'T9' })).status).toBe(404);
    const c2 = await http(h, 'POST', '/v1/claims', { workerId: 'w2', taskId: 'T2' });
    expect(c2.body).toMatchObject({ taskId: 'T2' });
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w3' })).body).toMatchObject({ paused: false });

    const status = await http(h, 'GET', '/v1/status');
    expect(status.body).toMatchObject({ runner: { mode: 'pull', claimWindowMs: 60_000 }, claimable: [], workers: [{ id: 'w1', taskId: 'T1', launchId: l1!.launchId }, { id: 'w2', taskId: 'T2' }] });
    const digest = (await http(h, 'GET', '/v1/events?after=0&limit=1')).body['digest'] as Record<string, unknown>;
    expect(digest['claimable']).toBe(0);

    // Release without progress: back to unstarted at no cost, worktree gone, a fresh claimable launch next tick.
    const rel = await http(h, 'POST', `/v1/launches/${c2.body['launchId']}/release`, { reason: 'busy elsewhere' });
    expect(rel.body).toMatchObject({ ok: true, outcome: 'unstarted', progressed: false });
    expect(h.orch.entry('T2')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(existsSync(String(c2.body['worktree']))).toBe(false);
    expect((await http(h, 'POST', `/v1/launches/${c2.body['launchId']}/heartbeat`, {}, String(c2.body['token']))).status).toBe(401);
    await h.orch.tick();
    const [, l2b] = h.store.listLaunches({ taskId: 'T2' }).sort((a, b) => a.launchNo - b.launchNo);
    expect(l2b).toMatchObject({ status: 'claimable', launchNo: 2 });
    expect(existsSync(l2b!.worktree)).toBe(true);
    expect(h.orch.status().claimable).toEqual(['T2']);
    expect(h.store.listEvents({ kind: 'operator.release' })).toHaveLength(1);

    // Release after progress: a failed attempt whose reason reaches the next brief.
    const c2b = await http(h, 'POST', '/v1/claims', { workerId: 'w2' });
    expect(c2b.body).toMatchObject({ launchId: l2b!.launchId });
    gitIn(String(c2b.body['worktree']), 'commit', '-q', '--allow-empty', '-m', 'partial');
    const rel2 = await http(h, 'POST', `/v1/launches/${l2b!.launchId}/release`, { reason: 'cannot finish' });
    expect(rel2.body).toMatchObject({ ok: true, outcome: 'failed', progressed: true });
    expect(h.orch.entry('T2')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 1 });
    await h.orch.tick();
    const l2c = h.store.listLaunches({ taskId: 'T2' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(l2c.launchNo).toBe(3);
    const c2c = await http(h, 'POST', '/v1/claims', { workerId: 'w2' });
    expect((c2c.body['brief'] as { context?: { priorFailure?: { kind: string; message: string } } }).context?.priorFailure).toMatchObject({ kind: 'released', message: 'cannot finish' });

    // Release while waiting degrades to blocked with the question; 409 for a launch without a worker.
    void http(h, 'POST', `/v1/launches/${l1!.launchId}/block`, { seq: 1, kind: 'needsDecision', message: 'which?' }, l1!.token);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting', 5000);
    const pendingClaim = await http(h, 'POST', '/v1/claims', { workerId: 'w1' });
    expect(pendingClaim.body).toMatchObject({ repeated: true, pending: { seq: 1, question: { message: 'which?' } } });
    const rel3 = await http(h, 'POST', `/v1/launches/${l1!.launchId}/release`, { reason: 'leaving' });
    expect(rel3.body).toMatchObject({ outcome: 'blocked' });
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { message: 'which?' } });
    expect((await http(h, 'POST', `/v1/launches/${l1!.launchId}/release`, { reason: 'again' })).status).toBe(409);

    // Paused: nothing can be claimed.
    h.orch.pause();
    expect((await http(h, 'POST', '/v1/claims', { workerId: 'w9' })).body).toMatchObject({ paused: true });
  }, 60_000);

  it('a re-claim carries the admitted answer, and a worker collects it with the same seq', async () => {
    h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    await h.orch.tick();
    const c = await http(h, 'POST', '/v1/claims', { workerId: 'w1', taskId: 'T1' });
    const launchId = String(c.body['launchId']);
    const token = String(c.body['token']);
    void http(h, 'POST', `/v1/launches/${launchId}/block`, { seq: 2, kind: 'needsDecision', message: 'left or right?' }, token);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting', 5000);
    expect((await http(h, 'POST', '/v1/tasks/T1/answer', { text: 'left' })).status).toBe(200);
    await h.orch.tick();
    expect(h.orch.entry('T1').status.kind).toBe('running');
    const again = await http(h, 'POST', '/v1/claims', { workerId: 'w1' });
    expect(again.body).toMatchObject({ launchId, repeated: true, pending: { seq: 2, answer: 'left' } });
    const replay = await http(h, 'POST', `/v1/launches/${launchId}/block`, { seq: 2, kind: 'needsDecision', message: 'left or right?' }, token);
    expect(replay.body).toEqual({ answer: 'left' });
    expect(h.orch.entry('T1').lease!.expiresAt).toBeGreaterThan(Date.now() + 50_000);
  }, 30_000);
});
