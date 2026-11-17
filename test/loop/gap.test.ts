import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { MultiRunner } from '../../src/runner/multi.js';
import type { Launch } from '../../src/state/store.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * Gaps in the daemon's clock (ORC-112): a sleep is left out of the stuck limits, the launch time budget and leases,
 * and nothing starts for health.gapHoldMs after one. `advance` is time the daemon ran; `sleep` is a gap.
 * See specs/health-monitoring "Gap in the daemon's clock", "Hold after a gap" and specs/pull-runner "Lease renewal after a gap".
 */
const open: Harness[] = [];
/** Orchestrators whose loop a test started: stopped even when the test fails, so no loop outlives it. */
const started: Orchestrator[] = [];
afterEach(async () => {
  for (const o of started.splice(0)) await o.stop();
  vi.useRealTimers();
  for (const h of open.splice(0)) h.cleanup();
});

const TICK = 100;
const MIN = 60_000;
const FAIL = 10 * MIN;
const HOLD = MIN; // the default health.gapHoldMs
const TTL = 2 * MIN;

const ONE = `nodes:
  - { id: A }`;
const TWO = `nodes:
  - { id: A }
  - { id: B }`;
/** Nothing ever launches: the only task waits on an open external node. */
const QUIET = `nodes:
  - { id: X, kind: external, done: false }
  - { id: T1, deps: [X] }`;
const FOUR = `nodes:
  - { id: P }
  - { id: W }
  - { id: J }
  - { id: R }`;

