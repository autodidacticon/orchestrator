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
