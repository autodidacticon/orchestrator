/**
 * The remote verifier backend (GH-32): under `verifier.mode: remote` the daemon offers each verify job over its API and
 * a verifier, played here by hand, claims it, rebases onto `expectedHead`, pushes `refs/verify/<jobId>` and posts the
 * result. The check command is `exit 9`, so a check run by the daemon would fail the task. See specs/verifier-pool.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { listRuns, startDaemon, stopDaemon, daemonCommand, health } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Launch, VerifierJob } from '../../src/state/store.js';
import { RemoteVerifierBackend } from '../../src/verify/remote.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness, scriptedAgent, tsxLoader } from './harness.js';

const harnesses: SliceHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

// ---- copied from test/slice/remote-seal.test.ts (module-local there) ----

/** A temp dir with the daemon's clone and a bare origin cloned from it. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-verifier-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}
type Fixture = ReturnType<typeof fixture>;

const healthCfg = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const remoteRun = (bare: string) => ({
  leaseTtlMs: 60_000,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health: healthCfg,
});
const GRAPH = single('hang', ', description: d, acceptanceCriteria: [a]');

async function http(h: SliceHarness, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Admit and claim the next launch as a remote worker. */
async function claimed(h: SliceHarness, workerId = 'w1'): Promise<Launch> {
  await h.orch.tick();
  const c = await http(h, '/v1/claims', { workerId, access: 'remote' });
  expect(c.status).toBe(200);
  return h.store.getLaunch(String(c.body['launchId']))!;
}