function harness(config: ConfigInput = {}, graph = ONE): Harness {
  const h = makeHarness({
    graph,
    config: {
      tickIntervalMs: TICK,
      ...config,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  return h;
}

const gaps = (h: Harness) => h.store.listEvents({ kind: 'daemon.gap' });
const count = (h: Harness, kind: string) => h.store.listEvents({ kind }).length;
const resumed = (h: Harness) => h.store.listEvents({ kind: 'transition' }).filter((e) => e.payload?.['trigger'] === 'resumed').length;
const liveOf = (h: Harness, taskId: string) => h.orch.status().liveLaunches.find((l) => l.taskId === taskId)!;
const row = (h: Harness, l: Launch) => h.store.getLaunch(l.launchId)!;

async function claim(h: Harness, taskId: string): Promise<Launch> {
  const c = await h.orch.claim({ workerId: `w-${taskId}`, taskId });
  expect(c.status).toBe(200);
  return h.store.getLaunch(String(c.body['launchId']))!;
}

/** Block a live launch on a question and let the call park. */
async function blockOn(h: Harness, taskId: string): Promise<void> {
  void h.block(taskId, 'which way?');
  await new Promise((r) => setTimeout(r, 10));
  expect(h.statusOf(taskId)).toBe('waiting');
}

describe('a gap is left out of the stuck limits', () => {
  it('a sleep does not end a silent launch; awake silence still does', async () => {
    const h = harness({ health: { stuckFailAfterMs: FAIL } });
    await h.orch.tick();
    const l = h.launchOf('A');
    const from = h.now.value;
    h.sleep(2 * FAIL);
    const to = h.now.value;
    await h.orch.tick();
    expect(row(h, l).status).toBe('live');
    expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toEqual([]);
    expect(gaps(h)).toMatchObject([{ ts: to, payload: { from, to, gapMs: to - from, holdUntil: to + HOLD } }]);
    expect(gaps(h)[0]!.payload).toEqual({ from, to, gapMs: 2 * FAIL, holdUntil: to + HOLD });

    h.advance(FAIL + TICK);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'stuck' });
    expect(h.orch.entry('A').attempts).toBe(1);
  });

  it('a launch flagged stuck before the sleep stays flagged, and writing the gap appends no unstuck and no notice', async () => {
    const h = harness({ health: { stuckAfterMs: FAIL / 2, stuckFailAfterMs: FAIL } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.advance(FAIL / 2 + TICK);
    await h.orch.tick();
    const flagged = row(h, l);
    expect(flagged.stuckSince).toBe(h.now.value);
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toHaveLength(1);
    const notices = count(h, 'launch.notice');
    h.sleep(2 * FAIL);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    const after = row(h, l);
    expect(after).toMatchObject({ status: 'live', stuckSince: flagged.stuckSince, progressAt: flagged.progressAt, lastSignal: flagged.lastSignal });
    expect(after.notices).toEqual(flagged.notices);
    expect(h.orch.status().stuck).toEqual(['A']);
    expect(h.store.listEvents({ kind: 'launch.unstuck' })).toEqual([]);
    expect(count(h, 'launch.notice')).toBe(notices);
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toHaveLength(1);
  });
});

describe('a gap is left out of the launch time budget', () => {
  it('a sleep of twice the budget leaves the launch live; awake time past the budget ends it', async () => {
    const max = FAIL;
    const h = harness({ budgets: { maxLaunchMs: max } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.sleep(2 * max);
    await h.orch.tick();
    expect(row(h, l).status).toBe('live');
    expect(liveOf(h, 'A').elapsedMs).toBeLessThan(max);
    expect(h.orch.entry('A').attempts).toBe(0);
    h.advance(max + TICK);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'timeBudget' });
    expect(h.orch.entry('A').attempts).toBe(1);
  });

  it('a wait across a gap grows waitedMs by awake time only, and elapsedMs stays within today\'s arithmetic', async () => {
    const h = harness();
    await h.orch.tick();
    const l = h.launchOf('A');
    const spawnedAt = row(h, l).spawnedAt!;
    // Today's arithmetic: wall time since spawn less the wall time of the wait.
    const wallElapsed = (r: Launch) => Math.max(0, h.now.value - spawnedAt - (r.waitedMs ?? 0) - (r.waitingSince !== undefined ? h.now.value - r.waitingSince : 0));
    let wallWaited = 0;
    const check = () => {
      const e = liveOf(h, 'A').elapsedMs;
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(Math.max(0, h.now.value - spawnedAt - wallWaited - (row(h, l).waitingSince !== undefined ? h.now.value - row(h, l).waitingSince! : 0)));
      return e;
    };
    h.advance(MIN);
    await blockOn(h, 'A');
    const askedAt = h.now.value;
    h.advance(MIN);
    check();
    h.sleep(20 * MIN);
    await h.orch.tick();
    expect(check()).toBe(MIN);
    h.orch.answer('A', 'left');
    await h.orch.tick();
    expect(resumed(h)).toBe(0); // held
    h.advance(HOLD);
    await h.orch.tick();
    expect(resumed(h)).toBe(1);
    const r = row(h, l);
    wallWaited = h.now.value - askedAt;
    // The wall wait less the sleep.
    expect(r.waitedMs).toBe(wallWaited - 20 * MIN);
    expect(r.waitingSince).toBeUndefined();
    h.advance(2 * MIN);
    // Today's arithmetic would have counted waitedMs as the wall wait; the gap was inside the wait, so the two agree.
    expect(check()).toBe(3 * MIN);
    expect(wallElapsed({ ...r, waitedMs: wallWaited })).toBe(3 * MIN);
    // A further gap while running is left out: elapsed stays below today's value.
    h.sleep(5 * MIN);
    expect(check()).toBe(3 * MIN);
  });
});

describe('a gap renews leases', () => {
  it('a claimed launch survives a sleep of five TTLs between ticks, renewed without progress, and expires a TTL later', async () => {
    const h = harness({ runner: { mode: 'pull', claimWindowMs: MIN }, leaseTtlMs: TTL });
    await h.orch.tick();
    const l = await claim(h, 'A');
    const before = row(h, l);
    h.sleep(5 * TTL);
    const wake = h.now.value;
    await h.orch.tick();
    expect(row(h, l).status).toBe('live');
    expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(h.orch.entry('A').lease!.expiresAt).toBeGreaterThanOrEqual(wake + TTL);
    expect(row(h, l)).toMatchObject({ progressAt: before.progressAt, lastSignal: before.lastSignal });
    expect(row(h, l).progressText).toBe(before.progressText);
    h.advance(TTL + TICK);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('A').attempts).toBe(1);
  });

  it('a spawned launch of unknown liveness survives a sleep of five TTLs, and expires a TTL later', async () => {
    const h = harness({ leaseTtlMs: TTL });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.runner.unknownForAll = true;
    const before = row(h, l);
    h.sleep(5 * TTL);
    const wake = h.now.value;
    await h.orch.tick();
    expect(row(h, l).status).toBe('live');
    expect(h.orch.entry('A').attempts).toBe(0);
    expect(h.orch.entry('A').lease!.expiresAt).toBeGreaterThanOrEqual(wake + TTL);
    expect(row(h, l)).toMatchObject({ progressAt: before.progressAt, lastSignal: before.lastSignal });
    h.advance(TTL + TICK);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('A').attempts).toBe(1);
  });

  /** Make the graph source's next poll sleep five TTLs in one step, inside the tick's awaits before reconcile reads the clock. */
  function sleepInPoll(h: Harness): () => boolean {
    const poll = h.source.poll.bind(h.source);
    let slept = false;
    h.source.poll = async (rev) => {
      if (!slept) {
        slept = true;
        h.sleep(5 * TTL);
      }
      return poll(rev);
    };
    return () => slept;
  }

  it('a sleep inside the awaits before reconcile reads the clock keeps a claimed and a spawned launch', async () => {
    const h = harness({ runner: { mode: 'mixed', claimWindowMs: MIN }, leaseTtlMs: TTL }, TWO);
    await h.orch.tick();
    const a = await claim(h, 'A');
    h.advance(MIN + TICK);
    await h.orch.tick();
    const b = h.launchOf('B');
    expect(b.pid).toBeDefined();
    h.runner.unknownLiveness.add(b.launchId);
    const slept = sleepInPoll(h);
    await h.orch.tick();
    expect(slept()).toBe(true);
    expect(row(h, a).status).toBe('live');
    expect(row(h, b).status).toBe('live');
    expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(h.orch.entry('B')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(gaps(h)).toHaveLength(1);
  });

  it('the same for each alone: a spawned launch of unknown liveness, and a claimed launch', async () => {
    const spawned = harness({ leaseTtlMs: TTL });
    await spawned.orch.tick();
    const s = spawned.launchOf('A');
    spawned.runner.unknownForAll = true;
    const sleptS = sleepInPoll(spawned);
    await spawned.orch.tick();
    expect(sleptS()).toBe(true);
    expect(row(spawned, s).status).toBe('live');
    expect(spawned.orch.entry('A').attempts).toBe(0);

    const pulled = harness({ runner: { mode: 'pull', claimWindowMs: MIN }, leaseTtlMs: TTL });
    await pulled.orch.tick();
    const c = await claim(pulled, 'A');
    const sleptC = sleepInPoll(pulled);
    await pulled.orch.tick();
    expect(sleptC()).toBe(true);
    expect(row(pulled, c).status).toBe('live');
    expect(pulled.orch.entry('A').attempts).toBe(0);
  });
});

describe('a sleep inside the tick loop', () => {
  // With the budget below the step and with the budget off, so the stuck check is seen alone too.
  it.each([FAIL, 0])('a spawned launch is not flagged, failed or ended for time in that tick; the next tick writes the gap (maxLaunchMs %i)', async (maxLaunchMs) => {
    const h = harness({ health: { stuckAfterMs: FAIL / 2, stuckFailAfterMs: FAIL }, budgets: { maxLaunchMs } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.advance(2 * TICK);
    await h.orch.tick();
    const liveness = h.runner.liveness.bind(h.runner);
    let slept = false;
    h.runner.liveness = async (x) => {
      if (!slept) {
        slept = true;
        h.sleep(2 * FAIL);
      }
      return liveness(x);
    };
    await h.orch.tick();
    expect(slept).toBe(true);
    expect(row(h, l)).toMatchObject({ status: 'live' });
    expect(row(h, l).stuckSince).toBeUndefined();
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toEqual([]);
    expect(h.orch.entry('A').attempts).toBe(0);
    expect(gaps(h)).toHaveLength(0);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    expect(row(h, l).status).toBe('live');
  });

  it('a claimed launch whose worktree fingerprint sleeps is not flagged, failed or ended in that tick', async () => {
    const h = harness({ runner: { mode: 'pull', claimWindowMs: MIN }, health: { stuckAfterMs: FAIL / 2, stuckFailAfterMs: FAIL }, budgets: { maxLaunchMs: FAIL } });
    await h.orch.tick();
    const l = await claim(h, 'A');
    h.advance(2 * TICK);
    await h.orch.tick();
    const fingerprint = h.workspace.fingerprint.bind(h.workspace);
    let slept = false;
    h.workspace.fingerprint = async (x) => {
      if (!slept) {
        slept = true;
        h.sleep(2 * FAIL);
      }
      return fingerprint(x);
    };
    h.advance(2 * TICK);
    await h.orch.tick();
    expect(slept).toBe(true);
    expect(row(h, l).status).toBe('live');
    expect(row(h, l).stuckSince).toBeUndefined();
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toEqual([]);
    expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(gaps(h)).toHaveLength(0);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    expect(row(h, l).status).toBe('live');
    expect(h.orch.entry('A').attempts).toBe(0);
  });
});

describe('the hold after a gap', () => {
  it('admits, resumes, spawns and verifies nothing inside the hold, and all four after it', async () => {
    const h = harness({ runner: { mode: 'mixed', claimWindowMs: 30_000 }, capacity: 3 }, FOUR);
    await h.orch.tick();
    expect(h.store.listLaunches({ status: 'claimable' }).map((l) => l.taskId).sort()).toEqual(['J', 'P', 'W']);
    await claim(h, 'W');
    await blockOn(h, 'W');
    await claim(h, 'J');
    await h.submit('J');
    const [job] = h.store.listJobs({ taskId: 'J' });
    expect(job?.status).toBe('queued');
    expect(h.orch.answer('W', 'left')).toEqual({ ok: true });
    h.orch.setConfig({ capacity: 10 });
    const created = count(h, 'launch.created');
    const live = count(h, 'launch.live');

    h.sleep(10 * MIN);
    const wake = h.now.value;
    for (const step of [0, 30_000, HOLD - 30_001]) {
      h.advance(step);
      await h.orch.tick();
      expect(h.now.value).toBeLessThan(wake + HOLD);
      expect(count(h, 'launch.created')).toBe(created);
      expect(count(h, 'launch.live')).toBe(live);
      expect(resumed(h)).toBe(0);
      expect(h.store.getJob(job!.jobId)?.status).toBe('queued');
      expect(h.orch.verifierBusy()).toBe(false);
      expect(h.store.listLaunches({ taskId: 'P', status: 'claimable' })).toHaveLength(1);
    }
    expect(gaps(h)).toHaveLength(1);
    // A hold is neither a pause nor a stall.
    expect(h.orch.status()).toMatchObject({ paused: false, stalled: false });

    h.advance(HOLD);
    await h.orch.tick();
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'R' })).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'launch.live', taskId: 'P' })).toHaveLength(1);
    expect(resumed(h)).toBe(1);
    expect(h.orch.verifierBusy() || h.store.getJob(job!.jobId)?.status !== 'queued').toBe(true);
  });

  it('a second sleep inside the hold starts it again from its own end', async () => {
    const h = harness({}, TWO);
    h.orch.pause();
    await h.orch.tick();
    h.sleep(10 * MIN);
    await h.orch.tick();
    h.orch.resume();
    h.advance(30_000);
    h.sleep(10 * MIN);
    const wake2 = h.now.value;
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(2);
    expect(gaps(h)[1]!.payload).toMatchObject({ to: wake2, holdUntil: wake2 + HOLD });
    h.advance(HOLD - 1);
    await h.orch.tick();
    expect(count(h, 'launch.created')).toBe(0);
    h.advance(1);
    await h.orch.tick();
    expect(count(h, 'launch.created')).toBe(2);
  });

  it('claims are not held, and a dead process is failed as today', async () => {
    const pull = harness({ runner: { mode: 'pull', claimWindowMs: MIN } });
    await pull.orch.tick();
    pull.sleep(10 * MIN);
    await pull.orch.tick();
    expect(pull.orch.inHold()).toBe(true);
    const c = await pull.orch.claim({ workerId: 'w1', taskId: 'A' });
    expect(c.status).toBe(200);

    const h = harness();
    await h.orch.tick();
    const l = h.launchOf('A');
    h.sleep(10 * MIN);
    await h.orch.tick();
    expect(h.orch.inHold()).toBe(true);
    h.runner.die(l.launchId);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'exited' });
    expect(h.orch.entry('A')).toMatchObject({ attempts: 1 });
    // Its relaunch waits for the hold.
    expect(h.store.listLaunches({ taskId: 'A', status: 'live' })).toEqual([]);
  });

  it('two gaps noted before one tick give two events', async () => {
    const h = harness();
    await h.orch.tick();
    const t0 = h.now.value;
    h.sleep(5 * MIN);
    h.orch.noteClock();
    h.advance(10_000);
    h.sleep(7 * MIN);
    const t2 = h.now.value;
    await h.orch.tick();
    expect(gaps(h).map((e) => e.payload)).toEqual([
      { from: t0, to: t0 + 5 * MIN, gapMs: 5 * MIN, holdUntil: t0 + 5 * MIN + HOLD },
      { from: t0 + 5 * MIN + 10_000, to: t2, gapMs: 7 * MIN, holdUntil: t2 + HOLD },
    ]);
  });
});

