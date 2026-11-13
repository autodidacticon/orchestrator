/**
 * Origin as the source of truth for integration, against a bare origin fixture.
 * See specs/integration-pipeline "Origin as source of truth".
 */
import { existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCrashHook } from '../../src/crash.js';
import { defaultConfig } from '../../src/config.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierContext } from '../../src/verify/job.js';
import { GitVerifierBackend, TRAILER_LAUNCH } from '../../src/verify/verifier.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  setCrashHook(undefined);
  delete process.env['ORCH_CRASH_AT'];
  await h?.cleanup();
  h = undefined;
});

/** A temp dir with the daemon's clone and a bare origin cloned from it; the clone's `origin` is not configured yet. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-origin-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

/** Push a commit to origin from a separate clone, as a person would. */
function humanPush(dir: string, bare: string, file: string): string {
  const other = path.join(dir, `human-${file}`);
  gitIn(dir, 'clone', '-q', bare, other);
  writeFileSync(path.join(other, file), 'by a person\n');
  gitIn(other, 'add', file);
  gitIn(other, 'commit', '-q', '-m', `human ${file}`);
  gitIn(other, 'push', '-q', 'origin', 'HEAD:main');
  return gitIn(other, 'rev-parse', 'HEAD');
}

const firstParent = (repo: string, ref = 'main') => gitIn(repo, 'rev-list', '--first-parent', ref).split('\n');
const launchCommits = (repo: string, launchId: string) => gitIn(repo, 'log', '--first-parent', '--format=%H', '-F', `--grep=${TRAILER_LAUNCH}: ${launchId}`, 'main').split('\n').filter(Boolean);
const pushOn = (bare: string) => ({ git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 } });

const GRAPH = `nodes:
  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }
  - { id: T2, deps: [T1], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }
  - { id: T3, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }
  - { id: MVP, kind: milestone, gated: true, deps: [T2, T3] }
`;

