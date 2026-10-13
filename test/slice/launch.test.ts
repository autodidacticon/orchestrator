import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recover } from '../../src/launch/recovery.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { gitIn, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('slice: launch, API, recovery', () => {
  it('commitAndSubmit: worktree created and removed, branch retained, task done, launch ended', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect(existsSync(l.worktree)).toBe(true);
    expect(existsSync(path.join(l.worktree, '.orchestrator', 'brief.md'))).toBe(true);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.getLaunch(l.launchId)?.status).toBe('ended');
    expect(existsSync(l.worktree)).toBe(false);
    expect(gitIn(h.repo, 'rev-parse', '--verify', l.branch)).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(h.repo, 'log', '--format=%s', l.branch)).toContain('T1: T1.txt');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.sealedSha).toBe(gitIn(h.repo, 'rev-parse', l.branch));
    expect(existsSync(path.join(h.config.dataDir, 'logs', `${l.launchId}.log`))).toBe(true);
    expect(h.pidEvents().some((e) => e.includes('exit'))).toBe(true);
  });

  it('dirty submit gets 409, then succeeds with the same seq', async () => {
    h = await makeSlice({ graph: single('submitDirtyThenFix') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
  });

  it('sealing ignores later commits', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'first');
    const first = gitIn(l.worktree, 'rev-parse', 'HEAD');
    const res = await h.orch.agentCall(l.launchId, l.token, 'report', { seq: 1, kind: 'submit', summary: 's' });
    expect(res.body).toMatchObject({ accepted: true, sealedSha: first });
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.sealedSha).toBe(first);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.publishedSha).toBe(first);
  });

  it('undeclared no-op fails and declared no-op passes', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: noopUndeclared }\n  - { id: B, deps: [], behavior: noopDeclared }` });
    await h.waitFor(() => h!.orch.entry('B').status.kind === 'done' && h!.orch.entry('A').attempts >= 1);
    expect(h.store.listEvents({ kind: 'transition', taskId: 'A' }).some((e) => e.payload?.['to'] === 'failed')).toBe(true);
  });

  it('missing acceptance evidence fails the submission', async () => {
    h = await makeSlice({ graph: single('submitNoEvidence', ', acceptanceCriteria: [works]') });
    await h.waitFor(() => h!.orch.entry('T1').attempts >= 1);
    const r = h.store.getReport(h.store.listLaunches({ taskId: 'T1' })[0]!.launchId);
    expect(r?.kind).toBe('submit');
    const failed = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).find((e) => e.payload?.['to'] === 'failed');
    expect(failed).toBeDefined();
    expect(h.orch.entry('T1').status.kind === 'running' || h.orch.entry('T1').status.kind === 'unstarted').toBe(true);
  });

  it('HTTP: token scoping and same-seq replay', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const url = `${h.orch.apiBaseUrl}/v1/launches/${l.launchId}/heartbeat`;
    const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(bad.status).toBe(401);
    const ok = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(ok.status).toBe(200);
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'x');
    const post = () =>
      fetch(`${h!.orch.apiBaseUrl}/v1/launches/${l.launchId}/report`, {
        method: 'POST',
        headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seq: 1, kind: 'submit', summary: 'via http' }),
      }).then((r) => r.json());
    const a = await post();
    const b = await post();
    expect(a).toEqual(b);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
  });

  it('block, answer, admission, resume through the real long-poll', async () => {
    h = await makeSlice({ graph: single('blockAndWait:which db?') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');
    expect(h.orch.status().openQuestions).toEqual(['T1']);
    expect(h.orch.answer('T1', 'postgres')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const l = h.store.listLaunches({ taskId: 'T1' })[0]!;
    expect(gitIn(h.repo, 'show', `${l.branch}:T1.txt`)).toBe('answer: postgres');
    expect(h.orch.entry('T1').launches).toBe(1);
  });

  it('maxWait degrades to blocked; a later answer becomes a new launch with the answer in its brief', async () => {
    h = await makeSlice({ graph: single('blockAndWait:pick'), config: { maxWaitMs: 500 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { message: 'pick' } });
    await h.waitFor(() => h!.pidEvents().some((e) => e.includes('timeout')));
    expect(h.orch.answer('T1', 'b')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const launches = h.store.listLaunches({ taskId: 'T1' });
    expect(launches).toHaveLength(2);
    const l2 = launches[1]!;
    expect(l2.launchNo).toBe(2);
    expect(JSON.parse(gitIn(h.repo, 'show', `${l2.branch}:T1.txt`).length ? '{}' : '{}')).toEqual({});
    expect(gitIn(h.repo, 'show', `${l2.branch}:T1.txt`)).toBe('answer: b');
  });

  it('offline submission via the fallback file is applied on process exit', async () => {
    h = await makeSlice({ graph: single('offlineSubmit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listEvents({ kind: 'agent.fallback' })).toHaveLength(1);
    expect(h.store.getCompletionReport('T1')?.body['summary']).toBe('offline submission');
  });

  it('fallback block becomes blocked with the question', async () => {
    h = await makeSlice({ graph: single('blockThenExit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsAccess', message: 'need credentials' } });
  });

  it('exit without report fails the attempt; lease expiry reaps a hung agent only when the runner cannot observe it', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: exitSilently }`, config: { leaseTtlMs: 800, maxAttempts: 1 } });
    await h.orch.tick();
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'blocked', 20_000);
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('exitedWithoutReport') } });

    const h2 = await makeSlice({ graph: `nodes:\n  - { id: B, deps: [], behavior: hang }`, config: { leaseTtlMs: 800, maxAttempts: 1 }, unobserved: true });
    try {
      await h2.orch.tick();
      const lb = h2.launchOf('B');
      await h2.waitFor(() => h2.orch.entry('B').status.kind === 'blocked', 20_000);
      expect(h2.orch.entry('B').status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('leaseExpired') } });
      expect(pidAlive(lb.pid!)).toBe(false);
    } finally {
      await h2.cleanup();
    }
  });

  it('heartbeats keep a slow agent alive past the TTL', async () => {
    h = await makeSlice({ graph: single('heartbeatThenSubmit:1500'), config: { leaseTtlMs: 700 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    expect(h.orch.entry('T1').attempts).toBe(0);
  });

  it('revoked launch: calls get 401, commits stay on its branch, nothing changes', async () => {
    h = await makeSlice({ graph: single('ignore401') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const before = h.orch.entry('T1');
    // Revoke before the agent's first call, as recovery does for a launch whose spawn it could not confirm.
    h.store.updateLaunch(l.launchId, { status: 'revoked' });
    const mainBefore = gitIn(h.repo, 'rev-parse', 'main');
    const deadline = Date.now() + 20_000;
    while (!h.pidEvents().some((e) => e.includes('got401')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    expect(h.pidEvents().filter((e) => e.includes('got401')).length).toBeGreaterThan(0);
    expect(h.orch.entry('T1')).toEqual(before);
    expect(gitIn(h.repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(0);
    expect(Number(gitIn(h.repo, 'rev-list', '--count', `${l.branch}`))).toBeGreaterThan(1);
    await h.runner.reap(l);
  });

  it('recovery: launch stuck in launching is revoked, killed by launch id, and relaunched on the same attempt', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    // Simulate a crash between spawn and pid record.
    h.store.updateLaunch(l1.launchId, { status: 'launching', pid: undefined, spawnedAt: undefined });
    await h.restart();
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('revoked');
    expect(existsSync(l1.worktree)).toBe(false);
    for (let i = 0; i < 40 && pidAlive(l1.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(l1.pid!)).toBe(false);
    const l2 = h.launchOf('T1');
    expect(l2.launchId).not.toBe(l1.launchId);
    expect(l2.attempt).toBe(1);
    expect(l2.launchNo).toBe(2);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 2, status: { kind: 'running' } });
  });

  it('recovery: a live launch with a surviving process is adopted', async () => {
    h = await makeSlice({ graph: single('slowSubmit:1500') });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    await h.restart();
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('live');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
  });

  it('recovery: stray worktree is swept', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const l = h.store.listLaunches({ taskId: 'T1' })[0]!;
    mkdirSync(path.dirname(l.worktree), { recursive: true });
    gitIn(h.repo, 'worktree', 'add', '--detach', l.worktree, 'main');
    expect(await h.workspace.listWorktrees()).toEqual([l.launchId]);
    await recover(h.orch);
    expect(await h.workspace.listWorktrees()).toEqual([]);
  });
});
