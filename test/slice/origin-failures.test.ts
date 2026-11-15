/**
 * Origin failure paths: recovery while origin is unreachable, refused pushes, stalled remote commands, and milestone
 * tags held at another sha. See openspec/changes/origin-failure-paths.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCrashHook } from '../../src/crash.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierContext } from '../../src/verify/job.js';
import { pushRetryDue, readPushRetry, recordPushRetry } from '../../src/verify/push-retry.js';
import { GitVerifierBackend, TRAILER_TASK } from '../../src/verify/verifier.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { classifyFetchFailure, classifyPushFailure, Origin } from '../../src/workspace/origin.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  setCrashHook(undefined);
  delete process.env['ORCH_CRASH_AT'];
  await h?.cleanup();
  h = undefined;
});

function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-origin-fail-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const pushOn = (bare: string, extra: Record<string, unknown> = {}) => ({ git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0, ...extra } });
const taskCommits = (repo: string, taskId: string) => gitIn(repo, 'log', '--first-parent', '--format=%H', '-F', `--grep=${TRAILER_TASK}: ${taskId}`, 'main').split('\n').filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until timed out');
    await sleep(50);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A verifier whose run never returns once the named crash point throws: the job stays where the kill left it. */
function killableVerifier(f: { dir: string; repo: string }): { verifier: GitVerifierBackend; KILLED: Error } {
  const verifier = new GitVerifierBackend({ repo: f.repo, integrationBranch: 'main', tempRoot: path.join(f.dir, 'run', 'verify'), checkCommand: 'true', checkTimeoutMs: 60_000, baselineSha: gitIn(f.repo, 'rev-parse', 'main') });
  const KILLED = new Error('killed');
  const orig = verifier.run.bind(verifier);
  verifier.run = async (job: VerifierJob, ctx: VerifierContext) => {
    try {
      return await orig(job, ctx);
    } catch (err) {
      if (err === KILLED) return new Promise(() => undefined);
      throw err;
    }
  };
  return { verifier, KILLED };
}

