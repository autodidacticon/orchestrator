import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const pull = (leaseTtlMs = 60_000) => ({ leaseTtlMs, runner: { mode: 'pull' as const, claimWindowMs: 60_000 }, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true } });

describe('recovery of parked and claimed launches', () => {
  it('a restart keeps a parked launch claimable and re-prepares a deleted worktree for the same launch', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull() });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l?.status).toBe('claimable');
    await h.restart();
    expect(h.store.getLaunch(l!.launchId)?.status).toBe('claimable');
    expect(existsSync(path.join(l!.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    rmSync(l!.worktree, { recursive: true, force: true });
    await h.restart();
    expect(h.store.getLaunch(l!.launchId)?.status).toBe('claimable');
    expect(existsSync(path.join(l!.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    expect(h.store.listEvents({ kind: 'launch.reprepared', launchId: l!.launchId })).toHaveLength(1);
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
    const c = await h.orch.claim({ workerId: 'w1' });
    expect(c.body).toMatchObject({ launchId: l!.launchId });
  }, 30_000);

  it('a restart keeps a claimed launch live and its worker keeps working; an abandoned claim expires into a failed attempt', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull(1200) });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1' });
    const launchId = String(c.body['launchId']);
    const token = String(c.body['token']);
    await h.restart();
    expect(h.store.getLaunch(launchId)).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(h.store.getLaunch(launchId)?.pid).toBeUndefined();
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect((await h.orch.agentCall(launchId, token, 'heartbeat')).status).toBe(200);
    await h.orch.tick();
    expect(h.store.getLaunch(launchId)?.status).toBe('live');

    // Abandoned: no calls and no worktree change past the TTL.
    await h.waitFor(() => h!.store.getLaunch(launchId)?.status === 'ended', 10_000);
    expect(h.store.getLaunch(launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    const next = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(next).toMatchObject({ status: 'claimable', launchNo: 2 });
    expect(existsSync(path.join(next.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    expect(existsSync(h.store.getLaunch(launchId)!.worktree)).toBe(false);
    expect(h.workspace).toBeDefined();
  }, 30_000);

  // ORC-85, against real git worktrees: see specs/pull-runner "Lease expiry".
  it('an expired claim with a dirty file is kept on its branch at no cost; an untouched retry that expires spends the attempt', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull(1500) });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1' });
    const first = h.store.getLaunch(String(c.body['launchId']))!;
    writeFileSync(path.join(first.worktree, 'progress.txt'), 'half done\n');
    // Staged, so it is progress; an untracked file alone is not (ORC-90).
    execFileSync('git', ['-C', first.worktree, 'add', 'progress.txt']);
    await h.waitFor(() => h!.store.getLaunch(first.launchId)?.status === 'ended', 15_000);
    expect(h.store.getLaunch(first.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(existsSync(first.worktree)).toBe(false);
    // The branch is kept, holding a WIP commit of the dirty file on top of the base.
    const head = execFileSync('git', ['-C', h.repo, 'rev-parse', `refs/heads/${first.branch}`], { encoding: 'utf8' }).trim();
    expect(head).not.toBe(first.baseSha);
    expect(execFileSync('git', ['-C', h.repo, 'show', `${head}:progress.txt`], { encoding: 'utf8' })).toBe('half done\n');
    expect(execFileSync('git', ['-C', h.repo, 'rev-parse', `${head}^`], { encoding: 'utf8' }).trim()).toBe(first.baseSha);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1, status: { kind: 'running' } });

    // The retry's brief names the kept branch.
    await h.waitFor(() => h!.store.listLaunches({ taskId: 'T1', status: 'claimable' }).length === 1, 10_000);
    const second = h.store.listLaunches({ taskId: 'T1', status: 'claimable' })[0]!;
    const brief = readFileSync(path.join(second.worktree, '.orchestrator', 'brief.md'), 'utf8');
    expect(brief).toContain(`Its branch \`${first.branch}\` holds the work so far at \`${head}\``);
    expect(brief).toContain('interrupted (leaseExpired)');

    // The retry touches nothing (its worktree is at its base sha under the real prepare) and expires: a failed attempt.
    const c2 = await h.orch.claim({ workerId: 'w2' });
    expect(c2.body['launchId']).toBe(second.launchId);
    await h.waitFor(() => h!.store.getLaunch(second.launchId)?.status === 'ended', 15_000);
    expect(h.store.getLaunch(second.launchId)).toMatchObject({ endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, interruptions: 1 });
  }, 60_000);
});

// ORC-90: see specs/pull-runner "Lease expiry" and specs/crash-recovery "Claimed lease expired while the daemon was down".
describe('lease expiry hardening', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const commitIn = (worktree: string, file: string, text: string): string => {
    writeFileSync(path.join(worktree, file), text);
    git(worktree, 'add', file);
    git(worktree, '-c', 'user.name=w', '-c', 'user.email=w@localhost', 'commit', '-q', '-m', `add ${file}`);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  const claimFirst = async (): Promise<ReturnType<NonNullable<SliceHarness['store']>['getLaunch']> & object> => {
    await h!.orch.tick();
    const c = await h!.orch.claim({ workerId: 'w1' });
    return h!.store.getLaunch(String(c.body['launchId']))!;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a failed work-in-progress commit (index.lock held) still keeps a branch with commits, at no attempt cost', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull(1500) });
    const first = await claimFirst();
    const sha = commitIn(first.worktree, 'done.txt', 'part one\n');
    // Uncommitted work too, and the worker holds the index lock: `git add` in the WIP commit fails.
    writeFileSync(path.join(first.worktree, 'done.txt'), 'part one\npart two\n');
    const gitDir = git(first.worktree, 'rev-parse', '--absolute-git-dir');
    writeFileSync(path.join(gitDir, 'index.lock'), '');
    await h.waitFor(() => h!.store.getLaunch(first.launchId)?.status === 'ended', 15_000);
    expect(h.store.getLaunch(first.launchId)).toMatchObject({ endReason: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: first.launchId }).map((e) => e.payload)).toEqual([{ endReason: 'leaseExpired', kept: true }]);
    expect(git(h.repo, 'rev-parse', `refs/heads/${first.branch}`)).toBe(sha);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1 });
    expect(h.orch.entry('T1').carry).toMatchObject({ interrupted: { headSha: sha, priorBranch: first.branch, reason: 'leaseExpired' } });
    expect(h.orch.entry('T1').carry?.interrupted?.wipCommit).toBeUndefined();
  }, 60_000);

  it('an untracked file alone is not progress: the expiry spends the attempt and commits nothing', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull(1500) });
    const first = await claimFirst();
    writeFileSync(path.join(first.worktree, 'coverage.out'), 'artefact of a check command\n');
    await h.waitFor(() => h!.store.getLaunch(first.launchId)?.status === 'ended', 15_000);
    expect(h.store.getLaunch(first.launchId)).toMatchObject({ endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1 });
    expect(h.orch.entry('T1').interruptions ?? 0).toBe(0);
    expect(git(h.repo, 'rev-parse', `refs/heads/${first.branch}`)).toBe(first.baseSha);
  }, 60_000);

  it('a staged new file is progress and is committed; an untracked file beside it is left out of the kept commit', async () => {
    h = await makeSlice({ graph: single('hang'), config: pull(1500) });
    const first = await claimFirst();
    writeFileSync(path.join(first.worktree, 'wanted.txt'), 'on purpose\n');
    git(first.worktree, 'add', 'wanted.txt');
    writeFileSync(path.join(first.worktree, 'coverage.out'), 'artefact\n');
    await h.waitFor(() => h!.store.getLaunch(first.launchId)?.status === 'ended', 15_000);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1 });
    const head = git(h.repo, 'rev-parse', `refs/heads/${first.branch}`);
    expect(git(h.repo, 'rev-parse', `${head}^`)).toBe(first.baseSha);
    expect(git(h.repo, 'show', '--name-only', '--format=', head).split('\n')).toEqual(['wanted.txt']);
  }, 60_000);

  it('a parked launch spawned after its claim window is rebriefed without the lease line and finishes its task', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), config: { leaseTtlMs: 60_000, runner: { mode: 'mixed', claimWindowMs: 300 } } });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l?.status).toBe('claimable');
    const briefMd = () => readFileSync(path.join(l!.worktree, '.orchestrator', 'brief.md'), 'utf8');
    const briefJson = () => JSON.parse(readFileSync(path.join(l!.worktree, '.orchestrator', 'brief.json'), 'utf8')) as Record<string, unknown>;
    expect(briefMd()).toContain('- Lease:');
    expect(briefJson()['leaseTtlMs']).toBe(60_000);
    await sleep(400);
    await h.orch.tick();
    const spawned = h.store.getLaunch(l!.launchId)!;
    expect(spawned.status).toBe('live');
    expect(spawned.pid).toBeGreaterThan(0);
    expect(briefMd()).not.toContain('- Lease:');
    expect(briefJson()['leaseTtlMs']).toBeUndefined();
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 1 });
  }, 60_000);

  it('at startup, a claim whose lease ran out while the daemon was down is kept with commits and failed without', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: "hang" }\n  - { id: T2, deps: [], behavior: "hang" }`, config: { ...pull(1200), capacity: 2 } });
    await h.orch.tick();
    const a = h.store.getLaunch(String((await h.orch.claim({ workerId: 'w1', taskId: 'T1' })).body['launchId']))!;
    const b = h.store.getLaunch(String((await h.orch.claim({ workerId: 'w2', taskId: 'T2' })).body['launchId']))!;
    const sha = commitIn(a.worktree, 'done.txt', 'work\n');
    // No tick runs while "down"; both leases run out.
    await sleep(1500);
    await h.restart();
    expect(h.store.getLaunch(a.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: a.launchId }).map((e) => e.payload)).toEqual([{ endReason: 'leaseExpired', kept: true }]);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1, status: { kind: 'unstarted' } });
    expect(git(h.repo, 'rev-parse', `refs/heads/${a.branch}`)).toBe(sha);
    expect(h.store.getLaunch(b.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T2')).toMatchObject({ attempts: 1 });
    expect(h.orch.entry('T2').interruptions ?? 0).toBe(0);
    expect(existsSync(a.worktree)).toBe(false);
    expect(existsSync(b.worktree)).toBe(false);
  }, 60_000);
});
