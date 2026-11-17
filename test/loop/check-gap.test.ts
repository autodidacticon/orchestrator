import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { FakeOutcome } from '../../src/verify/fake.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * A failed check whose run overlapped a gap in the daemon's clock is put back to `queued` once, without spending an
 * attempt (ORC-119). `advance` is time the daemon ran; `sleep` is a gap.
 * See specs/integration-pipeline "Failed check across a gap".
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const MIN = 60_000;
const HOLD = MIN; // the default health.gapHoldMs
const SLEEP = 10 * MIN;

function harness(config: ConfigInput = {}): Harness {
  const h = makeHarness({
    graph: `nodes:
  - { id: A }`,
    config: {
      ...config,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  return h;
}

const jobOf = (h: Harness): VerifierJob => {
  const [j] = h.store.listJobs({ taskId: 'A' });
  if (!j) throw new Error('no job for A');
  return j;
};
const requeued = (h: Harness) => h.store.listEvents({ kind: 'verify.requeued' });
/** The failure was charged: one submitted → failed transition by verificationFailed, and one attempt spent (a task with attempts left is relaunched in the same tick). */
function expectCharged(h: Harness): void {
  const failed = h.store.listEvents({ kind: 'transition', taskId: 'A' }).filter((e) => e.payload?.['trigger'] === 'verificationFailed');
  expect(failed.map((e) => [e.payload?.['from'], e.payload?.['to']])).toEqual([['submitted', 'failed']]);
  expect(h.orch.entry('A').attempts).toBe(1);
}
const gapRequeued = (h: Harness) => requeued(h).filter((e) => e.payload?.['gap'] !== undefined);

/** A scripted run that marks the job rebased, lets the clock move by `move`, then ends as `end` says. */
function during(h: Harness, move: (ms: number) => void, ms: number, end: 'checkTimeout' | 'checkFailed' | 'throw' | 'conflict'): FakeOutcome {
  return (job) => {
    h.store.updateJob(job.jobId, { rebasedSha: 'rebased-1' });
    move(ms);
    if (end === 'throw') throw new Error('check broke');
    if (end === 'conflict') return { kind: 'conflict', files: ['x.txt'], since: [] };
    return { kind: 'failed', reason: { kind: end, message: `check ${end}` } };
  };
}

/** Launch A, submit it, and let the verifier run once and its outcome be applied. */
async function submitAndVerify(h: Harness): Promise<void> {
  await h.orch.tick();
  expect((await h.submit('A')).status).toBe(200);
  await h.orch.settle(3);
  await h.orch.tick();
}

describe('a failed check across a gap is run again once', () => {
  for (const end of ['checkTimeout', 'checkFailed', 'throw'] as const) {
    const failureKind = end === 'throw' ? 'checkFailed' : end;
    it(`${end}: the job goes back to queued, uncharged, with one verify.requeued naming the gap`, async () => {
      const h = harness();
      h.verifier.on('A', during(h, h.sleep, SLEEP, end));
      await submitAndVerify(h);
      expect(h.verifier.runs).toHaveLength(1);
      expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'submitted' } });
      const job = jobOf(h);
      expect(job).toMatchObject({ status: 'queued', gapRequeues: 1, applied: false });
      expect(job.rebasedSha).toBeUndefined();
      expect(job.expectedHead).toBeUndefined();
      const events = requeued(h);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ jobId: job.jobId, gap: { failureKind } });
      expect(String(events[0]!.payload?.['reason'])).toContain(failureKind);
      expect(String(events[0]!.payload?.['reason'])).toContain('gap');
      const gapMs = Number((events[0]!.payload?.['gap'] as { gapMs: number }).gapMs);
      expect(gapMs).toBeGreaterThan(0);
      expect(gapMs).toBe(SLEEP);
      expect(h.store.listEvents({ kind: 'transition' }).filter((e) => e.payload?.['trigger'] === 'verificationFailed')).toEqual([]);
    });
  }

  it('once only: a second failure of the same job across a second gap is charged', async () => {
    const h = harness();
    h.verifier.on('A', during(h, h.sleep, SLEEP, 'checkTimeout'), during(h, h.sleep, SLEEP, 'checkTimeout'));
    await submitAndVerify(h);
    expect(jobOf(h)).toMatchObject({ status: 'queued', gapRequeues: 1 });
    h.advance(HOLD + 1);
    await h.orch.settle(3);
    await h.orch.tick();
    expect(h.verifier.runs).toHaveLength(2);
    expectCharged(h);
    expect(jobOf(h)).toMatchObject({ status: 'failed', failureKind: 'checkTimeout', gapRequeues: 1 });
    expect(gapRequeued(h)).toHaveLength(1);
  });

  it('the re-run waits for the hold after the gap', async () => {
    const h = harness({ health: { gapHoldMs: HOLD } });
    h.verifier.on('A', during(h, h.sleep, SLEEP, 'checkTimeout'));
    await submitAndVerify(h);
    expect(jobOf(h).status).toBe('queued');
    for (let i = 0; i < 3; i++) {
      h.advance(HOLD / 4);
      await h.orch.tick();
      expect(jobOf(h).status).toBe('queued');
      expect(h.verifier.runs).toHaveLength(1);
    }
    h.advance(HOLD / 4 + 1);
    await h.orch.tick();
    expect(h.verifier.runs).toHaveLength(2);
    await h.orch.settle(3);
    expect(h.orch.entry('A').status.kind).toBe('done');
  });
});