describe('slice: origin as the source of truth', () => {
  it('every published trailer commit is on origin, a fresh clone has the same first-parent history, and the accepted milestone tag is on origin', async () => {
    const f = fixture();
    h = await makeSlice({ graph: GRAPH, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    const jobs = h.store.listJobs({ status: 'published' });
    expect(jobs.map((j) => j.taskId).sort()).toEqual(['T1', 'T2', 'T3']);
    const originHistory = firstParent(f.bare);
    for (const j of jobs) {
      expect(originHistory).toContain(j.publishedSha);
      expect(launchCommits(f.bare, j.launchId)).toEqual([j.publishedSha]);
    }
    const fresh = path.join(f.dir, 'fresh');
    gitIn(f.dir, 'clone', '-q', f.bare, fresh);
    expect(firstParent(fresh)).toEqual(firstParent(h.repo));
    expect(gitIn(h.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(gitIn(h.repo, 'rev-parse', 'main'));
    // Each launch started from origin's head, which held its dependency's publication.
    const t1 = jobs.find((j) => j.taskId === 'T1')!;
    const t2Launch = h.store.listLaunches({ taskId: 'T2' })[0]!;
    expect(gitIn(h.repo, 'merge-base', '--is-ancestor', t1.publishedSha!, t2Launch.baseSha)).toBe('');

    const mvp = h.orch.entry('MVP');
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, mvp.reviewVersion)).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.orch.entry('MVP').status.kind).toBe('done');
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    expect(h.store.getKv('tagPushed:MVP:1')).toBe(mvp.integrationSha);
    expect(h.orch.status().foreignCommits).toEqual([]);
  }, 60_000);

  it('a commit pushed to origin between verification and publication fails the lease, requeues, and publishes on top', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    let human: string | undefined;
    process.env['ORCH_CRASH_AT'] = 'verify.afterSquash';
    setCrashHook(() => {
      // Verified and squashed, not yet published: someone else pushes to origin now.
      delete process.env['ORCH_CRASH_AT'];
      human = humanPush(f.dir, f.bare, 'human.txt');
    });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(human).toBeDefined();
    expect(h.store.listEvents({ kinds: ['verify.requeued'] }).length).toBe(1);
    const job = h.store.listJobs({ taskId: 'T1', status: 'published' })[0]!;
    // Both commits survive: the human commit is the publication's parent, on origin and in the clone.
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(job.publishedSha);
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(human);
    expect(firstParent(h.repo)).toEqual(firstParent(f.bare));
    expect(gitIn(h.repo, 'show', `${job.publishedSha}:human.txt`)).toBe('by a person');
    expect(gitIn(h.repo, 'show', `${job.publishedSha}:T1.txt`)).toBeTruthy();
    expect(launchCommits(f.bare, job.launchId)).toEqual([job.publishedSha]);
    // The primary worktree followed the ref.
    expect(gitIn(h.repo, 'status', '--porcelain')).toBe('');
    expect(h.orch.status().foreignCommits).toEqual([]);
  }, 60_000);

  it('a human commit that arrives on origin is not foreign; a commit made in the clone that origin lacks is', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const human = humanPush(f.dir, f.bare, 'human.txt');
    await h.orch.tick();
    await h.orch.tick();
    expect(await h.workspace.integrationHead()).toBe(human);
    expect(h.orch.status().foreignCommits).toEqual([]);
    // Control: the sweep still flags a trailer-less commit that exists only in the daemon's clone.
    writeFileSync(path.join(h.repo, 'local.txt'), 'local\n');
    gitIn(h.repo, 'add', 'local.txt');
    gitIn(h.repo, 'commit', '-q', '-m', 'local only');
    const local = gitIn(h.repo, 'rev-parse', 'HEAD');
    await h.orch.tick();
    expect(h.orch.status().foreignCommits).toEqual([local]);
  }, 60_000);

  it('a daemon killed between the local compare-and-swap and the push finishes the push at recovery, exactly once', async () => {
    const f = fixture();
    const cfg = defaultConfig({ integrationBranch: 'main' });
    const verifier = new GitVerifierBackend({ repo: f.repo, integrationBranch: 'main', tempRoot: path.join(f.dir, 'run', 'verify'), checkCommand: 'true', checkTimeoutMs: cfg.checkTimeoutMs, baselineSha: gitIn(f.repo, 'rev-parse', 'main') });
    const KILLED = new Error('killed at verify.afterPublish');
    const orig = verifier.run.bind(verifier);
    // A kill: the run never returns, so the job stays `publishing` with its squash recorded.
    verifier.run = async (job: VerifierJob, ctx: VerifierContext) => {
      try {
        return await orig(job, ctx);
      } catch (err) {
        if (err === KILLED) return new Promise(() => undefined);
        throw err;
      }
    };
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
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
    // Swapped locally, not on origin.
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(job.squashSha);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(before);

    await h.restart();
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'published', publishedSha: job.squashSha });
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(job.squashSha);
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(before);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 15_000);
    // A second recovery finds the trailer on origin and pushes nothing more.
    expect(await verifier.recoverPublishing({ ...job, status: 'publishing' })).toBe('published');
    expect(launchCommits(f.bare, job.launchId)).toEqual([job.squashSha]);
    expect(firstParent(f.bare)).toEqual(firstParent(f.repo));
    expect(gitIn(f.repo, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('a push lost to a moved origin at recovery undoes the local swap and republishes on the new head', async () => {
    const f = fixture();
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
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    let killed = false;
    process.env['ORCH_CRASH_AT'] = 'verify.afterPublish';
    setCrashHook(() => {
      delete process.env['ORCH_CRASH_AT'];
      killed = true;
      throw KILLED;
    });
    await h.waitFor(() => killed && h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'publishing', 30_000);
    const human = humanPush(f.dir, f.bare, 'human.txt');
    await h.restart();
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const job = h.store.listJobs({ taskId: 'T1', status: 'published' })[0]!;
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(human);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(job.publishedSha);
    expect(launchCommits(f.bare, job.launchId)).toEqual([job.publishedSha]);
    expect(firstParent(f.repo)).toEqual(firstParent(f.bare));
  }, 60_000);

  it('publications made before pushing was on are pushed first', async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, 'earlier.txt'), 'earlier\n');
    gitIn(f.repo, 'add', 'earlier.txt');
    gitIn(f.repo, 'commit', '-q', '-m', 'earlier publication');
    const earlier = gitIn(f.repo, 'rev-parse', 'HEAD');
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    // Base selection uses the clone's head while origin lags it.
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(h.store.listLaunches({ taskId: 'T1' })[0]!.baseSha).toBe(earlier);
    expect(gitIn(f.bare, 'rev-parse', 'main^')).toBe(earlier);
    expect(firstParent(f.bare)).toEqual(firstParent(f.repo));
  }, 60_000);

  it('a milestone tag push that fails is retried until the tag is on origin', async () => {
    const f = fixture();
    const graph = `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1] }\n`;
    h = await makeSlice({ graph, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    const away = `${f.bare}.away`;
    let hidden = false;
    process.env['ORCH_CRASH_AT'] = 'tick.afterPhase2';
    setCrashHook(() => {
      // Origin becomes unreachable once T1 is published, before the milestone is tagged.
      if (hidden || !h!.store.listJobs({ taskId: 'T1', status: 'published' }).length) return;
      hidden = true;
      renameSync(f.bare, away);
    });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    await h.orch.tick();
    const mvp = h.orch.entry('MVP');
    expect(hidden).toBe(true);
    expect(h.store.getKv('tagPushed:MVP:1')).toBeUndefined();
    expect(gitIn(f.repo, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, mvp.reviewVersion)).toEqual({ ok: true });
    await h.orch.tick();
    // A restart while origin is unreachable recovers without error.
    await h.restart();
    await h.orch.tick();
    expect(h.store.getKv('tagPushed:MVP:1')).toBeUndefined();
    // Origin comes back: the accepted milestone's tag lands at the reviewed sha.
    renameSync(away, f.bare);
    await h.orch.tick();
    expect(h.orch.entry('MVP').status.kind).toBe('done');
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    expect(h.store.getKv('tagPushed:MVP:1')).toBe(mvp.integrationSha);
    expect(h.store.listEvents({ kind: 'milestone.tagged', taskId: 'MVP' }).length).toBe(1);
  }, 60_000);

  it('a tag origin already holds at another sha is never moved and is reported once', async () => {
    const f = fixture();
    const initial = gitIn(f.bare, 'rev-parse', 'main');
    gitIn(f.bare, 'tag', 'milestone/MVP/v1', initial);
    const graph = `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1] }\n`;
    h = await makeSlice({ graph, realVerifier: true, dir: f.dir, repo: f.repo, config: pushOn(f.bare) });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    await h.orch.tick();
    await h.orch.tick();
    expect(h.orch.entry('MVP').integrationSha).not.toBe(initial);
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(initial);
    expect(h.store.getKv('tagPushed:MVP:1')).toBe(`conflict:${initial}`);
    await h.restart();
    await h.orch.tick();
    expect(gitIn(f.bare, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(initial);
    expect(h.store.listEvents({ kind: 'milestone.tagConflict', taskId: 'MVP' }).length).toBe(1);
  }, 60_000);

  it('a clone diverged from origin fails the job loudly and is not moved', async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, 'mine.txt'), 'mine\n');
    gitIn(f.repo, 'add', 'mine.txt');
    gitIn(f.repo, 'commit', '-q', '-m', 'clone only');
    const local = gitIn(f.repo, 'rev-parse', 'HEAD');
    const human = humanPush(f.dir, f.bare, 'human.txt');
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: { ...pushOn(f.bare), maxAttempts: 1 } });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'failed', 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.output).toContain('diverged');
    expect(job.output).toContain(local);
    expect(job.output).toContain(human);
    expect(gitIn(f.repo, 'rev-parse', 'main')).toBe(local);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(human);
  }, 60_000);

  it('pushing on without an origin remote or URL fails the job naming the setting', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, dir: f.dir, repo: f.repo, config: { git: { pushIntegration: true }, maxAttempts: 1 } });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'failed', 30_000);
    expect(h.store.listJobs({ taskId: 'T1' })[0]!.output).toContain('git.originUrl');
  }, 60_000);

  it('with pushIntegration off (the default) no git command contacts a remote', async () => {
    const f = fixture();
    const marker = path.join(f.dir, 'remote-contacted');
    // An origin whose transport leaves a marker when anything talks to it.
    gitIn(f.repo, 'config', 'protocol.ext.allow', 'always');
    gitIn(f.repo, 'remote', 'add', 'origin', `ext::sh -c touch% ${marker}% &&% exit% 1`);
    expect(defaultConfig().git).toEqual({ pushIntegration: false, fetchIntervalMs: 30_000 });
    const graph = `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T1] }\n`;
    h = await makeSlice({ graph, realVerifier: true, dir: f.dir, repo: f.repo });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 30_000);
    const mvp = h.orch.entry('MVP');
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, mvp.reviewVersion)).toEqual({ ok: true });
    await h.orch.tick();
    await h.restart();
    await h.orch.tick();
    expect(gitIn(f.repo, 'rev-parse', 'refs/tags/milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(firstParent(f.repo).at(-1));
    // Control: the trap fires when something does contact the remote.
    try {
      gitIn(f.repo, 'fetch', 'origin');
    } catch {
      /* the transport exits 1 */
    }
    expect(existsSync(marker)).toBe(true);
  }, 60_000);
});
