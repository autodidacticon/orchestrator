import { afterEach, describe, expect, it } from 'vitest';
import { composeBrief } from '../../src/brief/compose.js';
import type { Config, ConfigInput } from '../../src/config.js';
import type { Launch } from '../../src/state/store.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * Claimed-launch leases (ORC-85): the lease facts in the claim, renewal by the work loop that is not
 * progress, and an expiry with progress in the worktree as a kept release. See specs/pull-runner.
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const TTL = 60_000;
const TICK = 100;

function harness(health: Partial<Config['health']> = {}, config: ConfigInput = {}): Harness {
  const h = makeHarness({
    config: {
      runner: { mode: 'pull', claimWindowMs: 60_000 },
      leaseTtlMs: TTL,
      tickIntervalMs: TICK,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, ...health },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 },
      ...config,
    },
  });
  open.push(h);
  return h;
}

async function claimT1(h: Harness): Promise<{ launch: Launch; body: Record<string, unknown> }> {
  await h.orch.tick();
  const c = await h.orch.claim({ workerId: 'w1', taskId: 'T1' });
  expect(c.status).toBe(200);
  return { launch: h.store.getLaunch(String(c.body['launchId']))!, body: c.body };
}

/** The tick that observes a worktree change renews the lease; then the worker falls silent past the TTL. */
async function settleSilent(h: Harness): Promise<void> {
  h.advance(TICK);
  await h.orch.tick();
  h.advance(TTL + 1);
  await h.orch.tick();
}

const renew = (h: Harness, l: Launch) => h.orch.renewClaim(l.launchId, l.token);

