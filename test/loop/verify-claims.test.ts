import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import type { ApiResponse } from '../../src/loop/orchestrator.js';
import type { VerifierJob } from '../../src/state/store.js';
import { claimVerifyJob, postVerifyResult, releaseVerifyJob, verifyHeartbeat, verifyJobChanged, wakeVerifyWaiters } from '../../src/verify/claims.js';
import { VERIFIER_ERROR } from '../../src/verifier/loop.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * The daemon side of the verify-job claim protocol: claim, job token, lease, result, release and the waiters.
 * Jobs are offered by hand (no production code offers one yet). See specs/verifier-pool.
 */
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ONE = `nodes:
  - { id: A }`;
const TWO = `nodes:
  - { id: A }
  - { id: B }`;
const HEAD = 'a'.repeat(40);
const URL = 'file:///origin.git';

function harness(config: ConfigInput = {}, graph = ONE): Harness {
  const h = makeHarness({
    graph,
    config: {
      git: { workerOriginUrl: URL },
      ...config,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  return h;
}

const TTL = (h: Harness) => h.orch.config.leaseTtlMs;
const events = (h: Harness, kind: string) => h.store.listEvents({ kind });
const job = (h: Harness, jobId: string) => h.store.getJob(jobId)!;

/** Admit and submit `taskId`, then offer its job by hand as the remote backend would. */
async function offered(h: Harness, taskId = 'A', checkCommand = 'true'): Promise<VerifierJob> {
  if (!h.store.listLaunches({ taskId, status: 'live' }).length) await h.orch.tick();
  const r = await h.submit(taskId);
  expect(r.body).toMatchObject({ accepted: true });
  const [j] = h.store.listJobs({ taskId });
  h.store.updateJob(j!.jobId, { status: 'checking', expectedHead: HEAD, offer: { at: h.now.value, checkCommand } });
  return job(h, j!.jobId);
}

/** Another offered job on an existing launch, created straight in the store. */
function extraJob(h: Harness, base: VerifierJob, jobId: string, createdAt = h.now.value, launchId = base.launchId): VerifierJob {
  h.store.createJob({
    jobId,
    taskId: base.taskId,
    launchId,
    sealedSha: base.sealedSha,
    baseSha: base.baseSha,
    status: 'checking',
    expectedHead: HEAD,
    offer: { at: h.now.value, checkCommand: 'true' },
    applied: false,
    createdAt,
    updatedAt: createdAt,
  });
  return job(h, jobId);
}

const claim = (h: Harness, verifierId: unknown) => claimVerifyJob(h.orch, verifierId === undefined ? {} : { verifierId });
const tokenOf = (r: ApiResponse) => String(r.body['token']);

async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  return done;
}

describe('verify claim', () => {
  it('nothing offered: 404 and nothing written (a queued job, a checking job without offer, an offered job without launch row)', async () => {
    const h = harness({}, TWO);
    await h.orch.tick();
    await h.submit('A');
    await h.submit('B');
    const queued = h.store.listJobs({ taskId: 'A' })[0]!;
    const noOffer = h.store.listJobs({ taskId: 'B' })[0]!;
    h.store.updateJob(noOffer.jobId, { status: 'checking', expectedHead: HEAD });
    extraJob(h, job(h, noOffer.jobId), 'orphan', h.now.value, 'no-such-launch');
    const ids = [queued.jobId, noOffer.jobId, 'orphan'];
    const before = ids.map((id) => job(h, id));
    const seq = h.store.latestEventSeq();
    const r = await claim(h, 'v1');
    expect(r).toEqual({ status: 404, body: { error: 'nothing to verify' } });
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(ids.map((id) => job(h, id))).toEqual(before);
  });

  it('grant: the answer, the row and one verify.claimed event', async () => {
    const h = harness();
    const j = await offered(h);
    const launch = h.store.getLaunch(j.launchId)!;
    const r = await claim(h, 'v1');
    const ttl = TTL(h);
    const now = h.now.value;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      repeated: false,
      jobId: j.jobId,
      token: expect.stringMatching(/^[0-9a-f]{48}$/),
      taskId: 'A',
      branch: launch.branch,
      repoUrl: URL,
      integrationBranch: h.orch.config.integrationBranch,
      expectedHead: HEAD,
      sealedSha: j.sealedSha,
      baseSha: j.baseSha,
      noChanges: false,
      checkCommand: 'true',
      checkTimeoutMs: h.orch.config.checkTimeoutMs,
      leaseTtlMs: ttl,
      leaseExpiresAt: now + ttl,
      lease: { ttlMs: ttl, expiresAt: now + ttl, renewEveryMs: Math.floor(ttl / 3) },
    });
    expect(job(h, j.jobId)).toMatchObject({ status: 'checking', token: r.body['token'], verifier: { id: 'v1', claimedAt: now, expiresAt: now + ttl } });
    const ev = events(h, 'verify.claimed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ taskId: 'A', launchId: j.launchId, payload: { jobId: j.jobId, verifierId: 'v1', expectedHead: HEAD } });
    expect(JSON.stringify(h.store.listEvents())).not.toContain(tokenOf(r));
  });

  it('repeated claim renews the lease and appends nothing; another verifier gets 404; the oldest job is granted first', async () => {
    const h = harness();
    const j = await offered(h);
    const first = await claim(h, 'v1');
    h.advance(1000);
    const seq = h.store.latestEventSeq();
    const again = await claim(h, 'v1');
    expect(again.body).toMatchObject({ ok: true, repeated: true, jobId: j.jobId, token: first.body['token'], leaseExpiresAt: h.now.value + TTL(h) });
    expect(job(h, j.jobId).verifier!.expiresAt).toBe(h.now.value + TTL(h));
    expect(events(h, 'verify.claimed')).toHaveLength(1);
    const row = job(h, j.jobId);
    const other = await claim(h, 'v2');
    expect(other).toEqual({ status: 404, body: { error: 'nothing to verify' } });
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(job(h, j.jobId)).toEqual(row);

    // Two offered jobs: the older createdAt goes first, whatever the ids.
    const newer = extraJob(h, j, 'aaa-newer', h.now.value + 10);
    const older = extraJob(h, j, 'zzz-older', h.now.value + 5);
    expect((await claim(h, 'v3')).body['jobId']).toBe(older.jobId);
    expect((await claim(h, 'v4')).body['jobId']).toBe(newer.jobId);
  });

  it('refusals: a missing or blank verifierId answers 400, an unstorable one is refused naming verifierId, and none appends an event', async () => {
    const h = harness();
    const j = await offered(h);
    const seq = h.store.latestEventSeq();
    expect(await claim(h, undefined)).toEqual({ status: 400, body: { error: 'verifierId is required' } });
    expect(await claim(h, '   ')).toEqual({ status: 400, body: { error: 'verifierId is required' } });
    await expect(claim(h, 'v\u0000x')).rejects.toMatchObject({ code: 'unstorable', field: 'verifierId' });
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(job(h, j.jobId).verifier).toBeUndefined();
  });

  it('no repository URL: 404 while nothing is offered, 409 once a job is offered, nothing written', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'orch-norepo-'));
    dirs.push(empty);
    const h = makeHarness({ graph: ONE, config: { repoPath: empty, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 }, budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 } } });
    open.push(h);
    await h.orch.tick();
    await h.submit('A');
    const seq = h.store.latestEventSeq();
    const [j] = h.store.listJobs({ taskId: 'A' });
    const queued = job(h, j!.jobId);
    expect(await claim(h, 'v1')).toEqual({ status: 404, body: { error: 'nothing to verify' } });
    expect(job(h, j!.jobId)).toEqual(queued);
    h.store.updateJob(j!.jobId, { status: 'checking', expectedHead: HEAD, offer: { at: h.now.value, checkCommand: 'true' } });
    const row = job(h, j!.jobId);
    const r = await claim(h, 'v1');
    expect(r).toEqual({ status: 409, body: { ok: false, reason: 'no repository URL: set git.workerOriginUrl or git.originUrl' } });
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(job(h, j!.jobId)).toEqual(row);
  });

  it("check command: the offer's command, whatever command is in force now", async () => {
    const h = harness();
    await offered(h, 'A', 'true');
    expect(h.orch.setConfig({ checkCommand: 'make check' })).toMatchObject({ ok: true });
    expect((await claim(h, 'v1')).body['checkCommand']).toBe('true');
  });

  it('a pause and the hold after a gap stop no verify route', async () => {
    const h = harness({}, TWO);
    const a = await offered(h, 'A');
    h.orch.pause();
    expect(h.orch.isPaused()).toBe(true);
    const c1 = await claim(h, 'v1');
    expect(c1.status).toBe(200);
    expect(verifyHeartbeat(h.orch, a.jobId, tokenOf(c1)).status).toBe(200);
    expect(postVerifyResult(h.orch, a.jobId, tokenOf(c1), { outcome: 'checkFailed' }).status).toBe(200);

    const b = await offered(h, 'B');
    h.sleep(10 * 60_000);
    await h.orch.tick();
    expect(h.orch.inHold()).toBe(true);
    const c2 = await claim(h, 'v2');
    expect(c2).toMatchObject({ status: 200, body: { jobId: b.jobId } });
    expect(verifyHeartbeat(h.orch, b.jobId, tokenOf(c2)).status).toBe(200);
    expect(postVerifyResult(h.orch, b.jobId, tokenOf(c2), { outcome: 'checkFailed' }).status).toBe(200);
  });
});