describe('a gap and idle exit', () => {
  it('the hold keeps a quiescent daemon from exiting, and the gap counts as activity', async () => {
    const exit = 2 * MIN;
    const h = harness({ daemon: { idleExitMs: exit, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    await h.orch.tick();
    expect(h.orch.quiescent()).toBe(true);
    h.sleep(10 * MIN);
    const wake = h.now.value;
    await h.orch.tick();
    expect(h.orch.idleExitDue()).toBe(false);
    h.advance(HOLD - 1);
    await h.orch.tick();
    expect(h.orch.idleMs()).toBe(0);
    expect(h.orch.idleExitDue()).toBe(false);
    // After the hold the idle time runs from the gap's end.
    h.advance(1);
    expect(h.orch.idleMs()).toBe(HOLD);
    expect(h.orch.idleExitDue()).toBe(false);
    h.advance(exit);
    await h.orch.tick();
    expect(h.now.value).toBe(wake + HOLD + exit);
    expect(h.orch.idleExitDue()).toBe(true);
  });

  it('with health.gapHoldMs 0 the gap alone is activity', async () => {
    const exit = 2 * MIN;
    const h = harness({ daemon: { idleExitMs: exit, exitWhileAttached: false, maxKeptReleases: 3 }, health: { gapHoldMs: 0 } }, QUIET);
    await h.orch.tick();
    h.sleep(10 * MIN);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    expect(h.orch.idleExitDue()).toBe(false);
    h.advance(exit - 1);
    await h.orch.tick();
    expect(h.orch.idleExitDue()).toBe(false);
    h.advance(1);
    await h.orch.tick();
    expect(h.orch.idleExitDue()).toBe(true);
  });
});

describe('a gap across a restart', () => {
  const restart = (h: Harness) => new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: new MultiRunner(h.runners), workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });

  it('a second orchestrator reads the written gaps: the same idle and elapsed time, and its first tick keeps the launch', async () => {
    const h = harness({ health: { stuckFailAfterMs: FAIL }, budgets: { maxLaunchMs: FAIL } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.advance(MIN);
    h.sleep(2 * FAIL);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    h.advance(30_000);
    const first = liveOf(h, 'A');
    expect(first.idleMs).toBe(MIN + 30_000);
    const o2 = restart(h);
    await o2.loadGraph();
    const second = o2.status().liveLaunches.find((x) => x.taskId === 'A')!;
    expect({ idleMs: second.idleMs, elapsedMs: second.elapsedMs }).toEqual({ idleMs: first.idleMs, elapsedMs: first.elapsedMs });
    await o2.tick();
    expect(row(h, l).status).toBe('live');
    expect(o2.entry('A').attempts).toBe(0);
  });

  it('the same holds when the launch waited across the gap and was resumed before the restart', async () => {
    const h = harness({ health: { stuckFailAfterMs: FAIL }, budgets: { maxLaunchMs: FAIL } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.advance(MIN);
    await blockOn(h, 'A');
    h.advance(30_000);
    h.sleep(2 * FAIL);
    await h.orch.tick();
    h.orch.answer('A', 'left');
    h.advance(HOLD);
    await h.orch.tick();
    expect(resumed(h)).toBe(1);
    h.advance(30_000);
    const first = liveOf(h, 'A');
    const o2 = restart(h);
    await o2.loadGraph();
    const second = o2.status().liveLaunches.find((x) => x.taskId === 'A')!;
    expect({ idleMs: second.idleMs, elapsedMs: second.elapsedMs }).toEqual({ idleMs: first.idleMs, elapsedMs: first.elapsedMs });
    expect(first.elapsedMs).toBe(MIN + 30_000);
    await o2.tick();
    expect(row(h, l).status).toBe('live');
    expect(o2.entry('A').attempts).toBe(0);
  });
});

describe('the note timer', () => {
  it('a firing after a jump wakes the loop, whose tick writes the gap; after stop() nothing fires', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The tick timer is an hour: only the note timer can bring the next tick.
    const h = harness({ tickIntervalMs: 3_600_000, daemon: { idleExitMs: 0, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    let ticks = 0;
    const tick = h.orch.tick.bind(h.orch);
    h.orch.tick = () => {
      ticks++;
      return tick();
    };
    started.push(h.orch);
    await h.orch.start();
    await until(() => ticks === 1);
    await settled(h);
    expect(gaps(h)).toHaveLength(0);
    h.sleep(10 * MIN);
    vi.advanceTimersByTime(1000);
    await until(() => gaps(h).length === 1);
    expect(ticks).toBe(2);
    await h.orch.stop();
    h.sleep(10 * MIN);
    vi.advanceTimersByTime(5000);
    await new Promise((r) => setTimeout(r, 20));
    expect(gaps(h)).toHaveLength(1);
    expect(ticks).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);

  it('is not armed with health.gapAfterMs 0', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = harness({ health: { gapAfterMs: 0 } }, QUIET);
    h.orch.armNoteTimer();
    expect(vi.getTimerCount()).toBe(0);
    h.orch.clearNoteTimer();
  });
});

describe('no gap, no change; the off switches', () => {
  it('without a gap idle and elapsed time are wall time', async () => {
    const h = harness();
    await h.orch.tick();
    const l = h.launchOf('A');
    h.advance(7 * MIN);
    await h.orch.tick();
    h.advance(3 * MIN + 17);
    const r = row(h, l);
    const s = liveOf(h, 'A');
    expect(s.idleMs).toBe(h.now.value - (r.progressAt ?? r.spawnedAt!));
    expect(s.elapsedMs).toBe(h.now.value - r.spawnedAt!);
    expect(s.elapsedMs).toBe(10 * MIN + 17);
    expect(gaps(h)).toEqual([]);
  });

  it('health.gapAfterMs 0: a sleep ends a silent launch as stuck, no gap is written, and advance moves in one step', async () => {
    const h = harness({ health: { stuckFailAfterMs: FAIL, gapAfterMs: 0 } });
    await h.orch.tick();
    const l = h.launchOf('A');
    h.sleep(2 * FAIL);
    await h.orch.tick();
    expect(row(h, l)).toMatchObject({ status: 'ended', endReason: 'stuck' });
    expect(h.orch.entry('A').attempts).toBe(1);
    expect(gaps(h)).toEqual([]);
    const note = vi.spyOn(h.orch, 'noteClock');
    const before = h.now.value;
    h.advance(10 * MIN);
    expect(h.now.value).toBe(before + 10 * MIN);
    expect(note).not.toHaveBeenCalled();
  });

  it('health.gapHoldMs 0: the tick after a gap admits', async () => {
    const h = harness({ health: { gapHoldMs: 0 } });
    h.orch.pause();
    await h.orch.tick();
    h.orch.resume();
    h.sleep(10 * MIN);
    await h.orch.tick();
    expect(gaps(h)).toHaveLength(1);
    expect(gaps(h)[0]!.payload).toMatchObject({ holdUntil: h.now.value });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'A' })).toHaveLength(1);
  });
});

/** Poll on real timers for up to ten seconds: generous, so a loaded machine does not fail the test. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** Let the loop's tick in progress finish. */
async function settled(h: Harness): Promise<void> {
  for (let i = 0; i < 2000 && (h.orch as unknown as { ticking?: Promise<void> }).ticking; i++) await new Promise((r) => setTimeout(r, 5));
}
