/**
 * ORC-86: publication waits for its durable record, and recovery looks on origin before declaring a commit lost.
 * Real git with a bare origin. See specs/integration-pipeline "Durable publishing record" and
 * specs/crash-recovery "Origin lookup before commit lost".
 */
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FatalInfo, type JournalSink, type RowOp, SqliteSink } from '../../src/state/journal.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierContext, VerifierOutcome } from '../../src/verify/job.js';
import { GitVerifierBackend, TRAILER_LAUNCH } from '../../src/verify/verifier.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
let sink: StallSink | undefined;
afterEach(async () => {
  sink?.release();
  await h?.cleanup();
  sink?.inner.close();
  h = undefined;
  sink = undefined;
});

class StallSink implements JournalSink {
  stalled = false;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly inner: SqliteSink) {}
  async applyBatch(ops: readonly RowOp[]): Promise<void> {
    while (this.stalled) await new Promise<void>((r) => this.waiting.push(r));
    await this.inner.applyBatch(ops);
  }
  stall(): void {
    this.stalled = true;
  }
  release(): void {
    this.stalled = false;
    for (const w of this.waiting.splice(0)) w();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until timed out');
    await sleep(25);
  }
}

/** A repository whose clone has `origin` set to a bare copy, as a fresh clone of origin would. */
function withOrigin(): { dir: string; repo: string; origin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-durable-publish-'));
  const repo = makeRepo(dir);
  const origin = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, origin);
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'fetch', '-q', 'origin');
  return { dir, repo, origin };
}

/** No volume: the clone is made again from origin at the same path, and the worktrees are gone. */
function freshClone(h: SliceHarness, origin: string): void {
  rmSync(h.repo, { recursive: true, force: true });
  gitIn(path.dirname(h.repo), 'clone', '-q', origin, h.repo);
  rmSync(path.join(h.config.dataDir, 'worktrees'), { recursive: true, force: true });
}

const pushOn = (origin: string) => ({ git: { pushIntegration: true, originUrl: origin, fetchIntervalMs: 0 } });
const launchCommits = (repo: string, launchId: string) => gitIn(repo, 'log', '--first-parent', '--format=%H', '-F', `--grep=${TRAILER_LAUNCH}: ${launchId}`, 'main').split('\n').filter(Boolean);

/** A check that marks its start and then waits for the test to let it finish. */
function gatedCheck(dir: string): { command: string; started: string; go: string } {
  const started = path.join(dir, 'check-started');
  const go = path.join(dir, 'check-go');
  return { started, go, command: `touch '${started}'; while [ ! -e '${go}' ]; do sleep 0.05; done` };
}