describe('verify job token', () => {
  const calls = {
    heartbeat: (h: Harness, id: string, t: string) => verifyHeartbeat(h.orch, id, t),
    result: (h: Harness, id: string, t: string) => postVerifyResult(h.orch, id, t, { outcome: 'checkFailed' }),
    release: (h: Harness, id: string, t: string) => releaseVerifyJob(h.orch, id, t, {}),
  };
  const UNAUTH = { status: 401, body: { error: 'unauthorized' } };

  for (const [name, call] of Object.entries(calls)) {
    it(`${name}: 401 for a wrong token, an empty token, an unknown job, a job set back to queued and a dropped job; 200 with the right token`, async () => {
      const h = harness();
      const j = await offered(h);
      const token = tokenOf(await claim(h, 'v1'));
      expect(call(h, j.jobId, 'f'.repeat(48))).toEqual(UNAUTH);
      expect(call(h, j.jobId, '')).toEqual(UNAUTH);
      expect(call(h, 'no-such-job', token)).toEqual(UNAUTH);
      // A job without a token never passes, also with an empty token.
      const bare = extraJob(h, j, 'no-token');
      h.store.updateJob(bare.jobId, { offer: undefined });
      expect(call(h, bare.jobId, '')).toEqual(UNAUTH);

      const queued = extraJob(h, j, 'queued');
      const qt = tokenOf(await claim(h, 'vq'));
      h.store.updateJob(queued.jobId, { status: 'queued' });
      expect(job(h, queued.jobId).token).toBe(qt);
      expect(call(h, queued.jobId, qt)).toEqual(UNAUTH);

      const dropped = extraJob(h, j, 'dropped');
      const dt = tokenOf(await claim(h, 'vd'));
      h.store.dropJob(dropped.jobId);
      expect(job(h, dropped.jobId)).toMatchObject({ status: 'dropped', applied: true, token: dt });
      expect(call(h, dropped.jobId, dt)).toEqual(UNAUTH);

      expect(call(h, j.jobId, token)).toMatchObject({ status: 200, body: { ok: true } });
    });
  }
});

