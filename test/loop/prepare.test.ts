import { afterEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config.js';
import { type PrepareRunner, type PrepareRunResult, settlePrepareJobs, spawnPreparedLaunches } from '../../src/launch/prepare.js';
import { recover } from '../../src/launch/recovery.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { MultiRunner } from '../../src/runner/multi.js';
import { RUNNER_KINDS } from '../../src/runner/selection.js';
import type { Launch } from '../../src/state/store.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * The prepare command (ORC-130): run off the tick in each new worktree, before the launch is parked or spawned.
 * See specs/pull-runner "Prepare command", "Prepare failure", "Prepare command and a task that left" and
 * specs/crash-recovery "Prepare command at recovery".
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

interface Call {
  command: string;
  cwd: string;
  timeoutMs: number;
  label: string;
  signal: AbortSignal;
  resolve(r: PrepareRunResult): void;
}

interface Fake {
  calls: Call[];
  run: PrepareRunner;
  /** Answer a call at once when it returns a result. */
  auto: ((c: Call) => PrepareRunResult | undefined) | undefined;
  /** Resolve a pending call as aborted when its signal is aborted. */
  resolveOnAbort: boolean;
}

function fakeRunner(): Fake {
  const fake: Fake = {
    calls: [],
    auto: undefined,
    resolveOnAbort: false,
    run: (command, cwd, opts) =>
      new Promise<PrepareRunResult>((resolve) => {
        const call: Call = { command, cwd, ...opts, resolve };
        fake.calls.push(call);
        if (fake.resolveOnAbort) opts.signal.addEventListener('abort', () => resolve({ code: null, timedOut: false, aborted: true, output: '' }));
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
const THREE = `nodes:
  - { id: A }
  - { id: B }
  - { id: C }`;

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

/** A second daemon on the same store, with its own config, as a restart. */
function restart(h: Harness, config: Partial<Config>): { o: Orchestrator; r: Fake } {
  const o = new Orchestrator({ store: h.store, config: { ...h.orch.config, ...config }, graphSource: h.source, runner: new MultiRunner(h.runners), workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
  const r = fakeRunner();
  o.prepareRunner = r.run;
  return { o, r };
}

const kinds = (h: Harness, launchId: string) => h.store.listEvents({ launchId }).map((e) => e.kind);
const eventsOf = (h: Harness, kind: string, launchId?: string) => h.store.listEvents({ kind, ...(launchId ? { launchId } : {}) });
const spawned = (h: Harness) => RUNNER_KINDS.reduce((n, k) => n + h.runners[k].spawned.length, 0);
const launchesOf = (h: Harness, taskId: string): Launch[] => [...h.store.listLaunches({ taskId })].sort((a, b) => a.launchNo - b.launchNo);
const latest = (h: Harness, taskId: string): Launch => launchesOf(h, taskId).at(-1)!;
const callFor = (r: Fake, l: Launch) => r.calls.filter((c) => c.cwd === l.worktree);
const neverBlocked = (h: Harness, taskId: string) => h.store.listEvents({ kind: 'transition', taskId }).every((e) => e.payload?.['to'] !== 'blocked');

describe('prepare command', () => {
  it('with no prepareCommand nothing changes: no runner call and no prepare event', async () => {
    const h = makeHarness({ graph: ONE, config: { runner: { mode: 'spawn' } } });
    open.push(h);
    const r = fakeRunner();
    h.orch.prepareRunner = r.run;
    await h.orch.tick();
    expect(h.launchOf('A').status).toBe('live');
    await h.submit('A');
    await h.orch.settle();
    expect(h.statusOf('A')).toBe('done');
    expect(r.calls).toHaveLength(0);
    expect(h.orch.prepareJobs.size).toBe(0);
    expect(eventsOf(h, 'launch.prepareStarted')).toEqual([]);
    expect(eventsOf(h, 'launch.prepared')).toEqual([]);
  });

  it('the tick does not wait for the command; other work goes on while it runs', async () => {
    const { h, r } = harness(TWO);
    // B's command succeeds at once; A's stays pending for the whole test.
    r.auto = (c) => (launchesOf(h, 'B').some((l) => l.worktree === c.cwd) ? OK : undefined);
    await h.orch.tick();
    await h.orch.prepareStarted();
    const a = latest(h, 'A');
    expect(a.status).toBe('preparing');
    expect(h.statusOf('A')).toBe('running');
    expect(callFor(r, a)).toHaveLength(1);
    expect(callFor(r, a)[0]).toMatchObject({ command: 'install', cwd: a.worktree, label: `orch-prepare-${a.launchId}`, timeoutMs: 600_000 });
    expect(h.runners['claude-code'].spawned.some((l) => l.taskId === 'A')).toBe(false);
    expect(eventsOf(h, 'launch.prepareStarted', a.launchId)).toMatchObject([{ payload: { command: 'install', timeoutMs: 600_000 } }]);

    await h.orch.tick();
    expect(h.launchOf('B').status).toBe('live');
    await h.submit('B');
    await h.orch.settle();
    expect(h.statusOf('B')).toBe('done');
    expect(h.store.getLaunch(a.launchId)?.status).toBe('preparing');
    expect(h.statusOf('A')).toBe('running');
    expect(callFor(r, a)[0]!.signal.aborted).toBe(false);
    expect(spawned(h)).toBe(1);
  });

  for (const kind of RUNNER_KINDS) {
    it(`after success the launch is spawned with a fresh lease (${kind})`, async () => {
      const { h, r } = harness(`nodes:\n  - { id: K, runner: ${kind} }`);
      await h.orch.tick();
      await h.orch.prepareStarted();
      const l = latest(h, 'K');
      expect(l.runner).toBe(kind);
      h.advance(5_000);
      r.calls[0]!.resolve(OK);
      await h.orch.prepareSettled();
      await h.orch.tick();
      expect(h.store.getLaunch(l.launchId)?.status).toBe('live');
      expect(h.runners[kind].spawned.map((s) => s.launchId)).toEqual([l.launchId]);
      const seq = kinds(h, l.launchId);
      expect(seq.indexOf('launch.prepared')).toBeGreaterThan(-1);
      expect(seq.indexOf('launch.prepared')).toBeLessThan(seq.indexOf('launch.live'));
      expect(eventsOf(h, 'launch.prepared', l.launchId)[0]!.payload).toMatchObject({ command: 'install' });
      expect(h.orch.entry('K').lease?.expiresAt).toBe(h.now.value + h.orch.config.leaseTtlMs);
    });
  }

  it('pull mode: nothing is claimable while the command runs; after success the launch is parked', async () => {
    const { h, r } = harness(ONE, {}, 'pull');
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    expect((await h.orch.claim({ workerId: 'w1' })).status).toBe(404);
    const named = await h.orch.claim({ workerId: 'w1', taskId: 'A' });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({ state: 'preparing' });
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('claimable');
    const seq = kinds(h, l.launchId);
    expect(seq.indexOf('launch.prepared')).toBeGreaterThan(-1);
    expect(seq.indexOf('launch.prepared')).toBeLessThan(seq.indexOf('launch.claimable'));
    expect(h.orch.prepareJobs.size).toBe(0);
  });

  it('a launch whose command runs holds a capacity slot', async () => {
    const { h, r } = harness(THREE, { capacity: 2 });
    await h.orch.tick();
    await h.orch.prepareStarted();
    expect(r.calls).toHaveLength(2);
    expect(h.store.listLaunches({})).toHaveLength(2);
    expect(h.statusOf('C')).toBe('unstarted');
    await h.orch.tick();
    expect(h.statusOf('C')).toBe('unstarted');
    // The first task is spawned and finishes; only then is the third admitted.
    const [first] = h.store.listLaunches({});
    callFor(r, first!)[0]!.resolve(OK);
    await h.orch.prepareJobs.get(first!.launchId)!.done;
    await h.orch.tick();
    expect(h.store.getLaunch(first!.launchId)?.status).toBe('live');
    expect(h.statusOf('C')).toBe('unstarted');
    await h.submit(first!.taskId);
    await h.orch.settle();
    expect(h.statusOf(first!.taskId)).toBe('done');
    expect(h.statusOf('C')).toBe('running');
    expect(latest(h, 'C').status).toBe('preparing');
  });

  it('a failure spends no attempt: the launch ends, the worktree goes, the task is launched again', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    r.calls[0]!.resolve(EXIT1);
    await h.orch.prepareSettled();
    await settlePrepareJobs(h.orch);
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
    expect(h.workspace.worktrees.has(l.launchId)).toBe(false);
    expect(h.orch.entry('A')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(h.orch.entry('A').carry?.priorFailure).toBeUndefined();
    const failed = eventsOf(h, 'launch.prepareFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ reason: 'exit', exitCode: 1, output: expect.stringContaining('boom') });
    expect(spawned(h)).toBe(0);
    expect(h.orch.prepareJobs.size).toBe(0);

    // ORC-131: the second launch comes at the retry time; the count and the block are in prepare-failure.test.ts.
    h.advance(h.orch.config.prepareRetryBackoffMs);
    await h.orch.tick();
    expect(launchesOf(h, 'A')).toHaveLength(2);
    expect(neverBlocked(h, 'A')).toBe(true);
  });

  it('reasons: timeout, killed, spawn and dirty', async () => {
    const graph = `nodes:
  - { id: TO }
  - { id: KI }
  - { id: SP }
  - { id: DI }`;
    const { h, r } = harness(graph);
    const results: Record<string, PrepareRunResult> = {
      TO: { code: null, timedOut: true, output: '' },
      KI: { code: null, timedOut: false, output: '' },
      SP: { code: null, timedOut: false, spawnError: true, output: 'spawn /bin/sh ENOENT' },
      DI: OK,
    };
    r.auto = (c) => results[h.store.listLaunches({}).find((l) => l.worktree === c.cwd)!.taskId];
    h.workspace.sealScript.set('DI', { ok: false, dirty: ['a', 'b'] });
    await h.orch.tick();
    await h.orch.prepareStarted();
    await h.orch.prepareSettled();
    await settlePrepareJobs(h.orch);
    h.workspace.sealScript.delete('DI');
    const reasonOf = (taskId: string) => eventsOf(h, 'launch.prepareFailed', launchesOf(h, taskId)[0]!.launchId)[0]?.payload;
    expect(reasonOf('TO')).toMatchObject({ reason: 'timeout' });
    expect(reasonOf('KI')).toMatchObject({ reason: 'killed', exitCode: null });
    expect(reasonOf('SP')).toMatchObject({ reason: 'spawn' });
    expect(reasonOf('DI')).toMatchObject({ reason: 'dirty', exitCode: 0, dirty: ['a', 'b'], output: 'installed' });
    for (const id of ['TO', 'KI', 'SP', 'DI']) expect(h.orch.entry(id)).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(eventsOf(h, 'launch.prepared')).toEqual([]);
  });

  it('a throwing clean test fails that launch only; the other job is handled in the same tick', async () => {
    const { h, r } = harness(TWO);
    r.auto = () => OK;
    const seal = h.workspace.seal.bind(h.workspace);
    h.workspace.seal = async (l, opts) => {
      if (l.taskId === 'A' && !opts) throw new Error('git broke');
      return seal(l, opts);
    };
    await h.orch.tick();
    await h.orch.prepareStarted();
    await h.orch.prepareSettled();
    const a = latest(h, 'A');
    const b = latest(h, 'B');
    expect(eventsOf(h, 'launch.prepared', b.launchId)).toEqual([]);
    await expect(h.orch.tick()).resolves.toBeUndefined();
    expect(h.store.getLaunch(a.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
    expect(eventsOf(h, 'launch.prepareFailed', a.launchId)[0]!.payload).toMatchObject({ reason: 'dirty', error: expect.stringContaining('git broke') });
    expect(eventsOf(h, 'launch.prepared', b.launchId)).toHaveLength(1);
    expect(h.store.getLaunch(b.launchId)?.status).toBe('live');
  });

  it('cancel while the command runs: the next tick aborts it; once it ended the launch is ended as cancelled', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    expect(h.orch.cancel('A', 'not needed')).toEqual({ ok: true });
    await h.orch.tick();
    expect(r.calls[0]!.signal.aborted).toBe(true);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('preparing');
    r.calls[0]!.resolve({ code: null, timedOut: false, aborted: true, output: '' });
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(h.workspace.worktrees.has(l.launchId)).toBe(false);
    for (const kind of ['launch.prepareFailed', 'launch.live', 'launch.claimable']) expect(eventsOf(h, kind)).toEqual([]);
    expect(h.orch.prepareJobs.size).toBe(0);
  });

  it('a cascade reset while the command runs ends the launch as superseded', async () => {
    const { h, r } = harness(`nodes:
  - { id: D }
  - { id: T, deps: [D] }`);
    r.auto = (c) => (launchesOf(h, 'D').some((l) => l.worktree === c.cwd) ? OK : undefined);
    await h.orch.tick();
    await h.orch.prepareSettled();
    await h.orch.tick();
    await h.submit('D');
    await h.orch.settle();
    expect(h.statusOf('D')).toBe('done');
    expect(h.statusOf('T')).toBe('running');
    await h.orch.prepareStarted();
    const t = latest(h, 'T');
    const call = callFor(r, t)[0]!;
    expect(h.orch.reopen('D', { cascade: true })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('T')).toBe('unstarted');
    expect(call.signal.aborted).toBe(true);
    call.resolve({ code: null, timedOut: false, aborted: true, output: '' });
    await h.orch.prepareJobs.get(t.launchId)!.done;
    await h.orch.tick();
    expect(h.store.getLaunch(t.launchId)).toMatchObject({ status: 'ended', endReason: 'superseded' });
    expect(h.workspace.worktrees.has(t.launchId)).toBe(false);
    expect(eventsOf(h, 'launch.prepareFailed', t.launchId)).toEqual([]);
    expect(eventsOf(h, 'launch.live', t.launchId)).toEqual([]);
  });

  it('cancel between the applied success and the spawn: not spawned, then ended as cancelled', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await settlePrepareJobs(h.orch);
    expect(eventsOf(h, 'launch.prepared', l.launchId)).toHaveLength(1);
    expect(h.orch.prepareJobs.get(l.launchId)?.ready).toBe(true);
    h.orch.cancel('A', 'changed my mind');
    await spawnPreparedLaunches(h.orch);
    expect(eventsOf(h, 'launch.live')).toEqual([]);
    expect(spawned(h)).toBe(0);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('preparing');
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(h.workspace.worktrees.has(l.launchId)).toBe(false);
  });

  it('pause: a success waits to be spawned until the resume; in pull mode it is parked at once', async () => {
    const { h, r } = harness(ONE);
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    h.orch.pause();
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('preparing');
    expect(spawned(h)).toBe(0);
    for (let i = 0; i < 3; i++) await h.orch.tick();
    expect(eventsOf(h, 'launch.prepared', l.launchId)).toHaveLength(1);
    expect(spawned(h)).toBe(0);
    h.orch.resume();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('live');

    const pull = harness(ONE, {}, 'pull');
    await pull.h.orch.tick();
    await pull.h.orch.prepareStarted();
    const p = latest(pull.h, 'A');
    pull.h.orch.pause();
    pull.r.calls[0]!.resolve(OK);
    await pull.h.orch.prepareSettled();
    await pull.h.orch.tick();
    expect(pull.h.store.getLaunch(p.launchId)?.status).toBe('claimable');
  });

  it('hold after a gap: no command starts and nothing is spawned; a running command goes on and a success is applied', async () => {
    const gapAfterMs = 1_000;
    const gapHoldMs = 10_000;
    const { h, r } = harness(THREE, { health: { gapAfterMs, gapHoldMs } });
    // C is ready only for the ticks inside the hold.
    await h.orch.loadGraph();
    expect(h.orch.cancel('C', 'not yet')).toEqual({ ok: true });
    await h.orch.tick();
    await h.orch.prepareStarted();
    const a = latest(h, 'A');
    const b = latest(h, 'B');
    callFor(r, b)[0]!.resolve(OK);
    await h.orch.prepareJobs.get(b.launchId)!.done;
    expect(h.orch.reopen('C')).toMatchObject({ ok: true });
    h.sleep(2 * gapAfterMs);
    for (let i = 0; i < 3; i++) {
      await h.orch.tick();
      h.advance(gapAfterMs);
    }
    expect(h.orch.inHold()).toBe(true);
    expect(callFor(r, a)[0]!.signal.aborted).toBe(false);
    expect(eventsOf(h, 'launch.prepared', b.launchId)).toHaveLength(1);
    expect(eventsOf(h, 'launch.live')).toEqual([]);
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'C' })).toEqual([]);
    expect(h.store.listEvents({ kind: 'launch.prepareStarted', taskId: 'C' })).toEqual([]);

    h.advance(gapHoldMs);
    expect(h.orch.inHold()).toBe(false);
    await h.orch.tick();
    expect(h.store.getLaunch(b.launchId)?.status).toBe('live');
    expect(h.store.listEvents({ kind: 'launch.prepareStarted', taskId: 'C' })).toHaveLength(1);
    expect(h.store.getLaunch(a.launchId)?.status).toBe('preparing');
  });

  it('mixed mode: a parked launch spawned after the window runs the command again, as launching, and may fail then', async () => {
    const { h, r } = harness(ONE, { runner: { mode: 'mixed', claimWindowMs: 2_000 } }, 'mixed');
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('claimable');
    h.advance(2_500);
    await h.orch.tick();
    await h.orch.prepareStarted();
    expect(callFor(r, l)).toHaveLength(2);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('launching');
    expect(spawned(h)).toBe(0);
    r.calls[1]!.resolve(EXIT1);
    await h.orch.prepareSettled();
    await settlePrepareJobs(h.orch);
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
    expect(h.orch.entry('A')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
  });

  it('stop aborts the command and applies nothing; the next start relaunches and runs it again', async () => {
    const { h, r } = harness(ONE);
    r.resolveOnAbort = true;
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    await h.orch.stop();
    expect(r.calls[0]!.signal.aborted).toBe(true);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('preparing');
    expect(eventsOf(h, 'launch.prepareFailed')).toEqual([]);

    // A call after stop starts nothing.
    const started = eventsOf(h, 'launch.prepareStarted').length;
    expect(h.orch.startPrepareCommand(h.store.getLaunch(l.launchId)!)).toBe(true);
    expect(eventsOf(h, 'launch.prepareStarted')).toHaveLength(started);
    expect(r.calls).toHaveLength(1);

    // The next start: recovery revokes the launch and relaunches the same attempt without waiting for the command.
    const next = restart(h, {});
    await next.o.loadGraph();
    await recover(next.o);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('revoked');
    await next.o.prepareStarted();
    expect(next.r.calls).toHaveLength(1);
    const relaunched = latest(h, 'A');
    expect(relaunched.status).toBe('preparing');
    next.r.calls[0]!.resolve(OK);
    await next.o.prepareSettled();
    await next.o.tick();
    expect(h.store.getLaunch(relaunched.launchId)?.status).toBe('live');
    expect(h.runners['claude-code'].spawned.map((s) => s.launchId)).toEqual([relaunched.launchId]);
  });

  it('stop waits for a command that never ends for no longer than prepareStopWaitMs', async () => {
    const { h } = harness(ONE);
    await h.orch.tick();
    await h.orch.prepareStarted();
    h.orch.prepareStopWaitMs = 50;
    const t0 = Date.now();
    await h.orch.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(latest(h, 'A').status).toBe('preparing');
  });

  describe('recovery of parked launches', () => {
    async function parkedUnder(command: string | undefined): Promise<{ h: Harness; l: Launch }> {
      const { h, r } = harness(ONE, { prepareCommand: command }, 'pull');
      expect(h.orch.config.prepareCommand).toBe(command);
      await h.orch.tick();
      if (command !== undefined) {
        await h.orch.prepareStarted();
        r.calls[0]!.resolve(OK);
        await h.orch.prepareSettled();
        await h.orch.tick();
      }
      const l = latest(h, 'A');
      expect(l.status).toBe('claimable');
      return { h, l };
    }

    async function expectMadeAgain(h: Harness, l: Launch, prepareCommand: string): Promise<void> {
      const { o, r } = restart(h, { prepareCommand });
      await o.loadGraph();
      await recover(o);
      expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'notPrepared' });
      expect(o.entry('A')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
      expect(o.entry('A').carry?.priorFailure?.message).toContain('the prepare command had not run for it');
      expect(eventsOf(h, 'launch.reprepared')).toEqual([]);
      expect(r.calls).toHaveLength(0);
      await o.tick();
      const next = latest(h, 'A');
      expect(next.launchId).not.toBe(l.launchId);
      expect(next.status).toBe('preparing');
      await o.prepareStarted();
      expect(r.calls).toHaveLength(1);
    }

    it('(a) parked before the command was set', async () => {
      const { h, l } = await parkedUnder(undefined);
      expect(eventsOf(h, 'launch.prepared')).toEqual([]);
      await expectMadeAgain(h, l, 'install');
      expect(eventsOf(h, 'launch.ended', l.launchId)[0]!.payload).toMatchObject({ notPrepared: 'neverPrepared' });
    });

    it('(b) parked under another command', async () => {
      const { h, l } = await parkedUnder('install');
      await expectMadeAgain(h, l, 'install2');
      expect(eventsOf(h, 'launch.ended', l.launchId)[0]!.payload).toMatchObject({ notPrepared: 'otherCommand' });
    });

    it('(c) parked under the command, worktree lost', async () => {
      const { h, l } = await parkedUnder('install');
      h.workspace.worktrees.delete(l.launchId);
      await expectMadeAgain(h, l, 'install');
      expect(eventsOf(h, 'launch.ended', l.launchId)[0]!.payload).toMatchObject({ notPrepared: 'worktreeLost' });
    });

    it('(d) parked under the command with its worktree: stays parked, the command does not run', async () => {
      const { h, l } = await parkedUnder('install');
      const { o, r } = restart(h, { prepareCommand: 'install' });
      await o.loadGraph();
      await recover(o);
      await o.tick();
      expect(h.store.getLaunch(l.launchId)?.status).toBe('claimable');
      expect(r.calls).toHaveLength(0);
      expect(o.prepareJobs.size).toBe(0);
    });
  });
});
