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

  it('the digest counts deferred candidates and drops to zero once the blocker publishes', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: commitAndSubmit, scope: ["src/**"] }\n  - { id: B, deps: [], behavior: hang, scope: ["src/api/**"] }`, config: { leaseTtlMs: 60_000 } });
    await h.orch.tick();
    const first = await get(h, '/v1/events?after=0&wait=0');
    expect(first.body['digest']).toMatchObject({ deferred: 1, running: ['A'] });
    expect((await get(h, '/v1/status')).body['deferred']).toEqual([{ id: 'B', reason: 'scopeOverlap', with: ['A'] }]);
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'done' && h!.orch.entry('B').status.kind === 'running', 20_000);
    const after = await get(h, '/v1/events?after=0&wait=0');
    expect(after.body['digest']).toMatchObject({ deferred: 0, running: ['B'] });
  });

  it('review bundle for a submitted milestone, error otherwise; status carries run facts', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, acceptanceCriteria: [works] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1], acceptanceCriteria: [demo runs] }`, realVerifier: true });
    expect((await get(h, '/v1/milestones/MVP/review')).status).toBe(409);
    expect((await get(h, '/v1/milestones/MVP/review?task=T1')).status).toBe(409);
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    const r = await get(h, '/v1/milestones/MVP/review');
    expect(r.status).toBe(200);
    const mvp = h.orch.entry('MVP');
    expect(r.body).toMatchObject({ milestone: 'MVP', integrationSha: mvp.integrationSha, reviewVersion: 1, tag: 'milestone/MVP/v1', acceptanceCriteria: ['demo runs'] });
    expect(String(r.body['diffStat'])).toContain('T1.txt');
    expect(r.body['closure']).toMatchObject([{ taskId: 'T1', status: 'done', summary: expect.stringContaining('T1 done') }]);
    expect((r.body['closure'] as Array<{ publishedSha: string }>)[0]?.publishedSha).toMatch(/^[0-9a-f]{40}$/);

    // The default answer is the index. See specs/operator-control "Review bundle".
    const bundleNow = async () => {
      const b = await h!.orch.reviewBundle('MVP');
      if (!b.ok) throw new Error(b.reason);
      return JSON.parse(JSON.stringify(b.bundle)) as Record<string, unknown>;
    };
    const viewFirst = (body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      expect(text.indexOf('"view"')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('"view"')).toBeLessThan(text.indexOf('"closure"'));
      expect(text.indexOf('"omitted"')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('"omitted"')).toBeLessThan(text.indexOf('"closure"'));
    };
    const bundle = await bundleNow();
    expect(r.body['view']).toBe('index');
    expect(r.body['baseline']).toBe(bundle['baseline']);
    expect(r.body['acceptanceCriteria']).toEqual(bundle['acceptanceCriteria']);
    expect(r.body['omitted']).toEqual([{ field: 'closure.acceptance', count: 1, fetch: expect.stringContaining('task=') }]);
    const entries = r.body['closure'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ taskId: 'T1', title: 'T1', summaryLength: String((bundle['closure'] as Array<{ summary: string }>)[0]!.summary).length, acceptanceCount: 1 });
    expect(entries[0]).not.toHaveProperty('acceptance');
    viewFirst(r.body);

    // The whole bundle, equal to Orchestrator.reviewBundle's.
    const full = await get(h, '/v1/milestones/MVP/review?full=true');
    expect(full.status).toBe(200);
    expect(full.body).toEqual({ ...(await bundleNow()), view: 'full', omitted: [] });
    viewFirst(full.body);

    // One task: its whole latest submit report, without proposals.
    const stored = h.store.getCompletionReport('T1')!;
    const report = {
      summary: 'T1 done in full',
      acceptance: [{ criterion: 'works', evidence: 'ran the demo' }],
      interfaces: ['GET /v1/thing'],
      decisions: ['kept the old name'],
      deviations: ['skipped the cache'],
      followUps: ['add a cache'],
      tests: ['test/thing.test.ts'],
      noChanges: { justification: 'nothing to change' },
    };
    h.store.putReport({ ...stored, body: { ...stored.body, ...report, proposals: [{ kind: 'task', title: 'a proposal' }] } });
    const one = await get(h, '/v1/milestones/MVP/review?task=T1');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ view: 'task', milestone: 'MVP', integrationSha: r.body['integrationSha'], reviewVersion: r.body['reviewVersion'], tag: r.body['tag'], omitted: [] });
    expect(one.body).not.toHaveProperty('diffStat');
    const oneEntries = one.body['closure'] as Array<Record<string, unknown>>;
    expect(oneEntries).toHaveLength(1);
    expect(oneEntries[0]).toMatchObject({ taskId: 'T1', status: 'done', acceptanceCriteria: ['works'], ...report });
    expect(oneEntries[0]!['publishedSha']).toMatch(/^[0-9a-f]{40}$/);
    expect(oneEntries[0]).not.toHaveProperty('proposals');
    viewFirst(one.body);

    // A node outside the closure, or not a task.
    for (const id of ['NOPE', 'MVP']) {
      const missing = await get(h, `/v1/milestones/MVP/review?task=${id}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ ok: false, reason: expect.stringContaining(id), closure: ['T1'] });
    }

    // Refused parameters name the parameter.
    const refused: Array<[string, string]> = [
      ['task=T1&full=true', 'full'],
      ['statLines=-1', 'statLines'],
      ['statLines=1.5', 'statLines'],
      ['statLines=', 'statLines'],
      ['summaryChars=abc', 'summaryChars'],
      ['full=yes', 'full'],
      ['task=', 'task'],
    ];
    for (const [qs, parameter] of refused) {
      const bad = await get(h, `/v1/milestones/MVP/review?${qs}`);
      expect(bad.status, qs).toBe(400);
      expect(bad.body, qs).toMatchObject({ ok: false, parameter, reason: expect.any(String) });
    }
    expect((await get(h, '/v1/milestones/MVP/review?full=false')).body['view']).toBe('index');
    expect((await get(h, '/v1/milestones/MVP/review?task=T1&statLines=5')).status).toBe(200);
    expect((await get(h, '/v1/milestones/MVP/review?full=true&summaryChars=5')).status).toBe(200);
    const s = await get(h, '/v1/status');
    expect(s.body).toMatchObject({ runDir: h.config.dataDir, graphPath: h.config.graphPath, daemonPid: process.pid, daemonUrl: h.orch.apiBaseUrl, external: [] });
    expect(s.body['latestSeq']).toBe(h.store.latestEventSeq());
    expect(s.body).toMatchObject({ stuck: [], cost: { runUsd: 0, byTask: {}, overrides: 0, unpricedLaunches: 0 }, tokens: { run: { input: 0, output: 0 }, byTask: {} }, budgets: { maxLaunchMs: h.config.budgets.maxLaunchMs, stuckAfterMs: h.config.health.stuckAfterMs } });
  });

  it('review index cuts follow review.summaryChars; a task cancelled with release has an entry with no report fields', async () => {
    h = await makeSlice({
      graph: `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, acceptanceCriteria: [works] }\n  - { id: T2, deps: [], behavior: hang, acceptanceCriteria: [never runs to the end] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1, T2] }`,
      config: { leaseTtlMs: 60_000, review: { summaryChars: 5 } },
    });
    await h.waitFor(() => h!.orch.entry('T2').status.kind === 'running', 20_000);
    const cancelled = await fetch(`${h.orch.apiBaseUrl}/v1/tasks/T2/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'not needed', release: true }) });
    expect(cancelled.status).toBe(200);
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    expect(h.store.getCompletionReport('T2')).toBeUndefined();

    const idx = await get(h, '/v1/milestones/MVP/review');
    expect(idx.status).toBe(200);
    const entries = idx.body['closure'] as Array<{ taskId: string; summary: string; summaryLength: number; acceptanceCount: number }>;
    expect(entries.map((e) => e.taskId).sort()).toEqual(['T1', 'T2']);
    for (const e of entries) expect(e.summary.length).toBeLessThanOrEqual(5);
    expect(entries.find((e) => e.taskId === 'T1')).toMatchObject({ summary: 'T1 do', acceptanceCount: 1 });
    expect(entries.find((e) => e.taskId === 'T1')!.summaryLength).toBeGreaterThan(5);
    expect(entries.find((e) => e.taskId === 'T2')).toMatchObject({ summary: '', summaryLength: 0, acceptanceCount: 0 });
    const zero = await get(h, '/v1/milestones/MVP/review?summaryChars=0');
    expect((zero.body['closure'] as Array<{ summary: string }>).map((e) => e.summary)).toEqual(['', '']);

    const t2 = await get(h, '/v1/milestones/MVP/review?task=T2');
    expect(t2.status).toBe(200);
    const [entry] = t2.body['closure'] as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ taskId: 'T2', title: 'T2', status: 'cancelled', acceptanceCriteria: ['never runs to the end'] });
    for (const k of ['summary', 'acceptance', 'interfaces', 'decisions', 'deviations', 'followUps', 'tests', 'noChanges', 'proposals']) expect(entry).not.toHaveProperty(k);
  });
});