describe('verify lease', () => {
  it('heartbeat renews the lease, answers the lease facts and appends nothing', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    h.advance(1000);
    const seq = h.store.latestEventSeq();
    const ttl = TTL(h);
    const r = verifyHeartbeat(h.orch, j.jobId, token);
    expect(r).toEqual({ status: 200, body: { ok: true, ttlMs: ttl, expiresAt: h.now.value + ttl, renewEveryMs: Math.floor(ttl / 3) } });
    expect(job(h, j.jobId).verifier!.expiresAt).toBe(h.now.value + ttl);
    expect(h.store.latestEventSeq()).toBe(seq);
  });

  it('expiry: one tick ends a lease that ran out; heartbeats keep it; a job with a result is not expired', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    h.advance(TTL(h));
    await h.orch.tick();
    const ev = events(h, 'verify.leaseExpired');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ taskId: 'A', launchId: j.launchId, payload: { jobId: j.jobId, verifierId: 'v1' } });
    const row = job(h, j.jobId);
    expect(row.verifier).toBeUndefined();
    expect(row.token).toBeUndefined();
    expect(row).toMatchObject({ status: 'checking', offer: { checkCommand: 'true' } });
    expect(verifyHeartbeat(h.orch, j.jobId, token).status).toBe(401);
    const again = await claim(h, 'v2');
    expect(again).toMatchObject({ status: 200, body: { jobId: j.jobId, repeated: false } });
    expect(tokenOf(again)).not.toBe(token);

    // Heartbeats every third of the lease over three lease lengths keep the claim.
    for (let i = 0; i < 9; i++) {
      h.advance(Math.floor(TTL(h) / 3));
      expect(verifyHeartbeat(h.orch, j.jobId, tokenOf(again)).status).toBe(200);
      await h.orch.tick();
    }
    expect(events(h, 'verify.leaseExpired')).toHaveLength(1);
    expect(job(h, j.jobId).verifier?.id).toBe('v2');

    // A job that holds a result is not expired.
    expect(postVerifyResult(h.orch, j.jobId, tokenOf(again), { outcome: 'checkFailed' }).status).toBe(200);
    h.advance(2 * TTL(h));
    await h.orch.tick();
    expect(events(h, 'verify.leaseExpired')).toHaveLength(1);
    expect(job(h, j.jobId).verifier?.id).toBe('v2');
  });

  it('gap: a sleep renews the verify lease, and it expires a lease length after the wake', async () => {
    const h = harness();
    const j = await offered(h);
    await claim(h, 'v1');
    h.sleep(5 * TTL(h));
    const wake = h.now.value;
    await h.orch.tick();
    expect(events(h, 'daemon.gap').length).toBeGreaterThan(0);
    expect(events(h, 'verify.leaseExpired')).toHaveLength(0);
    expect(job(h, j.jobId).verifier!.expiresAt).toBeGreaterThanOrEqual(wake + TTL(h));
    h.advance(TTL(h));
    await h.orch.tick();
    expect(events(h, 'verify.leaseExpired')).toHaveLength(1);
    expect(job(h, j.jobId).verifier).toBeUndefined();
  });
});