describe('failures the rule does not cover are charged as today', () => {
  it('no gap: a failed check fails the task and appends no verify.requeued', async () => {
    const h = harness();
    h.verifier.on('A', during(h, h.advance, SLEEP, 'checkTimeout'));
    await submitAndVerify(h);
    expectCharged(h);
    expect(jobOf(h)).toMatchObject({ status: 'failed', failureKind: 'checkTimeout' });
    expect(jobOf(h).gapRequeues).toBeUndefined();
    expect(requeued(h)).toEqual([]);
  });

  it('a gap that ended before the run began does not count', async () => {
    const h = harness();
    h.verifier.on('A', during(h, h.advance, MIN, 'checkFailed'));
    await h.orch.tick();
    expect((await h.submit('A')).status).toBe(200);
    // The gap falls between the job being queued and its run's start.
    h.sleep(SLEEP);
    await h.orch.tick();
    expect(jobOf(h).status).toBe('queued');
    expect(h.store.listEvents({ kind: 'daemon.gap' })).toHaveLength(1);
    expect(h.verifier.runs).toHaveLength(0); // held after the gap
    h.advance(HOLD + 1);
    await h.orch.settle(3);
    await h.orch.tick();
    expect(h.verifier.runs).toHaveLength(1);
    expectCharged(h);
    expect(requeued(h)).toEqual([]);
  });

  it('with health.gapAfterMs 0 a failure after a one-step jump of the clock is charged', async () => {
    const h = harness({ health: { gapAfterMs: 0 } });
    h.verifier.on('A', during(h, h.sleep, SLEEP, 'checkTimeout'));
    await submitAndVerify(h);
    expectCharged(h);
    expect(requeued(h)).toEqual([]);
    expect(h.store.listEvents({ kind: 'daemon.gap' })).toEqual([]);
  });

  it('a conflict after a gap is handled as today', async () => {
    const h = harness();
    h.verifier.on('A', during(h, h.sleep, SLEEP, 'conflict'));
    await submitAndVerify(h);
    expect(jobOf(h)).toMatchObject({ status: 'conflict', conflictFiles: ['x.txt'] });
    expect(jobOf(h).gapRequeues).toBeUndefined();
    expect(requeued(h)).toEqual([]);
    expect(h.orch.entry('A').attempts).toBe(0);
  });

  it('a failure kind other than checkFailed or checkTimeout (integrationCapExceeded) is not re-run across a gap', async () => {
    const h = harness();
    h.verifier.on('A', () => {
      h.sleep(SLEEP);
      return { kind: 'failed', reason: { kind: 'integrationCapExceeded', message: 'over the cap' } };
    });
    await submitAndVerify(h);
    expectCharged(h);
    expect(requeued(h)).toEqual([]);
  });
});