describe('origin failure paths', () => {
  it('criterion 1: killed between the local swap and the push, restarted while origin is unreachable, the two-commit task is done exactly once after origin returns', async () => {
    const f = fixture();
    const { verifier, KILLED } = killableVerifier(f);
    h = await makeSlice({ graph: single('twoCommitsOneFile'), verifier, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    const before = gitIn(f.bare, 'rev-parse', 'main');
    let killed = false;
    process.env['ORCH_CRASH_AT'] = 'verify.afterPublish';
    setCrashHook(() => {
      delete process.env['ORCH_CRASH_AT'];
      killed = true;
      throw KILLED;
    });
    await h.waitFor(() => killed && h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'publishing', 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(job.squashSha);
    expect(gitIn(f.repo, 'rev-list', '--count', `${job.baseSha}..${job.sealedSha}`)).toBe('2');

    // Restart on the same clone with origin unreachable.
    const away = `${f.bare}.away`;
    renameSync(f.bare, away);
    await h.restart();
    // The unconfirmed swap is undone, so no later job pushes the squash as a catch-up.
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(before);
    expect(h.store.getJob(job.jobId)?.status).toBe('queued');
    for (let i = 0; i < 5; i++) {
      await h.orch.tick();
      await sleep(250);
    }
    expect(h.orch.entry('T1').status.kind).toBe('submitted');

    // Origin returns.
    renameSync(away, f.bare);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const entry = h.orch.entry('T1');
    expect(entry.launches).toBe(1);
    expect(entry.integrationRetries).toBe(0);
    expect(entry.attempts).toBe(0);
    expect(h.store.listEvents({ kinds: ['transition'], taskId: 'T1' }).filter((e) => e.payload?.['to'] === 'done').length).toBe(1);
    expect(h.store.listJobs({ taskId: 'T1' }).map((j) => j.status)).toEqual(['published']);
    const onOrigin = taskCommits(f.bare, 'T1');
    expect(onOrigin.length).toBe(1);
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(before);
    expect(gitIn(f.bare, 'show', 'main:T1.txt')).toBe('T1 first\nT1 second');
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(gitIn(f.bare, 'rev-parse', 'main'));
    expect(h.orch.status().foreignCommits).toEqual([]);
  }, 90_000);

  it('criterion 2: a push origin refuses is retried with growing backoff, and at git.pushRefusalLimit the task is blocked with the refusal text, no attempt spent', async () => {
    const f = fixture();
    const hook = path.join(f.bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = gitIn(f.bare, 'rev-parse', 'main');
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare, { pushRefusalLimit: 3, pushRetryBackoffMs: 300 }) });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked', 30_000);
    const status = h.orch.entry('T1').status;
    expect(status).toMatchObject({ kind: 'blocked', reason: { kind: 'pushRefused' } });
    const message = (status as { reason: { message: string } }).reason.message;
    expect(message).toContain('GH006: Protected branch update failed');
    expect(message).toContain('refused');
    expect(h.orch.entry('T1').attempts).toBe(0);
    expect(h.orch.entry('T1').launches).toBe(1);
    // Two refusals requeued with backoff; the third blocked.
    const requeued = h.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' });
    expect(requeued.map((e) => [e.payload?.['retry'], e.payload?.['refusals']])).toEqual([
      ['refused', 1],
      ['refused', 2],
    ]);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job).toMatchObject({ status: 'failed', failureKind: 'pushRefused', applied: true });
    // The waits grew (300ms, then 600ms), and each retry started no earlier than its backoff allowed.
    expect(requeued.map((e) => e.payload?.['retryInMs'])).toEqual([300, 600]);
    const r0 = Number(requeued[0]!.payload?.['retryAt']);
    expect(requeued[1]!.ts).toBeGreaterThanOrEqual(r0);
    // The job is applied: its push retry state is gone with it.
    expect(readPushRetry(h.store, job.jobId)).toBeUndefined();
    expect(h.store.getKv(`pushRetry:${job.jobId}`) ?? '').toBe('');
    // Nothing was published, and the clone's swap was undone every time.
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(before);
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(before);
    const transition = h.store.listEvents({ kinds: ['transition'], taskId: 'T1' }).at(-1)!;
    expect(transition.payload).toMatchObject({ from: 'submitted', to: 'blocked', actor: 'verifier', trigger: 'pushRefused' });
    expect(h.orch.status().byStatus.blocked).toEqual(['T1']);
    // A person fixes origin and unblocks: the task runs again and publishes.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    expect(h.orch.unblock('T1')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(taskCommits(f.bare, 'T1').length).toBe(1);
  }, 60_000);

  it('a push refusal limit counts refusals only: an unreachable origin backs off and never blocks', () => {
    const kv = new Map<string, string>();
    const store = { getKv: (k: string) => kv.get(k), setKv: (k: string, v: string) => void kv.set(k, v) };
    const settings = { pushRefusalLimit: 2, pushRetryBackoffMs: 100 };
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = recordPushRetry(store, 'j', { kind: 'unreachable', message: 'no answer' }, settings, 1000);
      expect(r.blocked).toBe(false);
      delays.push(r.delayMs);
    }
    // Doubling, capped at 32 times the base.
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 3200, 3200]);
    expect(pushRetryDue(store, 'j', 1000 + 3199)).toBe(false);
    expect(pushRetryDue(store, 'j', 1000 + 3200)).toBe(true);
    expect(recordPushRetry(store, 'j', { kind: 'refused', message: 'no' }, settings, 0).blocked).toBe(false);
    expect(recordPushRetry(store, 'j', { kind: 'refused', message: 'no' }, settings, 0).blocked).toBe(true);
    expect(pushRetryDue(store, 'other', 0)).toBe(true);
  });

  it('push failures are classified from git output: a lost lease, a refusal, an unreachable origin', () => {
    expect(classifyPushFailure("To /o.git\n ! [rejected]        abc -> main (stale info)\nerror: failed to push some refs to '/o.git'\n")).toBe('lease');
    expect(classifyPushFailure('remote: branch is protected\nTo /o.git\n ! [remote rejected] abc -> main (pre-receive hook declined)\n')).toBe('refused');
    expect(classifyPushFailure("remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://x/o/r.git/': The requested URL returned error: 403\n")).toBe('refused');
    expect(classifyPushFailure("fatal: Authentication failed for 'https://x/o/r.git/'\n")).toBe('refused');
    expect(classifyPushFailure("fatal: '/o.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n")).toBe('unreachable');
    expect(classifyPushFailure('ssh: connect to host x port 22: Connection refused\n')).toBe('unreachable');
    expect(classifyPushFailure('anything', true)).toBe('unreachable');
  });

  it('criterion 3: a push that does not answer within git.remoteTimeoutMs is killed with its helpers, the tick keeps running meanwhile, and the task publishes once origin answers', async () => {
    const f = fixture();
    const pidFile = path.join(f.dir, 'receive-pack.pid');
    // Every push stalls: the receive-pack command records its shell's pid and sleeps (git appends the repository path, hence the trailing `:`).
    gitIn(f.repo, 'config', 'remote.origin.receivepack', `echo $$ > ${pidFile}; sleep 30; :`);
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare, { remoteTimeoutMs: 4000, pushRetryBackoffMs: 100 }) });
    await h.waitFor(() => existsSync(pidFile), 30_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    expect(h.orch.origin?.busy).toBe(true);
    // The push is stalled: ticks (base selection, milestone phase) do not wait behind it.
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await h.orch.tick();
      expect(Date.now() - t0).toBeLessThan(1500);
      // Still stalled: the tick did not wait for the push to end.
      expect(alive(pid)).toBe(true);
    }
    // After the timeout the push and the process origin started for it are gone; the job backs off.
    const deadline = Date.now() + 10_000;
    while (h.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' }).length === 0 && Date.now() < deadline) {
      await h.orch.tick();
      await sleep(100);
    }
    const [requeued] = h.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' });
    expect(String(requeued?.payload?.['reason'])).toContain('timed out after 4000ms');
    expect(requeued?.payload?.['retry']).toBe('unreachable');
    await sleep(200);
    expect(alive(pid)).toBe(false);
    // Origin answers again.
    gitIn(f.repo, 'config', '--unset', 'remote.origin.receivepack');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(taskCommits(f.bare, 'T1').length).toBe(1);
    expect(h.orch.entry('T1').attempts).toBe(0);
  }, 90_000);

  it('criterion 3: a stalled fetch is killed after git.remoteTimeoutMs and reported as a failure', async () => {
    const f = fixture();
    gitIn(f.repo, 'remote', 'add', 'origin', f.bare);
    gitIn(f.repo, 'config', 'remote.origin.uploadpack', 'sleep 30; :');
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', remoteTimeoutMs: 800 });
    const t0 = Date.now();
    await expect(origin.fetch()).rejects.toThrow(/timed out after 800ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(origin.busy).toBe(false);
    // The push of a tag times out too and is a failure, never a conflict.
    gitIn(f.repo, 'config', 'remote.origin.receivepack', 'sleep 30; :');
    gitIn(f.repo, 'tag', 'x', 'main');
    await expect(origin.pushTag('x', gitIn(f.repo, 'rev-parse', 'main'))).rejects.toThrow(/timed out/);
  }, 30_000);

  const MILESTONE = `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1] }\n`;

  it('criterion 4: a tag the clone holds at another sha (as git clone brings it from origin) is a conflict recorded once, never thrown from the tick or from recovery', async () => {
    const f = fixture();
    const initial = gitIn(f.bare, 'rev-parse', 'main');
    gitIn(f.bare, 'tag', 'milestone/MVP/v1', initial);
    gitIn(f.repo, 'tag', 'milestone/MVP/v1', initial);
    h = await makeSlice({ graph: MILESTONE, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    // Killed after the milestone is submitted and tagged, before the tag is recorded: recovery tags it again.
    process.env['ORCH_CRASH_AT'] = 'milestone.afterTag';
    let killed = false;
    setCrashHook(() => {
      delete process.env['ORCH_CRASH_AT'];
      killed = true;
      throw new Error('killed at milestone.afterTag');
    });
    const deadline = Date.now() + 30_000;
    while (!killed && Date.now() < deadline) {
      await h.orch.tick().catch(() => undefined);
      await sleep(60);
    }
    expect(killed).toBe(true);
    expect(h.orch.entry('MVP').status.kind).toBe('submitted');
    expect(h.store.getKv('tagged:MVP:1')).toBeUndefined();
    await h.restart();
    for (let i = 0; i < 3; i++) await h.orch.tick();
    await h.restart();
    for (let i = 0; i < 3; i++) await h.orch.tick();
    const mvp = h.orch.entry('MVP');
    expect(mvp.integrationSha).not.toBe(initial);
    expect(h.store.getKv('tagPushed:MVP:1')).toBe(`conflict:${initial}`);
    const conflicts = h.store.listEvents({ kinds: ['milestone.tagConflict'], taskId: 'MVP' });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.payload).toMatchObject({ remoteSha: initial, sha: mvp.integrationSha, where: 'clone' });
    // Never moved, in the clone or on origin.
    expect(gitIn(f.repo, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(initial);
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(initial);
    // The run goes on: the milestone can still be reviewed.
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, mvp.reviewVersion)).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.orch.entry('MVP').status.kind).toBe('done');
    expect(h.store.listEvents({ kinds: ['milestone.tagConflict'], taskId: 'MVP' }).length).toBe(1);
  }, 90_000);

  it('criterion 4: with pushing off, a tag the clone holds at another sha is a conflict recorded once across ticks and restarts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-origin-fail-'));
    const repo = makeRepo(dir);
    const initial = gitIn(repo, 'rev-parse', 'main');
    gitIn(repo, 'tag', 'milestone/MVP/v1', initial);
    h = await makeSlice({ graph: MILESTONE, realVerifier: true, dir, repo });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    await h.orch.tick();
    await h.restart();
    await h.orch.tick();
    const conflicts = h.store.listEvents({ kinds: ['milestone.tagConflict'], taskId: 'MVP' });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.payload).toMatchObject({ remoteSha: initial, where: 'clone' });
    expect(gitIn(repo, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(initial);
  }, 60_000);

  it('a catch-up push never publishes a commit made in the clone without a launch trailer; it stays foreign', async () => {
    const f = fixture();
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit }\n  - { id: T2, deps: [T1], behavior: commitAndSubmit }\n`, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare, { pushRefusalLimit: 2, pushRetryBackoffMs: 100 }) });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const originBefore = gitIn(f.bare, 'rev-parse', 'main');
    // A commit made by hand in the daemon's clone, after the baseline.
    writeFileSync(path.join(f.repo, 'hand.txt'), 'by hand\n');
    gitIn(f.repo, 'add', 'hand.txt');
    gitIn(f.repo, 'commit', '-q', '-m', 'made in the clone');
    const hand = gitIn(f.repo, 'rev-parse', 'HEAD');
    await h.waitFor(() => ['blocked', 'done'].includes(h!.orch.entry('T2').status.kind), 30_000);
    expect(h.orch.entry('T2').status).toMatchObject({ kind: 'blocked', reason: { kind: 'pushRefused' } });
    expect((h.orch.entry('T2').status as { reason: { message: string } }).reason.message).toContain(hand);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(originBefore);
    await h.orch.tick();
    expect(h.orch.status().foreignCommits).toEqual([hand]);
  }, 60_000);

  it('criterion 3: with no other command in flight, base selection and the tag push wait at most tickWaitMs for their own stalled command', async () => {
    const f = fixture();
    gitIn(f.repo, 'remote', 'add', 'origin', f.bare);
    gitIn(f.repo, 'config', 'remote.origin.uploadpack', 'sleep 30; :');
    gitIn(f.repo, 'config', 'remote.origin.receivepack', 'sleep 30; :');
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', remoteTimeoutMs: 3000, tickWaitMs: 300 });
    const ws = new GitWorkspace(f.repo, 'main', path.join(f.dir, 'wt'));
    ws.useOrigin(origin);
    const local = gitIn(f.repo, 'rev-parse', 'main');
    let t0 = Date.now();
    // No fetch ever landed: the clone's head is used, and the fetch runs on.
    expect(await ws.integrationHead()).toBe(local);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(origin.busy).toBe(true);
    // While it runs, the tag push is left for a later tick at once.
    t0 = Date.now();
    expect(await ws.tagMilestone('MVP', 1, local)).toMatchObject({ pushed: false, error: expect.stringContaining('busy') });
    expect(Date.now() - t0).toBeLessThan(500);
    await until(() => !origin.busy, 10_000);
    // The tag push of its own stalls: the call returns after tickWaitMs, and the push runs on.
    t0 = Date.now();
    expect(await ws.tagMilestone('MVP', 1, local)).toMatchObject({ pushed: false, error: expect.stringContaining('still running') });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(origin.busy).toBe(true);
    await until(() => !origin.busy, 10_000);
    // Origin answers again: the tag lands.
    gitIn(f.repo, 'config', '--unset', 'remote.origin.uploadpack');
    gitIn(f.repo, 'config', '--unset', 'remote.origin.receivepack');
    expect(await ws.tagMilestone('MVP', 1, local)).toEqual({ pushed: true });
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(local);
    // Startup recovery awaits its fetch in full.
    expect(await ws.integrationHead({ awaitFetch: true })).toBe(local);
  }, 60_000);

  it('a push that had landed before the kill is found by its trailer once origin answers, and nothing is pushed again', async () => {
    const f = fixture();
    const { verifier, KILLED } = killableVerifier(f);
    h = await makeSlice({ graph: single('twoCommitsOneFile'), verifier, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    const before = gitIn(f.bare, 'rev-parse', 'main');
    let killed = false;
    process.env['ORCH_CRASH_AT'] = 'verify.afterPublish';
    setCrashHook(() => {
      delete process.env['ORCH_CRASH_AT'];
      killed = true;
      throw KILLED;
    });
    await h.waitFor(() => killed && h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'publishing', 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    // The push reached origin; only its answer was lost.
    gitIn(f.repo, 'push', '-q', f.bare, `${job.squashSha}:refs/heads/main`);
    const away = `${f.bare}.away`;
    renameSync(f.bare, away);
    await h.restart();
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(before);
    renameSync(away, f.bare);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'published', publishedSha: job.squashSha });
    expect(taskCommits(f.bare, 'T1')).toEqual([job.squashSha]);
    expect(h.orch.entry('T1').launches).toBe(1);
    // The clone may lag origin until the next job fast-forwards it; base selection already reads the publication.
    expect(await h.workspace.integrationHead()).toBe(job.squashSha);
    expect(h.orch.status().foreignCommits).toEqual([]);
  }, 60_000);

  it('ORC-97 criterion 1: a fetch origin refuses for its credentials counts against git.pushRefusalLimit and blocks the task naming the refusal', async () => {
    const f = fixture();
    // Every fetch is refused as an expired credential would be.
    gitIn(f.repo, 'config', 'remote.origin.uploadpack', `echo "fatal: Authentication failed for 'https://example.invalid/o.git/'" >&2; exit 1; :`);
    const before = gitIn(f.bare, 'rev-parse', 'main');
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare, { pushRefusalLimit: 3, pushRetryBackoffMs: 100 }) });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked', 30_000);
    const status = h.orch.entry('T1').status;
    expect(status).toMatchObject({ kind: 'blocked', reason: { kind: 'pushRefused' } });
    const message = (status as { reason: { message: string } }).reason.message;
    expect(message).toContain('fetch from origin was refused');
    expect(message).toContain('Authentication failed');
    const requeued = h.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' });
    expect(requeued.map((e) => [e.payload?.['retry'], e.payload?.['refusals']])).toEqual([
      ['refused', 1],
      ['refused', 2],
    ]);
    expect(h.orch.entry('T1').attempts).toBe(0);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(before);
    // The credential is renewed and the task unblocked: it publishes.
    gitIn(f.repo, 'config', '--unset', 'remote.origin.uploadpack');
    expect(h.orch.unblock('T1')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(taskCommits(f.bare, 'T1').length).toBe(1);
  }, 60_000);

  it('ORC-97 criterion 1: a fetch that cannot reach origin is retried past git.pushRefusalLimit and never blocks; the retry state goes when the job is applied', async () => {
    const f = fixture();
    const away = `${f.bare}.away`;
    renameSync(f.bare, away);
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare, { pushRefusalLimit: 2, pushRetryBackoffMs: 50 }) });
    await h.waitFor(() => h!.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' }).length >= 4, 30_000);
    const requeued = h.store.listEvents({ kinds: ['verify.requeued'], taskId: 'T1' });
    expect(requeued.every((e) => e.payload?.['retry'] === 'unreachable' && e.payload?.['refusals'] === 0)).toBe(true);
    expect(String(requeued[0]!.payload?.['reason'])).toContain('could not reach');
    expect(h.orch.entry('T1').status.kind).toBe('submitted');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(readPushRetry(h.store, job.jobId)?.failures).toBeGreaterThanOrEqual(4);
    // Origin returns: the task publishes, and the job's retry state is removed once it is applied.
    renameSync(away, f.bare);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'published', applied: true });
    expect(readPushRetry(h.store, job.jobId)).toBeUndefined();
    expect(h.store.getKv(`pushRetry:${job.jobId}`) ?? '').toBe('');
    expect(taskCommits(f.bare, 'T1').length).toBe(1);
  }, 60_000);

  it('ORC-97: fetch failures are classified from git output: a refused credential or access, an unreachable origin', () => {
    expect(classifyFetchFailure("fatal: Authentication failed for 'https://x/o/r.git/'\n")).toBe('refused');
    expect(classifyFetchFailure("remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://x/o/r.git/': The requested URL returned error: 403\n")).toBe('refused');
    expect(classifyFetchFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n")).toBe('refused');
    expect(classifyFetchFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n')).toBe('refused');
    expect(classifyFetchFailure('ssh: connect to host x port 22: Connection refused\nfatal: Could not read from remote repository.\n')).toBe('unreachable');
    expect(classifyFetchFailure("fatal: unable to access 'https://x/': Could not resolve host: x\n")).toBe('unreachable');
    expect(classifyFetchFailure('Authentication failed', true)).toBe('unreachable');
  });

  it('ORC-97 criterion 2: a tag push slower than the tick wait is recorded as pushed once it completes, without pushing it again', async () => {
    const f = fixture();
    const count = path.join(f.dir, 'pushes');
    // Every push takes 2s at the transport, longer than the tick's 1s wait, even one origin needs nothing from.
    gitIn(f.repo, 'config', 'remote.origin.receivepack', `echo x >> ${count}; sleep 2; git receive-pack`);
    h = await makeSlice({ graph: MILESTONE, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    await h.waitFor(() => h!.store.getKv('tagPushed:MVP:1') !== undefined, 30_000);
    const mvp = h.orch.entry('MVP');
    expect(h.store.getKv('tagPushed:MVP:1')).toBe(mvp.integrationSha);
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    // Two pushes in all: T1's publication and the one tag push, which never finished inside a tick's wait.
    expect(readFileSync(count, 'utf8').trim().split('\n').length).toBe(2);
    for (let i = 0; i < 3; i++) await h.orch.tick();
    expect(readFileSync(count, 'utf8').trim().split('\n').length).toBe(2);
  }, 60_000);

  it('ORC-97 criterion 2: a tick-started tag push that settles after the wait answers the next call from its outcome', async () => {
    const f = fixture();
    const count = path.join(f.dir, 'pushes');
    gitIn(f.repo, 'remote', 'add', 'origin', f.bare);
    // Every push takes 1s at the transport, even one origin needs nothing from.
    gitIn(f.repo, 'config', 'remote.origin.receivepack', `echo x >> ${count}; sleep 1; git receive-pack`);
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', tickWaitMs: 100 });
    const sha = gitIn(f.repo, 'rev-parse', 'main');
    gitIn(f.repo, 'tag', 'slow', sha);
    expect(await origin.pushTagFromTick('slow', sha)).toBeUndefined();
    // Still running: a second call waits on the same push and starts none.
    expect(await origin.pushTagFromTick('slow', sha)).toBeUndefined();
    await until(() => !origin.busy, 10_000);
    expect(await origin.pushTagFromTick('slow', sha)).toBe('pushed');
    expect(readFileSync(count, 'utf8').trim().split('\n')).toEqual(['x']);
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/slow^{commit}')).toBe(sha);
  }, 30_000);

  it('ORC-97 criterion 3: with pushing off, a milestone tag that could not be created in the clone is created on a later tick', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-origin-fail-'));
    const repo = makeRepo(dir);
    // A stale lock makes `git tag` fail until it is removed.
    const lock = path.join(repo, '.git', 'refs', 'tags', 'milestone', 'MVP', 'v1.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    h = await makeSlice({ graph: MILESTONE, realVerifier: true, dir, repo });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    for (let i = 0; i < 2; i++) await h.orch.tick();
    const hasTag = () => gitIn(repo, 'tag', '--list', 'milestone/MVP/v1') !== '';
    expect(hasTag()).toBe(false);
    expect(h.store.getKv('tagLocal:MVP:1')).toBeUndefined();
    rmSync(lock);
    await h.orch.tick();
    const sha = h.orch.entry('MVP').integrationSha;
    expect(hasTag()).toBe(true);
    expect(gitIn(repo, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(sha);
    expect(h.store.getKv('tagLocal:MVP:1')).toBe(sha);
    expect(h.store.getKv('tagPushed:MVP:1')).toBeUndefined();
  }, 60_000);

  it("a job whose own squash is the clone's tip publishes it through the catch-up push, without a rebase", async () => {
    const f = fixture();
    const before = gitIn(f.repo, 'rev-parse', 'main');
    // The launch's sealed branch: two commits that edit one file.
    gitIn(f.repo, 'checkout', '-q', '-b', 'task/T1/l1');
    writeFileSync(path.join(f.repo, 'T1.txt'), 'first\n');
    gitIn(f.repo, 'add', 'T1.txt');
    gitIn(f.repo, 'commit', '-q', '-m', 'one');
    writeFileSync(path.join(f.repo, 'T1.txt'), 'first\nsecond\n');
    gitIn(f.repo, 'commit', '-q', '-am', 'two');
    const sealed = gitIn(f.repo, 'rev-parse', 'HEAD');
    gitIn(f.repo, 'checkout', '-q', 'main');
    // Its squash, left at the clone's tip and never pushed.
    const tree = gitIn(f.repo, 'rev-parse', `${sealed}^{tree}`);
    const squash = gitIn(f.repo, '-c', 'user.name=o', '-c', 'user.email=o@x', 'commit-tree', tree, '-p', before, '-m', 'T1\n\nOrchestrator-Task: T1\nOrchestrator-Launch: L1');
    gitIn(f.repo, 'update-ref', 'refs/heads/main', squash, before);
    gitIn(f.repo, 'reset', '-q', '--hard');
    const verifier = new GitVerifierBackend({ repo: f.repo, integrationBranch: 'main', tempRoot: path.join(f.dir, 'verify'), checkCommand: 'true', checkTimeoutMs: 60_000, baselineSha: before });
    verifier.useOrigin(new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare }));
    const job: VerifierJob = { jobId: 'j1', taskId: 'T1', launchId: 'L1', sealedSha: sealed, baseSha: before, status: 'queued', applied: false, createdAt: 0, updatedAt: 0 };
    const progress: Array<Partial<VerifierJob>> = [];
    const outcome = await verifier.run(job, { progress: (p) => void progress.push(p), summary: 'T1', publishedSince: async () => [], noChanges: false });
    expect(outcome).toEqual({ kind: 'published', publishedSha: squash, verifiedSha: squash });
    expect(progress).toEqual([]);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(squash);
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(squash);
  }, 30_000);
});