/** The worker's own clone of origin, on the launch branch at its base. */
function workerClone(f: { dir: string; bare: string }, launch: Launch): string {
  const clone = path.join(f.dir, `worker-${launch.taskId}-${launch.launchNo}`);
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

// ---- this file's helpers ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A remote run under `verifier.mode: remote` whose backend is built here. */
async function remoteSlice(f: Fixture, opts: { graph?: string; config?: ConfigInput; git?: Record<string, unknown>; clock?: () => number } = {}): Promise<SliceHarness> {
  let h!: SliceHarness;
  const backend = new RemoteVerifierBackend({
    repo: f.repo,
    integrationBranch: 'main',
    tempRoot: path.join(f.dir, 'run', 'verify'),
    checkCommand: () => h.orch.effective().config.checkCommand,
    checkTimeoutMs: 60_000,
    ...(opts.clock ? { now: opts.clock } : {}),
  });
  const run = remoteRun(f.bare);
  h = await makeSlice({
    graph: opts.graph ?? GRAPH,
    dir: f.dir,
    repo: f.repo,
    verifier: backend,
    ...(opts.clock ? { clock: opts.clock } : {}),
    config: { ...run, verifier: { mode: 'remote' }, checkCommand: 'exit 9', ...opts.config, git: { ...run.git, pushRetryBackoffMs: 0, ...opts.git } },
  });
  harnesses.push(h);
  return h;
}

/** A worker claims the next launch, commits `file` and submits the pushed tip. */
async function workerSubmits(h: SliceHarness, f: Fixture, file = 'T1.txt', workerId = 'w1'): Promise<Launch> {
  const launch = await claimed(h, workerId);
  const clone = workerClone(f, launch);
  const tip = commit(clone, file);
  push(clone, launch.branch);
  expect(await submit(h, launch, { sealedSha: tip })).toMatchObject({ status: 200 });
  return launch;
}

const jobOf = (h: SliceHarness, taskId = 'T1'): VerifierJob => {
  const jobs = h.store.listJobs({ taskId });
  const j = jobs[jobs.length - 1];
  if (!j) throw new Error(`no job for ${taskId}`);
  return j;
};
/** The task's job is offered and holds no claim. */
const offeredFree = (h: SliceHarness, taskId = 'T1') => {
  const j = h.store.listJobs({ taskId }).at(-1);
  return j !== undefined && j.status === 'checking' && j.offer !== undefined && j.verifier === undefined && j.result === undefined && !j.applied;
};
const FIELDS = ['offer', 'verifier', 'token', 'result'] as const;
function expectNoClaim(job: VerifierJob): void {
  for (const k of FIELDS) expect(job[k], k).toBeUndefined();
}

interface Claim {
  jobId: string;
  token: string;
  branch: string;
  expectedHead: string;
  sealedSha: string;
  baseSha: string;
  checkCommand: string;
}

async function verifyClaim(h: SliceHarness, verifierId = 'v1'): Promise<Claim> {
  const c = await http(h, '/v1/verify/claims', { verifierId });
  expect(c.status).toBe(200);
  return c.body as unknown as Claim;
}

let verifierClones = 0;
/** The verifier's own clone of origin, detached at the claim's expected head, with the launch branch fetched. */
function verifierClone(f: Fixture, claim: Claim): string {
  const dir = path.join(f.dir, `verifier-${++verifierClones}`);
  gitIn(f.dir, 'clone', '-q', f.bare, dir);
  gitIn(dir, 'fetch', '-q', 'origin', `refs/heads/${claim.branch}`);
  gitIn(dir, 'checkout', '-q', '--detach', claim.expectedHead);
  return dir;
}

/** Rebase the sealed range onto `expectedHead` from the merge base and push it to `refs/verify/<jobId>`. */
function rebaseAndPush(f: Fixture, claim: Claim, pushRef = true): { dir: string; sha: string } {
  const dir = verifierClone(f, claim);
  const mb = gitIn(dir, 'merge-base', claim.expectedHead, claim.sealedSha);
  gitIn(dir, 'rebase', '-q', '--onto', claim.expectedHead, mb, claim.sealedSha);
  const sha = gitIn(dir, 'rev-parse', 'HEAD');
  if (pushRef) pushVerifyRef(dir, claim, sha);
  return { dir, sha };
}
const pushVerifyRef = (dir: string, claim: Claim, sha: string) => gitIn(dir, 'push', '-q', '--force', 'origin', `${sha}:refs/verify/${claim.jobId}`);

const postResult = (h: SliceHarness, claim: Claim, body: Record<string, unknown>) => http(h, `/v1/verify/${claim.jobId}/result`, { output: '', ...body }, claim.token);
const heartbeat = (h: SliceHarness, claim: Claim) => http(h, `/v1/verify/${claim.jobId}/heartbeat`, {}, claim.token);
const verifyRefs = (f: Fixture) => gitIn(f.dir, 'ls-remote', f.bare, 'refs/verify/*');
const requeued = (h: SliceHarness) => h.store.listEvents({ kind: 'verify.requeued' });

/** Submit T1 and wait for its job to be offered. */
async function offered(h: SliceHarness, f: Fixture): Promise<Launch> {
  const launch = await workerSubmits(h, f);
  await h.waitFor(() => offeredFree(h), 30_000);
  return launch;
}

describe('slice: remote verification', () => {
  it('a verified result is checked against refs/verify/<jobId>, squashed and published; the ref is deleted', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const claim = await verifyClaim(h);
    expect(claim.checkCommand).toBe('exit 9');
    const head = gitIn(f.bare, 'rev-parse', 'main');
    expect(claim.expectedHead).toBe(head);
    const { sha } = rebaseAndPush(f, claim);
    expect(await postResult(h, claim, { outcome: 'verified', rebasedSha: sha })).toMatchObject({ status: 200 });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);

    const main = gitIn(f.bare, 'rev-parse', 'main');
    expect(gitIn(f.bare, 'rev-list', '--count', `${head}..${main}`)).toBe('1');
    expect(gitIn(f.bare, 'rev-parse', `${main}^`)).toBe(claim.expectedHead);
    expect(gitIn(f.bare, 'rev-parse', `${main}^{tree}`)).toBe(gitIn(f.bare, 'rev-parse', `${sha}^{tree}`));
    expect(gitIn(f.bare, 'show', '-s', '--format=%(trailers:key=Orchestrator-Task,valueonly)', main)).toBe('T1');
    expect(gitIn(f.bare, 'show', '-s', '--format=%(trailers:key=Orchestrator-Launch,valueonly)', main)).toBe(jobOf(h).launchId);
    const job = jobOf(h);
    expect(job).toMatchObject({ status: 'published', verifiedSha: sha, publishedSha: main, changedFiles: ['T1.txt'] });
    expectNoClaim(job);
    expect(verifyRefs(f)).toBe('');
    expect(gitIn(f.repo, 'for-each-ref', 'refs/verify/')).toBe('');
    expect(existsSync(path.join(f.dir, 'run', 'verify'))).toBe(false);
  }, 60_000);

  const failures: Array<[string, Record<string, unknown>, (h: SliceHarness, job: VerifierJob) => void]> = [
    [
      'checkFailed',
      { outcome: 'checkFailed', output: 'boom' },
      (h, job) => {
        expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, carry: { verifierOutput: 'boom', priorFailure: { kind: 'checkFailed' } } });
        expect(job).toMatchObject({ status: 'failed', failureKind: 'checkFailed' });
      },
    ],
    ['checkTimeout', { outcome: 'checkTimeout', output: 'slow' }, (_h, job) => expect(job).toMatchObject({ status: 'failed', failureKind: 'checkTimeout' })],
    ['rebaseFailed', { outcome: 'rebaseFailed', output: 'cannot rebase' }, (_h, job) => expect(job).toMatchObject({ status: 'failed', failureKind: 'checkFailed' })],
    [
      'conflict',
      { outcome: 'conflict', conflictFiles: ['shared.txt'] },
      (h, job) => {
        expect(h.orch.entry('T1')).toMatchObject({ integrationRetries: 1, carry: { conflict: { files: ['shared.txt'] } } });
        expect(job).toMatchObject({ status: 'conflict', conflictFiles: ['shared.txt'] });
      },
    ],
  ];
  for (const [name, body, check] of failures) {
    it(`a ${name} result is the job's outcome, without the claim fields`, async () => {
      const f = fixture();
      const h = await remoteSlice(f);
      await offered(h, f);
      const claim = await verifyClaim(h);
      // Paused, so the task is not admitted again in the tick that applies the outcome.
      h.orch.pause();
      expect(await postResult(h, claim, body)).toMatchObject({ status: 200 });
      await h.waitFor(() => jobOf(h).applied, 30_000);
      expect(h.orch.entry('T1').status.kind).toBe('unstarted');
      const job = jobOf(h);
      check(h, job);
      expectNoClaim(job);
    }, 60_000);
  }

  it('a checkFailed result after a gap that began after the offer requeues the job once, uncharged', async () => {
    const f = fixture();
    const clock = { value: Date.now() };
    const h = await remoteSlice(f, { clock: () => clock.value });
    await offered(h, f);
    const claim = await verifyClaim(h);
    clock.value += 61_000; // more than health.gapAfterMs (60000) in one step
    h.orch.noteClock();
    expect(await postResult(h, claim, { outcome: 'checkFailed', output: 'boom' })).toMatchObject({ status: 200 });
    await h.waitFor(() => jobOf(h).status === 'queued', 30_000);
    const job = jobOf(h);
    expect(job).toMatchObject({ status: 'queued', gapRequeues: 1 });
    expectNoClaim(job);
    const events = requeued(h);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ gap: { failureKind: 'checkFailed' } });
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'submitted' }, attempts: 0 });
  }, 60_000);

  it('the ref is refused when missing, at another commit, or not descended from expectedHead; the third refusal blocks', async () => {
    const f = fixture();
    const h = await remoteSlice(f, { git: { pushRefusalLimit: 3 } });
    await offered(h, f);

    // 1. Verified, but the ref was never pushed.
    let claim = await verifyClaim(h);
    const { dir, sha } = rebaseAndPush(f, claim, false);
    const ref = `refs/verify/${claim.jobId}`;
    await postResult(h, claim, { outcome: 'verified', rebasedSha: sha });
    await h.waitFor(() => requeued(h).length === 1 && offeredFree(h), 30_000);

    // 2. The ref holds another commit than the reported one.
    claim = await verifyClaim(h, 'v2');
    pushVerifyRef(dir, claim, claim.expectedHead);
    await postResult(h, claim, { outcome: 'verified', rebasedSha: sha });
    await h.waitFor(() => requeued(h).length === 2 && offeredFree(h), 30_000);
    for (const e of requeued(h)) {
      expect(e.payload).toMatchObject({ retry: 'refused' });
      expect(String(e.payload?.['reason'])).toContain(ref);
    }

    // 3. An orphan commit that does not descend from expectedHead.
    claim = await verifyClaim(h, 'v3');
    const orphan = gitIn(dir, 'commit-tree', `${sha}^{tree}`, '-m', 'orphan');
    pushVerifyRef(dir, claim, orphan);
    await postResult(h, claim, { outcome: 'verified', rebasedSha: orphan });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'blocked', 30_000);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'blocked', reason: { kind: 'pushRefused' } }, attempts: 0 });
    expect(requeued(h)).toHaveLength(2);
    expect(gitIn(f.dir, 'ls-remote', f.bare, ref)).toBe('');
  }, 60_000);

  it('originFailed results are requeued with their classification and count refusals, spending no attempt', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const outputs = [' ! [remote rejected] HEAD -> refs/verify/x (hook declined)', 'fatal: Authentication failed for origin', "fatal: unable to access: Could not resolve host: origin.invalid"];
    for (const [i, output] of outputs.entries()) {
      const claim = await verifyClaim(h, `v${i}`);
      await postResult(h, claim, { outcome: 'originFailed', output });
      await h.waitFor(() => requeued(h).length === i + 1 && offeredFree(h), 30_000);
    }
    const payloads = requeued(h).map((e) => e.payload!);
    expect(payloads.map((p) => p['retry'])).toEqual(['refused', 'refused', 'unreachable']);
    expect(payloads.map((p) => p['refusals'])).toEqual([1, 2, 2]);
    expect(String(payloads[0]!['reason'])).toContain('v0');
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'submitted' }, attempts: 0 });
  }, 60_000);

  it('origin moved after the claim: the publication requeues once without retry, and the job is offered on the new head', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const claim = await verifyClaim(h);
    // Someone else publishes to origin's main.
    const other = path.join(f.dir, 'other');
    gitIn(f.dir, 'clone', '-q', f.bare, other);
    const moved = commit(other, 'other.txt');
    gitIn(other, 'push', '-q', 'origin', 'HEAD:main');
    const { sha } = rebaseAndPush(f, claim);
    await postResult(h, claim, { outcome: 'verified', rebasedSha: sha });
    await h.waitFor(() => requeued(h).length === 1 && offeredFree(h), 30_000);
    expect(requeued(h)[0]!.payload?.['retry']).toBeUndefined();
    expect(jobOf(h).expectedHead).toBe(moved);

    const second = await verifyClaim(h, 'v2');
    expect(second.expectedHead).toBe(moved);
    const again = rebaseAndPush(f, second);
    await postResult(h, second, { outcome: 'verified', rebasedSha: again.sha });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
    const files = gitIn(f.bare, 'ls-tree', '--name-only', 'main').split('\n');
    expect(files).toEqual(expect.arrayContaining(['T1.txt', 'other.txt']));
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(moved);
    expect(requeued(h)).toHaveLength(1);
  }, 60_000);

  it('lease, on the harness clock: one warning without a claim, an expired claim keeps the offer, and a second verifier publishes', async () => {
    const f = fixture();
    const clock = { value: Date.now() };
    const h = await remoteSlice(f, { clock: () => clock.value });
    const step = (ms: number) => {
      for (let left = ms; left > 0; left -= 30_000) {
        clock.value += Math.min(30_000, left);
        h.orch.noteClock();
      }
    };
    await offered(h, f);
    const jobId = jobOf(h).jobId;
    const warn = vi.spyOn(h.orch.log, 'warn');
    try {
      step(60_000);
      for (let i = 0; i < 2; i++) {
        await h.orch.tick();
        await sleep(30);
      }
      const waits = warn.mock.calls.filter((c) => c[0] === 'verify job waits for a verifier');
      expect(waits).toHaveLength(1);
      expect(waits[0]![1]).toMatchObject({ jobId, taskId: 'T1' });
    } finally {
      warn.mockRestore();
    }

    const first = await verifyClaim(h, 'v1');
    step(61_000);
    await h.orch.tick();
    await sleep(30);
    const job = jobOf(h);
    expect(job).toMatchObject({ status: 'checking', expectedHead: first.expectedHead });
    expect(job.offer).toBeDefined();
    expect(job.verifier).toBeUndefined();
    expect(requeued(h)).toHaveLength(0);

    const second = await verifyClaim(h, 'v2');
    expect(second.jobId).toBe(first.jobId);
    const { sha } = rebaseAndPush(f, second);
    await postResult(h, second, { outcome: 'verified', rebasedSha: sha });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
  }, 60_000);

  it('restart with a live lease keeps the claim; a result posted afterwards with the same token publishes', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const claim = await verifyClaim(h);
    await h.orch.stop();
    await h.restart();
    const job = jobOf(h);
    expect(job).toMatchObject({ status: 'checking', token: claim.token, verifier: { id: 'v1' } });
    expect(job.offer).toBeDefined();
    const { sha } = rebaseAndPush(f, claim);
    await h.orch.tick();
    expect(await postResult(h, claim, { outcome: 'verified', rebasedSha: sha })).toMatchObject({ status: 200 });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
  }, 60_000);

  it('a result posted while the daemon is stopped publishes after the restart, with no second claim', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const claim = await verifyClaim(h);
    const { sha } = rebaseAndPush(f, claim);
    await h.orch.stop();
    // The old server still answers.
    expect(await postResult(h, claim, { outcome: 'verified', rebasedSha: sha })).toMatchObject({ status: 200 });
    await h.restart();
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
    expect(h.store.listEvents({ kind: 'verify.claimed' })).toHaveLength(1);
  }, 60_000);

  it('stop() ends the wait at once and leaves the row unchanged', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    await verifyClaim(h);
    await sleep(50);
    const before = jobOf(h);
    expect(h.orch.verifierBusy()).toBe(true);
    const t0 = Date.now();
    await h.orch.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.orch.verifierBusy()).toBe(false);
    expect(jobOf(h)).toEqual(before);
  }, 60_000);

  it('a cancel drops a claimed job without a result and ends the wait with no tick; the token is refused', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const claim = await verifyClaim(h);
    const { sha } = rebaseAndPush(f, claim);
    const info = vi.spyOn(h.orch.log, 'info');
    try {
      const res = await fetch(`${h.orch.apiBaseUrl}/v1/tasks/T1/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      const job = jobOf(h);
      expect(job).toMatchObject({ status: 'dropped', applied: true, token: claim.token, verifier: { id: 'v1' } });
      expect(job.offer).toBeDefined();
      await vi.waitFor(() => expect(h.orch.verifierBusy()).toBe(false), { timeout: 1000, interval: 10 });
      expect(info.mock.calls.some((c) => c[0] === 'verifier job dropped mid-flight' && (c[1] as { jobId?: string })?.jobId === claim.jobId)).toBe(true);
    } finally {
      info.mockRestore();
    }
    expect((await heartbeat(h, claim)).status).toBe(401);
    expect((await postResult(h, claim, { outcome: 'verified', rebasedSha: sha })).status).toBe(401);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(claim.expectedHead);
  }, 60_000);

  it('a cancel after a stored result keeps the job, which is published and applied without a transition', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const head = gitIn(f.bare, 'rev-parse', 'main');
    const claim = await verifyClaim(h);
    const { sha } = rebaseAndPush(f, claim);
    await h.orch.stop();
    expect(await postResult(h, claim, { outcome: 'verified', rebasedSha: sha })).toMatchObject({ status: 200 });
    await h.restart();
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/tasks/T1/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(jobOf(h)).toMatchObject({ status: 'checking', result: { outcome: 'verified', rebasedSha: sha } });
    await h.waitFor(() => jobOf(h).applied, 30_000);
    expect(jobOf(h)).toMatchObject({ status: 'published', applied: true });
    expect(h.orch.entry('T1').status.kind).toBe('cancelled');
    const transitions = h.store.listEvents({ kind: 'transition', taskId: 'T1' });
    expect(transitions.at(-1)!.payload).toMatchObject({ trigger: 'cancel' });
    expect(gitIn(f.bare, 'rev-list', '--count', `${head}..main`)).toBe('1');
    expect(gitIn(f.dir, 'ls-remote', f.bare, `refs/verify/${claim.jobId}`)).toBe('');
  }, 60_000);

  it('a cascade over a done target drops a claimed job of a dependant and ends its wait', async () => {
    const f = fixture();
    const node = (id: string, deps: string) => `  - { id: ${id}, deps: [${deps}], behavior: "hang", description: d, acceptanceCriteria: [a] }`;
    const h = await remoteSlice(f, { graph: `nodes:\n${node('T1', '')}\n${node('T2', 'T1')}` });
    // Publish T1 through the hand-driven verifier.
    await offered(h, f);
    const c1 = await verifyClaim(h);
    await postResult(h, c1, { outcome: 'verified', rebasedSha: rebaseAndPush(f, c1).sha });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
    // T2's worker submits, and a verifier claims its job.
    await workerSubmits(h, f, 'T2.txt', 'w2');
    await h.waitFor(() => offeredFree(h, 'T2'), 30_000);
    const c2 = await verifyClaim(h);
    expect(c2.jobId).toBe(jobOf(h, 'T2').jobId);
    const info = vi.spyOn(h.orch.log, 'info');
    try {
      const res = await fetch(`${h.orch.apiBaseUrl}/v1/tasks/T1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cascade: true }) });
      expect(res.status).toBe(200);
      await h.waitFor(() => !h.orch.verifierBusy());
      expect(jobOf(h, 'T2')).toMatchObject({ status: 'dropped', applied: true });
      expect(h.orch.entry('T2').status.kind).toBe('unstarted');
      expect(info.mock.calls.some((c) => c[0] === 'verifier job dropped mid-flight' && (c[1] as { jobId?: string })?.jobId === c2.jobId)).toBe(true);
    } finally {
      info.mockRestore();
    }
    expect((await heartbeat(h, c2)).status).toBe(401);
  }, 60_000);

  it('a declared no-op is published at the head with no offer', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    const head = gitIn(f.bare, 'rev-parse', 'main');
    const launch = await claimed(h);
    const clone = workerClone(f, launch);
    push(clone, launch.branch);
    const statuses: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        statuses.push((await http(h, '/v1/verify/claims', { verifierId: 'poller' })).status);
        await sleep(50);
      }
    })();
    try {
      expect(await submit(h, launch, { sealedSha: launch.baseSha, noChanges: { justification: 'already there' } })).toMatchObject({ status: 200 });
      await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
    } finally {
      polling = false;
      await poller;
    }
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set([404]));
    expect(h.store.listEvents({ kind: 'verify.claimed' })).toHaveLength(0);
    expect(jobOf(h)).toMatchObject({ status: 'published', publishedSha: head });
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(head);
  }, 60_000);

  it('a verified result at expectedHead publishes at the head with no commit', async () => {
    const f = fixture();
    const h = await remoteSlice(f);
    await offered(h, f);
    const head = gitIn(f.bare, 'rev-parse', 'main');
    const claim = await verifyClaim(h);
    await postResult(h, claim, { outcome: 'verified', rebasedSha: claim.expectedHead });
    await h.waitFor(() => h.orch.entry('T1').status.kind === 'done', 30_000);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(head);
    expect(jobOf(h)).toMatchObject({ status: 'published', publishedSha: head, verifiedSha: head });
  }, 60_000);
});

