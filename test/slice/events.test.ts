import { afterEach, describe, expect, it } from 'vitest';
import { makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const get = async (h: SliceHarness, route: string) => {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('event stream, review bundle, status facts', () => {
  it('long-poll returns on the next event and returns empty at timeout', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
    await h.orch.tick();
    const seq = h.store.latestEventSeq();
    const t0 = Date.now();
    const pending = get(h, `/v1/events?after=${seq}&wait=30000`);
    setTimeout(() => void h!.orch.pause(), 500);
    const r = await pending;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((r.body['events'] as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['operator.pause']);
    expect(r.body['seq']).toBe(seq + 1);
    expect(r.body['digest']).toMatchObject({ graphLoaded: true, running: ['T1'], paused: true, pausedReason: 'operator', stuck: [], finished: false });
    const t1 = Date.now();
    const empty = await get(h, `/v1/events?after=${seq + 1}&wait=700`);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(600);
    expect(empty.body['events']).toEqual([]);
    expect(empty.body['seq']).toBe(seq + 1);
    const filtered = await get(h, `/v1/events?after=0&kinds=operator.pause,launch.live&limit=1`);
    expect(filtered.body['events']).toHaveLength(1);
  });

  it('review bundle for a submitted milestone, error otherwise; status carries run facts', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, acceptanceCriteria: [works] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1], acceptanceCriteria: [demo runs] }`, realVerifier: true });
    expect((await get(h, '/v1/milestones/MVP/review')).status).toBe(409);
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    const r = await get(h, '/v1/milestones/MVP/review');
    expect(r.status).toBe(200);
    const mvp = h.orch.entry('MVP');
    expect(r.body).toMatchObject({ milestone: 'MVP', integrationSha: mvp.integrationSha, reviewVersion: 1, tag: 'milestone/MVP/v1', acceptanceCriteria: ['demo runs'] });
    expect(String(r.body['diffStat'])).toContain('T1.txt');
    expect(r.body['closure']).toMatchObject([{ taskId: 'T1', status: 'done', summary: expect.stringContaining('T1 done') }]);
    expect((r.body['closure'] as Array<{ publishedSha: string }>)[0]?.publishedSha).toMatch(/^[0-9a-f]{40}$/);
    const s = await get(h, '/v1/status');
    expect(s.body).toMatchObject({ runDir: h.config.dataDir, graphPath: h.config.graphPath, daemonPid: process.pid, daemonUrl: h.orch.apiBaseUrl, external: [] });
    expect(s.body['latestSeq']).toBe(h.store.latestEventSeq());
    expect(s.body).toMatchObject({ stuck: [], cost: { runUsd: 0, byTask: {}, overrides: 0 }, budgets: { maxLaunchMs: h.config.budgets.maxLaunchMs, stuckAfterMs: h.config.health.stuckAfterMs } });
  });
});
