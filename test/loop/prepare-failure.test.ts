import { afterEach, describe, expect, it } from 'vitest';
import { type Config, type ConfigInput, configSchema } from '../../src/config.js';
import { type PrepareRunner, type PrepareRunResult, readPrepareRetry } from '../../src/launch/prepare.js';
import type { Launch } from '../../src/state/store.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * Prepare failures counted per task (ORC-131): a doubling backoff before the next launch, and a block as
 * `prepareFailed` after prepareFailureLimit failures in a row. See specs/pull-runner "Prepare failure limit".
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

interface Call {
  cwd: string;
  signal: AbortSignal;
  resolve(r: PrepareRunResult): void;
}

interface Fake {
  calls: Call[];
  run: PrepareRunner;
  auto: ((c: Call) => PrepareRunResult | undefined) | undefined;
}

function fakeRunner(): Fake {
  const fake: Fake = {
    calls: [],
    auto: undefined,
    run: (_command, cwd, opts) =>
      new Promise<PrepareRunResult>((resolve) => {
        const call: Call = { cwd, signal: opts.signal, resolve };
        fake.calls.push(call);
        const r = fake.auto?.(call);
        if (r) resolve(r);
      }),
  };
  return fake;
}

const OK: PrepareRunResult = { code: 0, timedOut: false, output: 'installed' };
const EXIT1: PrepareRunResult = { code: 1, timedOut: false, output: 'npm ERR! boom' };

const ONE = `nodes:
  - { id: A }`;
const TWO = `nodes:
  - { id: A }
  - { id: B }`;
const DEP = `nodes:
  - { id: D }
  - { id: T, deps: [D] }`;