// ---- the daemon process; copied from test/slice/container.test.ts (module-local there) ----

let dirs: string[] = [];
let children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-remote-verifier-daemon-'));
  dirs.push(d);
  return d;
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

interface Daemon {
  child: ChildProcess;
  home: string;
  repo: string;
  bare: string;
  runDir: string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

/** Run the daemon in the foreground on a remote run, with a bare origin cloned after the config is committed. */
function runDaemon(config: string[]): Daemon {
  const home = fresh();
  const root = fresh();
  const repo = realpathSync(makeRepo(root));
  const bare = path.join(root, 'origin.git');
  const lines = [`runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`, 'tickIntervalMs: 100', 'leaseTtlMs: 8000', 'retryWindowMs: 10000', 'capacity: 1', ...config.map((l) => l.replace('{bare}', bare))];
  writeFileSync(path.join(repo, 'orchestrator.yaml'), `${lines.join('\n')}\n`);
  gitIn(repo, 'add', 'orchestrator.yaml');
  gitIn(repo, 'commit', '-q', '-m', 'config');
  gitIn(root, 'clone', '-q', '--bare', repo, bare);
  const runDir = runPaths(repo, { ...process.env, ORCH_HOME: home }).runDir;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'graph.yaml'), 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n');
  return { ...spawnDaemon(home, repo), bare };
}