describe('durable publishing record', () => {
  it('with a sink that stalls after the check started, neither the integration branch nor origin moves until the publishing record is accepted', async () => {
    const o = withOrigin();
    const check = gatedCheck(o.dir);
    sink = new StallSink(new SqliteSink(path.join(o.dir, 'sink.sqlite')));
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: o.dir, repo: o.repo, config: { ...pushOn(o.origin), checkCommand: check.command }, journal: { sink } });
    const before = { clone: gitIn(o.repo, 'rev-parse', 'main'), origin: gitIn(o.origin, 'rev-parse', 'main') };
    // Tick until the check runs; waitFor returns between ticks, so no tick is in flight from here on.
    // The agent has exited and its launch ended, so nothing but the verifier waits on the store once it stalls.
    await h.waitFor(() => existsSync(check.started) && h!.store.listLaunches({ taskId: 'T1', status: 'live' }).length === 0, 30_000);
    sink.stall();
    writeFileSync(check.go, '');
    await until(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'publishing');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.squashSha).toBeTruthy();
    await sleep(600);
    expect(gitIn(o.repo, 'rev-parse', 'main')).toBe(before.clone);
    expect(gitIn(o.origin, 'rev-parse', 'main')).toBe(before.origin);
    expect(launchCommits(o.origin, job.launchId)).toEqual([]);
    expect(h.store.durability().pendingBatches).toBeGreaterThan(0);
    expect(h.orch.verifierBusy()).toBe(true);

    sink.release();
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const published = h.store.getJob(job.jobId)!;
    expect(published).toMatchObject({ status: 'published', publishedSha: job.squashSha });
    expect(gitIn(o.origin, 'rev-parse', 'main')).toBe(job.squashSha);
    expect(gitIn(o.repo, 'rev-parse', 'main')).toBe(job.squashSha);
  }, 60_000);

  it('a daemon that goes fatal while waiting for the publishing record leaves the integration branch and origin unchanged', async () => {
    const o = withOrigin();
    const check = gatedCheck(o.dir);
    const fatals: FatalInfo[] = [];
    sink = new StallSink(new SqliteSink(path.join(o.dir, 'sink.sqlite')));
    h = await makeSlice({
      graph: single('commitAndSubmit'),
      realVerifier: true,
      dir: o.dir,
      repo: o.repo,
      config: { ...pushOn(o.origin), checkCommand: check.command },
      journal: { sink, options: { flushDeadlineMs: 1500, onFatal: (i) => fatals.push(i) } },
    });
    const before = { clone: gitIn(o.repo, 'rev-parse', 'main'), origin: gitIn(o.origin, 'rev-parse', 'main') };
    // The agent has exited and its launch ended, so nothing but the verifier waits on the store once it stalls.
    await h.waitFor(() => existsSync(check.started) && h!.store.listLaunches({ taskId: 'T1', status: 'live' }).length === 0, 30_000);
    sink.stall();
    writeFileSync(check.go, '');
    await until(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'publishing');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    await until(() => fatals.length > 0, 10_000);
    expect(fatals[0]!.reason).toBe('deadline');
    // The verifier stops without its effects, and records nothing.
    await until(() => !h!.orch.verifierBusy(), 5_000);
    sink.release();
    await sleep(300);
    expect(gitIn(o.repo, 'rev-parse', 'main')).toBe(before.clone);
    expect(gitIn(o.origin, 'rev-parse', 'main')).toBe(before.origin);
    expect(launchCommits(o.origin, job.launchId)).toEqual([]);
    expect(launchCommits(o.repo, job.launchId)).toEqual([]);
    expect(h.store.getJob(job.jobId)?.status).toBe('publishing');
  }, 60_000);
});

/**
 * The real verifier. With `land` set it publishes and pushes as usual, then records the job back in `land` and never
 * returns: the push landed while the daemon died with an older durable record. With `hang` it records `checking` and
 * never returns, so nothing reaches origin. With neither it is the real verifier.
 */
class DyingVerifier extends GitVerifierBackend {
  land: 'checking' | 'verified' | 'publishing' | undefined;
  hang = false;
  override async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    if (this.hang) {
      ctx.progress({ status: 'checking', expectedHead: job.baseSha });
      return new Promise(() => undefined);
    }
    if (!this.land) return super.run(job, ctx);
    const status = this.land;
    const out = await super.run(job, ctx);
    if (out.kind !== 'published') throw new Error(`expected a publication, got ${out.kind}`);
    ctx.progress(status === 'publishing' ? { status } : { status, squashSha: undefined });
    return new Promise(() => undefined);
  }
}

function dyingVerifier(dir: string, repo: string): DyingVerifier {
  return new DyingVerifier({ repo, integrationBranch: 'main', tempRoot: path.join(dir, 'run', 'verify'), checkCommand: 'true', checkTimeoutMs: 60_000, baselineSha: gitIn(repo, 'rev-parse', 'main') });
}