describe('verify result', () => {
  it('stores the result once, with an event that carries no output; the job stays checking', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    const sha = 'ABCDEF0123'.repeat(4);
    const body = { outcome: 'verified', rebasedSha: sha, output: 'all good' };
    expect(postVerifyResult(h.orch, j.jobId, token, body)).toEqual({ status: 200, body: { ok: true } });
    const row = job(h, j.jobId);
    expect(row.result).toEqual({ outcome: 'verified', rebasedSha: sha.toLowerCase(), output: 'all good', conflictFiles: [], verifierId: 'v1', at: h.now.value });
    expect(row).toMatchObject({ status: 'checking', token, verifier: { id: 'v1' } });
    expect(row.rebasedSha).toBe(j.rebasedSha);
    expect(row.output).toBe(j.output);
    expect(row.conflictFiles).toEqual(j.conflictFiles);
    const ev = events(h, 'verify.result');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ taskId: 'A', launchId: j.launchId, payload: { jobId: j.jobId, verifierId: 'v1', outcome: 'verified' } });
    expect(ev[0]!.payload).not.toHaveProperty('output');

    expect(postVerifyResult(h.orch, j.jobId, token, body)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(postVerifyResult(h.orch, j.jobId, token, { outcome: 'bogus' })).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(events(h, 'verify.result')).toHaveLength(1);
    expect(job(h, j.jobId).result).toEqual(row.result);
  });

  it('body: the six outcomes are accepted; malformed bodies answer 400 naming the field; output keeps its last 65536 characters', async () => {
    const h = harness();
    const base = await offered(h);
    let n = 0;
    const fresh = async (): Promise<{ id: string; token: string }> => {
      const id = `job-${++n}`;
      extraJob(h, base, id, base.createdAt + n);
      const r = await claim(h, `v-${n}`);
      expect(r.body['jobId']).toBe(id);
      return { id, token: tokenOf(r) };
    };
    // The first offered job is claimed first, so every fresh job is the oldest claimable when it is claimed.
    await claim(h, 'v-base');
    for (const outcome of ['verified', 'checkFailed', 'checkTimeout', 'conflict', 'rebaseFailed', 'originFailed']) {
      const { id, token } = await fresh();
      const body = outcome === 'verified' ? { outcome, rebasedSha: 'b'.repeat(40) } : outcome === 'conflict' ? { outcome, conflictFiles: ['x.txt'] } : { outcome };
      expect(postVerifyResult(h.orch, id, token, body).status).toBe(200);
      expect(job(h, id).result?.outcome).toBe(outcome);
    }
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ outcome: 'nope' }, 'outcome'],
      [{}, 'outcome'],
      [{ outcome: 'verified' }, 'rebasedSha'],
      [{ outcome: 'checkFailed', rebasedSha: 'abc123' }, 'rebasedSha'],
      [{ outcome: 'checkFailed', output: 42 }, 'output'],
      [{ outcome: 'conflict', conflictFiles: 'x.txt' }, 'conflictFiles'],
      [{ outcome: 'conflict', conflictFiles: ['x', 3] }, 'conflictFiles'],
    ];
    const { id, token } = await fresh();
    for (const [body, field] of bad) {
      const r = postVerifyResult(h.orch, id, token, body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ field });
      expect(typeof r.body['error']).toBe('string');
      expect(job(h, id).result).toBeUndefined();
    }
    const long = 'x'.repeat(4464) + 'y'.repeat(65536);
    expect(long).toHaveLength(70000);
    expect(postVerifyResult(h.orch, id, token, { outcome: 'checkFailed', output: long }).status).toBe(200);
    expect(job(h, id).result?.output).toBe('y'.repeat(65536));
  });
});