function harness(graph: string, config: ConfigInput = {}, mode: Config['runner']['mode'] = 'spawn'): { h: Harness; r: Fake } {
  const h = makeHarness({
    graph,
    config: {
      prepareCommand: 'install',
      tickIntervalMs: 100,
      ...config,
      runner: { mode, claimWindowMs: 60_000, ...(config.runner ?? {}) },
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: false, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  const r = fakeRunner();
  h.orch.prepareRunner = r.run;
  return { h, r };
}

const launchesOf = (h: Harness, taskId: string): Launch[] => [...h.store.listLaunches({ taskId })].sort((a, b) => a.launchNo - b.launchNo);
const latest = (h: Harness, taskId: string): Launch => launchesOf(h, taskId).at(-1)!;
const created = (h: Harness, taskId: string) => h.store.listEvents({ kind: 'launch.created', taskId }).length;
const failedEvents = (h: Harness, taskId: string) => h.store.listEvents({ kind: 'launch.prepareFailed', taskId }).map((e) => e.payload as Record<string, unknown>);
const lastFailed = (h: Harness, taskId: string) => failedEvents(h, taskId).at(-1)!;
const callOf = (r: Fake, l: Launch) => r.calls.filter((c) => c.cwd === l.worktree).at(-1)!;

/** The task's latest launch is preparing: answer its command and apply the outcome with one tick. */
async function answer(h: Harness, r: Fake, taskId: string, result: PrepareRunResult): Promise<void> {
  await h.orch.prepareStarted();
  const l = latest(h, taskId);
  expect(l.status).toBe('preparing');
  callOf(r, l).resolve(result);
  await h.orch.prepareSettled();
  await h.orch.tick();
}

/** Wait out the task's retry and tick: the next launch is created. */
async function atRetry(h: Harness, taskId: string): Promise<void> {
  const retryAt = readPrepareRetry(h.store)[taskId]!.retryAt;
  h.advance(retryAt - h.now.value);
  await h.orch.tick();
}

describe('prepare failure limit', () => {
  it('the first failure is counted: failures 1, limit 3, retryAt the clock plus 30000; no attempt spent', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    const now = h.now.value;
    expect(failedEvents(h, 'A')).toHaveLength(1);
    expect(lastFailed(h, 'A')).toMatchObject({ reason: 'exit', failures: 1, limit: 3, retryAt: now + 30_000 });
    expect(readPrepareRetry(h.store)['A']).toEqual({ failures: 1, retryAt: now + 30_000, last: 'exit 1' });
    expect(h.orch.entry('A')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
  });

  it('backoff: no launch before retryAt, one at retryAt, then 60000', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    const retryAt = readPrepareRetry(h.store)['A']!.retryAt;
    expect(created(h, 'A')).toBe(1);
    for (let i = 0; i < 3; i++) {
      h.advance(9_999);
      await h.orch.tick();
    }
    expect(h.now.value).toBeLessThan(retryAt);
    expect(created(h, 'A')).toBe(1);
    expect(h.statusOf('A')).toBe('unstarted');
    h.advance(retryAt - h.now.value);
    await h.orch.tick();
    expect(created(h, 'A')).toBe(2);
    await answer(h, r, 'A', EXIT1);
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 2, retryAt: h.now.value + 60_000 });
    expect(readPrepareRetry(h.store)['A']).toMatchObject({ failures: 2, retryAt: h.now.value + 60_000 });
  });

  it('a waiting task holds no slot: with capacity 1 a second ready task is launched while the first waits', async () => {
    const { h, r } = harness(TWO, { capacity: 1 });
    await h.orch.tick();
    expect(created(h, 'A')).toBe(1);
    expect(created(h, 'B')).toBe(0);
    await answer(h, r, 'A', EXIT1);
    expect(h.statusOf('A')).toBe('unstarted');
    expect(created(h, 'B')).toBe(1);
    expect(h.statusOf('B')).toBe('running');
    expect(created(h, 'A')).toBe(1);
  });

  it('block at the limit: the third failure blocks as prepareFailed with no output; unblock starts the count again', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await answer(h, r, 'A', EXIT1);
    const entry = h.orch.entry('A');
    expect(entry).toMatchObject({ status: { kind: 'blocked', reason: { kind: 'prepareFailed' } }, attempts: 0 });
    const reason = entry.status.kind === 'blocked' ? entry.status.reason : undefined;
    expect(reason?.message).toBe('prepare command `install` failed 3 times in a row; last: exit 1');
    expect(reason?.message).not.toContain('boom');
    expect(JSON.stringify(reason)).not.toContain('boom');
    const third = lastFailed(h, 'A');
    expect(third).toMatchObject({ failures: 3, limit: 3 });
    expect(third).not.toHaveProperty('retryAt');
    expect(third['output']).toContain('boom');
    expect(readPrepareRetry(h.store)).not.toHaveProperty('A');
    expect(h.store.listEvents({ kind: 'transition', taskId: 'A' }).at(-1)!.payload).toMatchObject({ to: 'blocked', trigger: 'prepareFailed' });

    expect(h.orch.unblock('A')).toEqual({ ok: true });
    await h.orch.tick();
    expect(created(h, 'A')).toBe(4);
    await answer(h, r, 'A', EXIT1);
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 1 });
  });

  it('a success resets the count: fail, succeed, fail gives failures 1', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await answer(h, r, 'A', OK);
    expect(h.store.listEvents({ kind: 'launch.prepared', taskId: 'A' })).toHaveLength(1);
    expect(readPrepareRetry(h.store)).not.toHaveProperty('A');
    expect(h.launchOf('A').status).toBe('live');
    // The agent fails; the retry launches again and its command fails.
    await h.failTask('A');
    await h.orch.tick();
    await h.orch.tick();
    expect(h.orch.entry('A').attempts).toBe(1);
    expect(created(h, 'A')).toBe(3);
    await answer(h, r, 'A', EXIT1);
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 1 });
  });

  it('mixed mode: a first run that succeeds clears the entry, so a failure of the second run has failures 1', async () => {
    const { h, r } = harness(ONE, { runner: { mode: 'mixed', claimWindowMs: 2_000 } }, 'mixed');
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await answer(h, r, 'A', OK);
    const l = latest(h, 'A');
    expect(l.status).toBe('claimable');
    expect(readPrepareRetry(h.store)).not.toHaveProperty('A');
    h.advance(2_500);
    await h.orch.tick();
    await h.orch.prepareStarted();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('launching');
    callOf(r, l).resolve(EXIT1);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 1 });
  });

  it('uncancel: cancel leaves the entry, the uncancel removes it; the next tick launches without waiting', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    const retryAt = readPrepareRetry(h.store)['A']!.retryAt;
    expect(h.orch.cancel('A', 'not now')).toEqual({ ok: true });
    expect(readPrepareRetry(h.store)['A']).toMatchObject({ failures: 1 });
    expect(h.orch.reopen('A')).toMatchObject({ ok: true });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'A' }).at(-1)!.payload).toMatchObject({ from: 'cancelled', to: 'unstarted', trigger: 'uncancel' });
    expect(readPrepareRetry(h.store)).not.toHaveProperty('A');
    await h.orch.tick();
    expect(h.now.value).toBeLessThan(retryAt);
    expect(created(h, 'A')).toBe(2);
    await answer(h, r, 'A', EXIT1);
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 1 });
  });

  async function dependentWithOneFailure(): Promise<{ h: Harness; r: Fake }> {
    const { h, r } = harness(DEP);
    r.auto = (c) => (launchesOf(h, 'D').some((l) => l.worktree === c.cwd) ? OK : undefined);
    await h.orch.tick();
    await h.orch.prepareSettled();
    await h.orch.tick();
    await h.submit('D');
    await h.orch.settle();
    expect(h.statusOf('D')).toBe('done');
    await answer(h, r, 'T', EXIT1);
    expect(readPrepareRetry(h.store)['T']).toMatchObject({ failures: 1 });
    return { h, r };
  }

  it('cascade: a task reset by the cascade loses its entry; an unstarted one waiting out a retry keeps it', async () => {
    const running = await dependentWithOneFailure();
    await atRetry(running.h, 'T');
    await running.h.orch.prepareStarted();
    expect(running.h.statusOf('T')).toBe('running');
    expect(latest(running.h, 'T').status).toBe('preparing');
    expect(running.h.orch.reopen('D', { cascade: true })).toMatchObject({ ok: true });
    await running.h.orch.tick();
    expect(running.h.statusOf('T')).toBe('unstarted');
    expect(running.h.store.listEvents({ kind: 'transition', taskId: 'T' }).at(-1)!.payload).toMatchObject({ trigger: 'cascade' });
    expect(readPrepareRetry(running.h.store)).not.toHaveProperty('T');

    const waiting = await dependentWithOneFailure();
    expect(waiting.h.statusOf('T')).toBe('unstarted');
    expect(waiting.h.orch.reopen('D', { cascade: true })).toMatchObject({ ok: true });
    await waiting.h.orch.tick();
    expect(waiting.h.statusOf('D')).not.toBe('done');
    expect(readPrepareRetry(waiting.h.store)['T']).toMatchObject({ failures: 1 });
  });

  it('a cancel during a command counts nothing', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    expect(h.orch.cancel('A', 'not needed')).toEqual({ ok: true });
    await h.orch.tick();
    expect(callOf(r, l).signal.aborted).toBe(true);
    callOf(r, l).resolve(EXIT1);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(failedEvents(h, 'A')).toHaveLength(1);
    expect(readPrepareRetry(h.store)['A']).toMatchObject({ failures: 1 });
  });

  it('activity: an entry of an unstarted task keeps the daemon from being quiescent', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', EXIT1);
    const retryAt = readPrepareRetry(h.store)['A']!.retryAt;
    expect(h.store.listLaunches({ status: ['preparing', 'launching', 'live'] })).toEqual([]);
    expect(h.orch.quiescent()).toBe(false);
    h.advance(retryAt - h.now.value + 1);
    expect(h.orch.quiescent()).toBe(false);
    expect(h.orch.cancel('A', 'stop')).toEqual({ ok: true });
    expect(readPrepareRetry(h.store)['A']).toBeDefined();
    expect(h.orch.quiescent()).toBe(true);

    const limit = harness(ONE, { prepareFailureLimit: 1 });
    await limit.h.orch.tick();
    await answer(limit.h, limit.r, 'A', EXIT1);
    expect(limit.h.statusOf('A')).toBe('blocked');
    expect(limit.h.orch.quiescent()).toBe(true);

    const foreign = harness(ONE);
    await foreign.h.orch.loadGraph();
    expect(foreign.h.orch.cancel('A', 'idle')).toEqual({ ok: true });
    foreign.h.store.setKv('prepareRetry', JSON.stringify({ ZZ: { failures: 1, retryAt: 0, last: 'exit 1' } }));
    expect(foreign.h.orch.quiescent()).toBe(true);
  });

  it('a failure across a machine sleep counts like any other', async () => {
    const gapAfterMs = 1_000;
    const { h, r } = harness(ONE, { health: { gapAfterMs, gapHoldMs: 5_000 } });
    await h.orch.tick();
    await h.orch.prepareStarted();
    h.sleep(2 * gapAfterMs);
    callOf(r, latest(h, 'A')).resolve(EXIT1);
    await h.orch.prepareSettled();
    await h.orch.tick();
    // The tick that applied the failure saw the gap.
    expect(h.orch.inHold()).toBe(true);
    expect(h.store.listEvents({ kind: 'daemon.gap' })).toHaveLength(1);
    expect(lastFailed(h, 'A')).toMatchObject({ failures: 1 });
    expect(h.orch.entry('A')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    await atRetry(h, 'A');
    expect(h.orch.inHold()).toBe(false);
    await answer(h, r, 'A', EXIT1);
    await atRetry(h, 'A');
    await answer(h, r, 'A', EXIT1);
    expect(h.orch.entry('A')).toMatchObject({ status: { kind: 'blocked', reason: { kind: 'prepareFailed' } }, attempts: 0 });
  });

  it('the keys: limit 1 blocks at once, backoff 0 relaunches in the same tick, bad values are rejected', async () => {
    const one = harness(ONE, { prepareFailureLimit: 1 });
    await one.h.orch.tick();
    await answer(one.h, one.r, 'A', EXIT1);
    expect(one.h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'prepareFailed', message: 'prepare command `install` failed 1 times in a row; last: exit 1' } });
    expect(one.h.store.getKv('prepareRetry') ?? '').toBe('');

    const zero = harness(ONE, { prepareRetryBackoffMs: 0 });
    await zero.h.orch.tick();
    await answer(zero.h, zero.r, 'A', EXIT1);
    expect(lastFailed(zero.h, 'A')).toMatchObject({ failures: 1, retryAt: zero.h.now.value });
    expect(created(zero.h, 'A')).toBe(2);
    expect(zero.h.statusOf('A')).toBe('running');

    expect(configSchema.shape.prepareFailureLimit.safeParse(0).success).toBe(false);
    expect(configSchema.shape.prepareRetryBackoffMs.safeParse(-1).success).toBe(false);
    const defaults = configSchema.parse({});
    expect({ limit: defaults.prepareFailureLimit, backoff: defaults.prepareRetryBackoffMs }).toEqual({ limit: 3, backoff: 30_000 });
    expect(configSchema.safeParse({ prepareFailureLimit: 0 }).success).toBe(false);
    expect(configSchema.safeParse({ prepareRetryBackoffMs: -1 }).success).toBe(false);
  });

  it('with no prepareCommand the retry entry is never written', async () => {
    const h = makeHarness({ graph: TWO, config: { runner: { mode: 'spawn' } } });
    open.push(h);
    await h.orch.tick();
    await h.submit('A');
    await h.orch.settle();
    expect(h.statusOf('A')).toBe('done');
    expect(h.orch.cancel('B', 'no')).toEqual({ ok: true });
    expect(h.orch.reopen('B')).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.store.getKv('prepareRetry')).toBeUndefined();
  });

  it('an agent cannot block with kind prepareFailed', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await answer(h, r, 'A', OK);
    const l = h.launchOf('A');
    const res = await h.orch.agentCall(l.launchId, l.token, 'block', { seq: 2, kind: 'prepareFailed', message: 'which way?' });
    expect(res.status).toBe(400);
    expect(h.statusOf('A')).toBe('running');
  });
});