describe('recovery looks on origin before declaring a commit lost', () => {
  it.each(['checking', 'verified', 'publishing'] as const)('a job stored as %s whose trailer is on origin is done at origin’s commit on a fresh clone, not commitLost, and not launched again', async (stored) => {
    const o = withOrigin();
    const verifier = dyingVerifier(o.dir, o.repo);
    verifier.land = stored;
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: o.dir, repo: o.repo, config: pushOn(o.origin) });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === stored && launchCommits(o.origin, h!.store.listJobs({ taskId: 'T1' })[0]!.launchId).length === 1, 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    const [landed] = launchCommits(o.origin, job.launchId);
    await h.store.durable();
    verifier.land = undefined;

    freshClone(h, o.origin);
    await h.restart();
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'published', publishedSha: landed, changedFiles: ['T1.txt'] });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 15_000);
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toEqual([]);
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
    expect(h.orch.entry('T1').attempts).toBe(0);
    const done = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).at(-1)!;
    expect(done.payload).toMatchObject({ to: 'done' });
    expect(JSON.stringify(done.payload)).toContain(landed!);
    expect(launchCommits(o.origin, job.launchId)).toEqual([landed]);
  }, 60_000);

  it('a job with no trailer on origin and no sealed commit is still commitLost, without spending an attempt', async () => {
    const o = withOrigin();
    const verifier = dyingVerifier(o.dir, o.repo);
    verifier.hang = true;
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: o.dir, repo: o.repo, config: pushOn(o.origin) });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'checking', 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    verifier.hang = false;

    freshClone(h, o.origin);
    await h.restart();
    expect(h.store.getJob(job.jobId)?.status).toBe('dropped');
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toMatchObject([{ payload: { sealedSha: job.sealedSha, jobId: job.jobId } }]);
    const entry = h.orch.entry('T1');
    expect(entry.attempts).toBe(0);
    expect(entry.status.kind).toBe('unstarted');
    expect(entry.carry?.priorFailure).toMatchObject({ kind: 'commitLost' });
  }, 60_000);

  it.each(['checking', 'publishing'] as const)('started on a fresh clone while origin cannot be fetched, a landed job stored as %s stays queued and is published once origin answers', async (stored) => {
    const o = withOrigin();
    const verifier = dyingVerifier(o.dir, o.repo);
    verifier.land = stored;
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: o.dir, repo: o.repo, config: pushOn(o.origin) });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === stored && launchCommits(o.origin, h!.store.listJobs({ taskId: 'T1' })[0]!.launchId).length === 1, 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    const [landed] = launchCommits(o.origin, job.launchId);
    verifier.land = undefined;

    freshClone(h, o.origin);
    const away = `${o.origin}.away`;
    renameSync(o.origin, away);
    await h.restart();
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'queued', applied: false });
    // Later ticks while origin is still down decide nothing.
    for (let i = 0; i < 5; i++) {
      await h.orch.tick();
      await sleep(250);
    }
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'queued', applied: false });
    expect(h.orch.entry('T1').status.kind).toBe('submitted');
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toEqual([]);

    renameSync(away, o.origin);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 15_000);
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'published', publishedSha: landed });
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toEqual([]);
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
  }, 60_000);

  it('started on a fresh clone while origin cannot be fetched, a job with no trailer stays queued and is commitLost once origin answers', async () => {
    const o = withOrigin();
    const verifier = dyingVerifier(o.dir, o.repo);
    verifier.hang = true;
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: o.dir, repo: o.repo, config: pushOn(o.origin) });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'checking', 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    verifier.hang = false;

    freshClone(h, o.origin);
    const away = `${o.origin}.away`;
    renameSync(o.origin, away);
    await h.restart();
    for (let i = 0; i < 3; i++) {
      await h.orch.tick();
      await sleep(250);
    }
    // Not handed to the verifier either: a rebase of the missing commit would spend an attempt as checkFailed.
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'queued', applied: false });
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toEqual([]);

    renameSync(away, o.origin);
    await h.waitFor(() => h!.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' }).length === 1, 15_000);
    expect(h.store.getJob(job.jobId)?.status).toBe('dropped');
    const failedOnce = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).filter((e) => e.payload?.['trigger'] === 'commitLost');
    expect(failedOnce).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T1' }).some((e) => e.payload?.['trigger'] === 'verificationFailed')).toBe(false);
  }, 60_000);
});