describe('verify release', () => {
  it('hands the claim back; another verifier claims it; the old token is refused; a release after a result is 409', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    expect(releaseVerifyJob(h.orch, j.jobId, token, { reason: 'terminating' })).toEqual({ status: 200, body: { ok: true } });
    const row = job(h, j.jobId);
    expect(row.verifier).toBeUndefined();
    expect(row.token).toBeUndefined();
    expect(row).toMatchObject({ status: 'checking', offer: { checkCommand: 'true' } });
    const ev = events(h, 'verify.released');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ taskId: 'A', launchId: j.launchId, payload: { jobId: j.jobId, verifierId: 'v1', reason: 'terminating' } });

    const c2 = await claim(h, 'v2');
    expect(c2).toMatchObject({ status: 200, body: { jobId: j.jobId, repeated: false } });
    expect(tokenOf(c2)).not.toBe(token);
    expect(releaseVerifyJob(h.orch, j.jobId, token, {}).status).toBe(401);

    expect(releaseVerifyJob(h.orch, j.jobId, tokenOf(c2), { reason: 7 })).toMatchObject({ status: 400, body: { field: 'reason' } });
    expect(postVerifyResult(h.orch, j.jobId, tokenOf(c2), { outcome: 'checkFailed' }).status).toBe(200);
    const before = job(h, j.jobId);
    const seq = h.store.latestEventSeq();
    expect(releaseVerifyJob(h.orch, j.jobId, tokenOf(c2), {})).toEqual({ status: 409, body: { ok: false, reason: 'a result is already recorded' } });
    expect(job(h, j.jobId)).toEqual(before);
    expect(h.store.latestEventSeq()).toBe(seq);
  });

  it('a release without reason records the default', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    expect(releaseVerifyJob(h.orch, j.jobId, token, {}).status).toBe(200);
    expect(events(h, 'verify.released')[0]!.payload).toMatchObject({ reason: 'released by verifier' });
    expect(releaseVerifyJob(h.orch, j.jobId, token, {}).status).toBe(401);
  });
});