function spawnDaemon(home: string, repo: string): Omit<Daemon, 'bare'> {
  const env = { ...process.env, ORCH_HOME: home, ORCH_LOG_FORMAT: 'json' };
  const runDir = runPaths(repo, env).runDir;
  const { command, args } = daemonCommand();
  const child = spawn(command, [...args, '--repo', repo], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, at: Date.now() })));
  return { child, home, repo, runDir, stderr: () => err, exited };
}

/** The daemon advertises apiBaseUrl, which no test reaches: call the port it listens on instead. */
async function urlOf(d: Omit<Daemon, 'bare'>): Promise<string> {
  let url = '';
  await waitFor(async () => {
    const info = readDaemonJson(d.runDir);
    if (!info || info.pid !== d.child.pid || !info.port) return false;
    url = `http://127.0.0.1:${info.port}`;
    return (await health(url)) !== undefined;
  }, 20_000);
  return url;
}

async function post(url: string, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the daemon process under verifier.mode remote', () => {
  it('refuses to start with runner.access local, before it listens', async () => {
    const env = { ...process.env, ORCH_HOME: fresh() };
    const repo = realpathSync(makeRepo(fresh()));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), 'checkCommand: "true"\nverifier:\n  mode: remote\nrunner:\n  access: local\n');
    try {
      await expect(startDaemon({ repo, env })).rejects.toThrow(/verifier\.mode remote refused: runner\.access must be remote/);
    } finally {
      for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
    }
  }, 60_000);

  it('offers the job a worker submitted, and SIGTERM while it waits exits 0 at once leaving the claimed row', async () => {
    const d = runDaemon([
      'checkCommand: "exit 9"',
      'apiBaseUrl: "http://orchestrator.invalid"',
      'runner:\n  mode: pull\n  access: remote\n  claimWindowMs: 60000',
      'git:\n  pushIntegration: true\n  originUrl: "{bare}"\n  fetchIntervalMs: 0',
      'verifier:\n  mode: remote',
      'health:\n  stuckAfterMs: 0\n  stuckFailAfterMs: 0\n  reportGraceMs: 0',
    ]);
    const url = await urlOf(d);
    let claim: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
    await waitFor(async () => (claim = await post(url, '/v1/claims', { workerId: 'w1', access: 'remote' })).status === 200, 20_000);
    const launchId = String(claim.body['launchId']);
    const token = String(claim.body['token']);
    const branch = String(claim.body['branch']);
    const baseSha = String(claim.body['baseSha']);
    const clone = path.join(path.dirname(d.bare), 'worker');
    gitIn(path.dirname(d.bare), 'clone', '-q', d.bare, clone);
    gitIn(clone, 'checkout', '-q', '-b', branch, baseSha);
    const tip = commit(clone, 'T1.txt');
    push(clone, branch);
    const sub = await post(url, `/v1/launches/${launchId}/report`, { kind: 'submit', seq: 1, summary: 'did it', acceptance: [{ criterion: 'a', evidence: 'e' }], sealedSha: tip }, token);
    expect(sub.status).toBe(200);
    let vc: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
    await waitFor(async () => (vc = await post(url, '/v1/verify/claims', { verifierId: 'v1' })).status === 200, 30_000);
    expect(vc.body['checkCommand']).toBe('exit 9');

    const sentAt = Date.now();
    d.child.kill('SIGTERM');
    const exit = await d.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - sentAt).toBeLessThan(8000);
    expect(d.stderr()).not.toContain('shutdown grace elapsed');
    const store = new SqliteStore(path.join(d.runDir, 'store.sqlite'));
    try {
      const [job] = store.listJobs();
      expect(job).toMatchObject({ status: 'checking', jobId: vc.body['jobId'], token: vc.body['token'], verifier: { id: 'v1' } });
      expect(job!.offer).toMatchObject({ checkCommand: 'exit 9' });
    } finally {
      store.close();
    }
  }, 60_000);
});
