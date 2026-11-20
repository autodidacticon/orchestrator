/**
 * The verify-job routes over HTTP on a remote run with a bare origin: claim, heartbeat, release, result, the job token
 * read from `Authorization: Bearer`, and the token kept out of status and events. The job is offered by hand, before
 * any tick, since the passthrough verifier would publish a queued job. See specs/verifier-pool.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

const harnesses: SliceHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

// Copied from test/slice/remote-seal.test.ts, which exports none of them.

/** A temp dir with the daemon's clone and a bare origin cloned from it. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-verify-routes-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const health = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const remoteRun = (bare: string) => ({
  leaseTtlMs: 60_000,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health,
});
const GRAPH = single('hang', ', description: d, acceptanceCriteria: [a]');

async function http(h: SliceHarness, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Start a run, admit T1 and claim its launch as a remote worker; also the worker claim's `repoUrl`. */
async function claimed(f: { dir: string; repo: string; bare: string }): Promise<{ h: SliceHarness; launch: Launch; repoUrl: unknown }> {
  const h = await makeSlice({ graph: GRAPH, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
  harnesses.push(h);
  await h.orch.tick();
  const c = await http(h, '/v1/claims', { workerId: 'w1', access: 'remote' });
  expect(c.status).toBe(200);
  const launch = h.store.getLaunch(String(c.body['launchId']))!;
  expect(launch).toMatchObject({ access: 'remote', worktree: '', status: 'live' });
  return { h, launch, repoUrl: c.body['repoUrl'] };
}

/** The worker's own clone of origin, on the launch branch at its base. */
function workerClone(f: { dir: string; bare: string }, launch: Launch): string {
  const clone = path.join(f.dir, `worker-${launch.launchNo}`);
  gitIn(f.dir, 'clone', '-q', f.bare, clone);
  gitIn(clone, 'checkout', '-q', '-b', launch.branch, launch.baseSha);
  return clone;
}

function commit(clone: string, file: string): string {
  writeFileSync(path.join(clone, file), `${file}\n`);
  gitIn(clone, 'add', file);
  gitIn(clone, 'commit', '-q', '-m', `add ${file}`);
  return gitIn(clone, 'rev-parse', 'HEAD');
}

const push = (clone: string, branch: string) => gitIn(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
const submit = (h: SliceHarness, launch: Launch, extra: Record<string, unknown>, seq = 1) =>
  http(h, `/v1/launches/${launch.launchId}/report`, { kind: 'submit', seq, summary: 'did it', acceptance: [{ criterion: 'a', evidence: 'e' }], ...extra }, launch.token);

async function getText(h: SliceHarness, route: string): Promise<string> {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`);
  expect(res.status).toBe(200);
  return res.text();
}

describe('slice: verify routes over HTTP', () => {
  it('claim, heartbeat, release, claim again, result; 401 without the header; 400 for an unstorable verifierId; no token in status or events', async () => {
    const f = fixture();
    const { h, launch, repoUrl } = await claimed(f);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    expect((await submit(h, launch, { sealedSha: tip })).body).toMatchObject({ accepted: true });

    // Offer the job by hand, before any tick.
    const [job] = h.store.listJobs({ taskId: 'T1' });
    const head = gitIn(f.bare, 'rev-parse', 'main');
    h.store.updateJob(job!.jobId, { status: 'checking', expectedHead: head, offer: { at: h.orch.now(), checkCommand: 'true' } });

    const bad = await http(h, '/v1/verify/claims', { verifierId: 'v\u0000x' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'verifierId' });

    const c1 = await http(h, '/v1/verify/claims', { verifierId: 'v1' });
    expect(c1.status).toBe(200);
    expect(c1.body).toMatchObject({ ok: true, repeated: false, jobId: job!.jobId, taskId: 'T1', branch: launch.branch, sealedSha: tip, expectedHead: head, checkCommand: 'true' });
    expect(repoUrl).toBeDefined();
    expect(c1.body['repoUrl']).toBe(repoUrl);
    const t1 = String(c1.body['token']);

    for (const op of ['heartbeat', 'result', 'release']) {
      const r = await http(h, `/v1/verify/${job!.jobId}/${op}`, op === 'result' ? { outcome: 'checkFailed' } : {});
      expect(r).toEqual({ status: 401, body: { error: 'unauthorized' } });
    }

    expect(await http(h, `/v1/verify/${job!.jobId}/heartbeat`, {}, t1)).toMatchObject({ status: 200, body: { ok: true, ttlMs: 60_000 } });
    expect(await http(h, `/v1/verify/${job!.jobId}/release`, { reason: 'terminating' }, t1)).toEqual({ status: 200, body: { ok: true } });

    const c2 = await http(h, '/v1/verify/claims', { verifierId: 'v2' });
    expect(c2).toMatchObject({ status: 200, body: { jobId: job!.jobId, repeated: false } });
    const t2 = String(c2.body['token']);
    expect(t2).not.toBe(t1);
    expect(await http(h, `/v1/verify/${job!.jobId}/result`, { outcome: 'verified', rebasedSha: tip, output: 'ok' }, t2)).toEqual({ status: 200, body: { ok: true } });
    expect(h.store.getJob(job!.jobId)!.result).toMatchObject({ outcome: 'verified', rebasedSha: tip, verifierId: 'v2' });

    const status = await getText(h, '/v1/status');
    const events = await getText(h, '/v1/events?limit=500');
    expect(events).toContain('verify.claimed');
    for (const t of [t1, t2]) {
      expect(status).not.toContain(t);
      expect(events).not.toContain(t);
    }
  }, 60_000);
});