describe('verify waiters', () => {
  it('resolve at a grant, a result, a release, a lease expiry, a tick that changed nothing, and on wakeVerifyWaiters', async () => {
    const h = harness();
    const j = await offered(h);

    let p = verifyJobChanged(h.orch, j.jobId);
    expect(await settled(p)).toBe(false);
    const t1 = tokenOf(await claim(h, 'v1'));
    expect(await settled(p)).toBe(true);

    p = verifyJobChanged(h.orch, j.jobId);
    expect(releaseVerifyJob(h.orch, j.jobId, t1, {}).status).toBe(200);
    expect(await settled(p)).toBe(true);

    await claim(h, 'v2');
    p = verifyJobChanged(h.orch, j.jobId);
    h.advance(TTL(h));
    expect(await settled(p)).toBe(false);
    await h.orch.tick();
    expect(events(h, 'verify.leaseExpired')).toHaveLength(1);
    expect(await settled(p)).toBe(true);

    const t3 = tokenOf(await claim(h, 'v3'));
    p = verifyJobChanged(h.orch, j.jobId);
    expect(postVerifyResult(h.orch, j.jobId, t3, { outcome: 'checkFailed' }).status).toBe(200);
    expect(await settled(p)).toBe(true);

    p = verifyJobChanged(h.orch, j.jobId);
    const seq = h.store.latestEventSeq();
    await h.orch.tick();
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(await settled(p)).toBe(true);

    p = verifyJobChanged(h.orch, j.jobId);
    expect(await settled(p)).toBe(false);
    wakeVerifyWaiters(h.orch);
    expect(await settled(p)).toBe(true);
  });
});

describe('verify lease: a sleep inside the tick (GH-184)', () => {
  it('criterion 7: a sleep of five lease lengths in runner.liveness, before the verify phase, renews the verify lease instead of ending it', async () => {
    const h = harness({}, TWO);
    const j = await offered(h, 'A');
    // B's spawned launch is live, so the tick asks the runner for its liveness before the verify phase.
    expect(h.store.listLaunches({ taskId: 'B', status: 'live' })).toHaveLength(1);
    await claim(h, 'v1');
    h.advance(1000);
    await h.orch.tick();
    expect(events(h, 'verify.leaseExpired')).toHaveLength(0);
    const liveness = h.runner.liveness.bind(h.runner);
    let wake: number | undefined;
    h.runner.liveness = async (x) => {
      if (wake === undefined) {
        h.sleep(5 * TTL(h));
        wake = h.now.value;
      }
      return liveness(x);
    };
    await h.orch.tick();
    expect(wake).toBeDefined();
    expect(events(h, 'verify.leaseExpired')).toHaveLength(0);
    expect(job(h, j.jobId).verifier).toMatchObject({ id: 'v1' });
    expect(job(h, j.jobId).verifier!.expiresAt).toBeGreaterThanOrEqual(wake! + TTL(h));
  });
});