describe('claimed-launch leases', () => {
  it('the claim states the lease TTL, the expiry, and the interval; a repeated claim states the current expiry', async () => {
    const h = harness();
    const { body } = await claimT1(h);
    const claimedAt = h.now.value;
    expect(body).toMatchObject({ leaseTtlMs: TTL, leaseExpiresAt: claimedAt + TTL, lease: { ttlMs: TTL, expiresAt: claimedAt + TTL, renewEveryMs: TTL / 3 } });
    h.advance(5_000);
    const l = h.launchOf('T1');
    await h.orch.agentCall(l.launchId, l.token, 'heartbeat', { progress: 'p' });
    const again = await h.orch.claim({ workerId: 'w1' });
    expect(again.body).toMatchObject({ repeated: true, leaseExpiresAt: claimedAt + 5_000 + TTL, lease: { expiresAt: claimedAt + 5_000 + TTL } });
    // The brief names the same interval, from the same TTL.
    const brief = h.workspace.briefs.get(l.launchId)!;
    expect(brief.leaseTtlMs).toBe(TTL);
    const { markdown, json } = composeBrief(brief, { fallbackPath: '/tmp/f.json', openspec: false });
    expect(json.leaseTtlMs).toBe(TTL);
    expect(markdown).toContain('at least every 20s (`lease.renewEveryMs` 20000, a third of the lease)');
    expect(markdown).toMatch(/Run any command expected to take longer than that in the background and call `heartbeat` while it runs/);
  });

  it('a loop renewal keeps a silent claimed launch past the TTL and is not progress: it is still reported stuck', async () => {
    const stuckAfterMs = 2 * TTL;
    const h = harness({ stuckAfterMs });
    const { launch } = await claimT1(h);
    const before = h.store.getLaunch(launch.launchId)!;
    // Five TTLs of silence from the agent, renewed every third of the TTL by its loop.
    for (let t = 0; t < 15; t++) {
      h.advance(TTL / 3);
      expect(renew(h, launch)).toMatchObject({ status: 200, body: { ok: true, ttlMs: TTL, renewEveryMs: TTL / 3, expiresAt: h.now.value + TTL } });
      await h.orch.tick();
      expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    }
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 1, status: { kind: 'running' } });
    const after = h.store.getLaunch(launch.launchId)!;
    expect(after.progressAt).toBe(before.progressAt);
    expect(after.lastSignal).toBe('claimed');
    expect(after.stuckSince).toBeDefined();
    expect(h.store.listEvents({ kind: 'launch.stuck', launchId: launch.launchId })).toHaveLength(1);
    expect(h.orch.status().stuck).toEqual(['T1']);
    expect(h.store.listEvents({ kind: 'agent.heartbeat', launchId: launch.launchId })).toEqual([]);
  });

  it('a claim whose loop stopped renewing expires within the TTL plus one tick', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    h.advance(TTL / 3);
    renew(h, launch);
    const lastContact = h.now.value;
    // The loop is gone: nothing renews any more.
    h.advance(TTL - 1);
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    h.advance(TICK);
    await h.orch.tick();
    expect(h.now.value - lastContact).toBeLessThanOrEqual(TTL + TICK);
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2 });
    // A renewal after the end is refused, which stops the loop's timer.
    expect(renew(h, launch).status).toBe(401);
  });

  it('renewal is refused for a wrong token and for a launch that is not claimed', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    expect(h.orch.renewClaim(launch.launchId, 'nope').status).toBe(401);
    const spawned = makeHarness({ config: { tickIntervalMs: TICK, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true } } });
    open.push(spawned);
    await spawned.orch.tick();
    const s = spawned.launchOf('T1');
    expect(spawned.orch.renewClaim(s.launchId, s.token)).toMatchObject({ status: 409, body: { ok: false } });
  });

  it('an expiry with a commit since the claim is a kept release: branch kept, attempt not spent, the retry briefed with the branch', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    h.workspace.fingerprints.set(launch.launchId, 'c1:clean');
    await settleSilent(h);
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: launch.launchId }).map((e) => e.payload)).toEqual([{ endReason: 'leaseExpired', kept: true }]);
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId }).map((e) => e.payload)).toMatchObject([{ reasonCode: 'leaseExpired', progressed: true, kept: true }]);
    const entry = h.orch.entry('T1');
    expect(entry).toMatchObject({ attempts: 0, interruptions: 1, status: { kind: 'running' } });
    const next = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(next.launchId).not.toBe(launch.launchId);
    const brief = h.workspace.briefs.get(next.launchId)!;
    expect(brief.carry).toMatchObject({ interrupted: { priorLaunchId: launch.launchId, priorBranch: launch.branch, headSha: 'c1', reason: 'leaseExpired', interruptions: 1 } });
    expect(brief.carry?.['priorFailure']).toBeUndefined();
    const { markdown } = composeBrief(brief, { fallbackPath: '/tmp/f.json', openspec: false });
    expect(markdown).toContain(`Its branch \`${launch.branch}\` holds the work so far at \`c1\``);
  });

  it('an expiry with only a dirty file commits it on the branch and is kept', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    h.workspace.markProgress(launch.launchId, 'head0', true);
    await settleSilent(h);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1 });
    const next = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(h.workspace.briefs.get(next.launchId)?.carry).toMatchObject({ interrupted: { wipCommit: `wip-${launch.launchId.slice(0, 8)}`, priorBranch: launch.branch } });
  });

  it('an expiry without progress in the worktree spends the attempt, even after calls', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    await h.orch.agentCall(launch.launchId, launch.token, 'heartbeat', { progress: 'thinking' });
    await settleSilent(h);
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2 });
    expect(h.orch.entry('T1').interruptions ?? 0).toBe(0);
    const next = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(h.workspace.briefs.get(next.launchId)?.carry).toMatchObject({ priorFailure: { kind: 'leaseExpired' } });
  });

  it('a call that renews the lease while the worktree is checked keeps the launch live', async () => {
    const h = harness();
    const { launch } = await claimT1(h);
    h.workspace.fingerprints.set(launch.launchId, 'c1:clean');
    const preserve = h.workspace.preserve.bind(h.workspace);
    h.workspace.preserve = async (l) => {
      await h.orch.agentCall(launch.launchId, launch.token, 'heartbeat', { progress: 'still here' });
      return preserve(l);
    };
    await settleSilent(h);
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 1, status: { kind: 'running' } });
    expect(h.orch.entry('T1').interruptions ?? 0).toBe(0);
  });

  it('kept expiries are bounded by daemon.maxKeptReleases; past the bound an expiry with progress spends the attempt', async () => {
    const h = harness({}, { daemon: { maxKeptReleases: 1 } });
    const { launch } = await claimT1(h);
    h.workspace.fingerprints.set(launch.launchId, 'c1:clean');
    await settleSilent(h);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, interruptions: 1 });
    const c2 = await h.orch.claim({ workerId: 'w1', taskId: 'T1' });
    expect(c2.status).toBe(200);
    const l2 = h.store.getLaunch(String(c2.body['launchId']))!;
    h.workspace.fingerprints.set(l2.launchId, 'c2:clean');
    await settleSilent(h);
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, interruptions: 1 });
  });
});