describe('verify lease: cycle cap (GH-184)', () => {
  it('criterion 3: two expiries and a verifierError release fail the job as verifierLost and spend an attempt; podTerminating is not counted', async () => {
    const h = harness();
    const j = await offered(h);
    expect(h.orch.entry('A').attempts).toBe(0);
    // 1: a lease expiry.
    await claim(h, 'v1');
    h.advance(TTL(h));
    await h.orch.tick();
    expect(job(h, j.jobId)).toMatchObject({ status: 'checking', leaseLosses: 1 });
    // A podTerminating release is not counted.
    let token = tokenOf(await claim(h, 'v2'));
    expect(releaseVerifyJob(h.orch, j.jobId, token, { reason: 'podTerminating' }).status).toBe(200);
    expect(job(h, j.jobId).leaseLosses).toBe(1);
    // 2: a verifierError release. Two events: the job is offered again as today.
    token = tokenOf(await claim(h, 'v3'));
    expect(releaseVerifyJob(h.orch, j.jobId, token, { reason: VERIFIER_ERROR }).status).toBe(200);
    expect(job(h, j.jobId)).toMatchObject({ status: 'checking', leaseLosses: 2, offer: { checkCommand: 'true' } });
    expect(events(h, 'verify.released').map((e) => e.payload?.['leaseLosses'])).toEqual([undefined, 2]);
    await h.orch.tick();
    expect(h.orch.entry('A').attempts).toBe(0);
    // 3: another expiry ends the job.
    expect(await claim(h, 'v4')).toMatchObject({ status: 200, body: { jobId: j.jobId, repeated: false } });
    h.advance(TTL(h));
    await h.orch.tick();
    const row = job(h, j.jobId);
    expect(row).toMatchObject({ status: 'failed', failureKind: 'verifierLost', leaseLosses: 3 });
    expect(row.output).toMatch(/\b3 times\b/);
    for (const k of ['offer', 'verifier', 'token', 'result'] as const) expect(row[k], k).toBeUndefined();
    expect(events(h, 'verify.leaseExpired').map((e) => e.payload?.['leaseLosses'])).toEqual([1, 3]);
    await h.orch.tick();
    expect(job(h, j.jobId).applied).toBe(true);
    expect(h.orch.entry('A').attempts).toBe(1);
    const failedBy = h.store.listEvents({ kind: 'transition', taskId: 'A' }).filter((e) => e.payload?.['to'] === 'failed');
    expect(failedBy).toHaveLength(1);
    expect(failedBy[0]!.payload).toMatchObject({ from: 'submitted', actor: 'verifier', trigger: 'verificationFailed' });
    expect(await claim(h, 'v5')).toEqual({ status: 404, body: { error: 'nothing to verify' } });
  });

  it('three verifierError releases end the job the same way', async () => {
    const h = harness();
    const j = await offered(h);
    for (let i = 1; i <= 3; i++) {
      const token = tokenOf(await claim(h, `v${i}`));
      expect(releaseVerifyJob(h.orch, j.jobId, token, { reason: VERIFIER_ERROR }).status).toBe(200);
    }
    expect(job(h, j.jobId)).toMatchObject({ status: 'failed', failureKind: 'verifierLost', leaseLosses: 3 });
  });
});

describe('verify size limits (GH-184)', () => {
  it('criterion 4: a reason is cut to 4096 characters, conflictFiles to 200 entries, and a 254-character verifierId answers 400', async () => {
    const h = harness();
    const j = await offered(h);
    const seq = h.store.latestEventSeq();
    expect(await claim(h, 'v'.repeat(254))).toMatchObject({ status: 400, body: { field: 'verifierId' } });
    expect(h.store.latestEventSeq()).toBe(seq);
    expect(job(h, j.jobId).verifier).toBeUndefined();
    let token = tokenOf(await claim(h, 'v'.repeat(253)));
    expect(job(h, j.jobId).verifier?.id).toHaveLength(253);
    expect(releaseVerifyJob(h.orch, j.jobId, token, { reason: 'r'.repeat(10_000) }).status).toBe(200);
    expect(events(h, 'verify.released')[0]!.payload?.['reason']).toBe('r'.repeat(4096));
    token = tokenOf(await claim(h, 'v2'));
    const files = Array.from({ length: 500 }, (_, i) => `f${i}.txt`);
    expect(postVerifyResult(h.orch, j.jobId, token, { outcome: 'conflict', conflictFiles: files, reason: 'x'.repeat(10_000) }).status).toBe(200);
    expect(job(h, j.jobId).result?.conflictFiles).toEqual(files.slice(0, 200));
    expect(job(h, j.jobId).result).not.toHaveProperty('reason');
  });
});

describe('verify size limits (GH-190)', () => {
  it('criterion 4: a conflictFiles entry of 10,000 characters is stored cut to 4096', async () => {
    const h = harness();
    const j = await offered(h);
    const token = tokenOf(await claim(h, 'v1'));
    const long = 'p'.repeat(10_000);
    expect(postVerifyResult(h.orch, j.jobId, token, { outcome: 'conflict', conflictFiles: [long, 'short.txt'] }).status).toBe(200);
    expect(job(h, j.jobId).result?.conflictFiles).toEqual(['p'.repeat(4096), 'short.txt']);
  });
});
