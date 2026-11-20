import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, remoteVerifierError, type ConfigInput } from '../../src/config.js';
import { recover } from '../../src/launch/recovery.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierOutcome } from '../../src/verify/job.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * `verifier.mode` (GH-32): the configuration key and its start refusal, the jobs recovery keeps under `remote`, the
 * resume of a kept job in the single slot, and the cancel of an offered job. The fake backend stands in for the
 * remote one: these tests set the claim fields by hand. See specs/verifier-pool and specs/crash-recovery.
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

type Mode = 'local' | 'remote';
const FIELDS = ['offer', 'verifier', 'token', 'result'] as const;

function harness(mode: Mode, ids: string[], config: ConfigInput = {}): Harness {
  const h = makeHarness({
    graph: `nodes:\n${ids.map((id) => `  - { id: ${id} }`).join('\n')}`,
    config: {
      capacity: 8,
      maxWaiting: 8,
      ...config,
      verifier: { mode },
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0 },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 },
    },
  });
  open.push(h);
  return h;
}

const jobOf = (h: Harness, taskId: string): VerifierJob => {
  const [j] = h.store.listJobs({ taskId });
  if (!j) throw new Error(`no job for ${taskId}`);
  return j;
};

/** Admit every task and submit each one, with no tick after the submits: every job is `queued` and no run holds one. */
async function submitted(h: Harness, ids: string[]): Promise<void> {
  await h.orch.tick();
  for (const id of ids) expect((await h.submit(id)).status).toBe(200);
  for (const id of ids) expect(jobOf(h, id).status).toBe('queued');
}

/** A fresh orchestrator over the same store under `mode`, with recovery run and no tick. */
async function restart(h: Harness, mode: Mode): Promise<Orchestrator> {
  const o2 = new Orchestrator({ store: h.store, config: { ...h.orch.config, verifier: { mode } }, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
  await o2.loadGraph();
  await recover(o2);
  return o2;
}

async function idle(o: Orchestrator): Promise<void> {
  for (let i = 0; i < 100 && o.verifierBusy(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(o.verifierBusy()).toBe(false);
}

const offer = (h: Harness) => ({ at: h.now.value, checkCommand: 'exit 9' });
const live = (h: Harness) => ({ id: 'v1', claimedAt: h.now.value, expiresAt: h.now.value + 60_000 });
const expired = (h: Harness) => ({ id: 'v1', claimedAt: h.now.value - 120_000, expiresAt: h.now.value - 60_000 });
const result = (h: Harness) => ({ outcome: 'verified' as const, rebasedSha: 'a'.repeat(40), output: '', conflictFiles: [], verifierId: 'v1', at: h.now.value });

function expectNoClaim(job: VerifierJob): void {
  for (const f of FIELDS) expect(job[f], f).toBeUndefined();
}

describe('verifier.mode configuration', () => {
  it('defaults to local, accepts remote, and refuses any other value naming the key', () => {
    expect(defaultConfig().verifier.mode).toBe('local');
    expect(defaultConfig({ verifier: { mode: 'remote' } }).verifier.mode).toBe('remote');
    expect(() => defaultConfig({ verifier: { mode: 'elsewhere' as 'local' } })).toThrow(/verifier\.mode must be one of local, remote/);
  });

  it('remoteVerifierError: only remote with local access is refused, naming runner.access', () => {
    expect(remoteVerifierError(defaultConfig())).toBeUndefined();
    expect(remoteVerifierError(defaultConfig({ verifier: { mode: 'remote' }, runner: { access: 'local' } }))).toBe('verifier.mode remote refused: runner.access must be remote');
    expect(remoteVerifierError(defaultConfig({ verifier: { mode: 'remote' }, runner: { access: 'remote' } }))).toBeUndefined();
  });

  it('start() under remote with local access rejects before the graph is loaded', async () => {
    const h = harness('remote', ['A']);
    await expect(h.orch.start()).rejects.toThrow('verifier.mode remote refused: runner.access must be remote');
    expect(h.orch.hasGraph()).toBe(false);
  });
});

describe('recovery of offered jobs', () => {
  it('remote: an offered checking job with a live lease or a stored result is kept; every other in-flight job is queued without the claim fields', async () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const h = harness('remote', ids);
    await submitted(h, ids);
    h.store.updateJob(jobOf(h, 'A').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tA', verifier: live(h) });
    h.store.updateJob(jobOf(h, 'B').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tB', verifier: expired(h), result: result(h) });
    h.store.updateJob(jobOf(h, 'C').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tC', verifier: expired(h) });
    h.store.updateJob(jobOf(h, 'D').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h) });
    h.store.updateJob(jobOf(h, 'E').jobId, { status: 'verified', expectedHead: 'head0', verifiedSha: 'v', offer: offer(h), token: 'tE', verifier: live(h), result: result(h) });
    const before = { A: jobOf(h, 'A'), B: jobOf(h, 'B') };
    await restart(h, 'remote');
    expect(jobOf(h, 'A')).toEqual(before.A);
    expect(jobOf(h, 'B')).toEqual(before.B);
    for (const id of ['C', 'D', 'E']) {
      const j = jobOf(h, id);
      expect(j.status, id).toBe('queued');
      expectNoClaim(j);
    }
  });

  it('local: an offered checking job with a live lease is queued without the claim fields', async () => {
    const h = harness('local', ['A']);
    await submitted(h, ['A']);
    h.store.updateJob(jobOf(h, 'A').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tA', verifier: live(h), result: result(h) });
    await restart(h, 'local');
    const j = jobOf(h, 'A');
    expect(j.status).toBe('queued');
    expectNoClaim(j);
  });
});

describe('the single slot under remote', () => {
  it('the first tick after a restart runs a kept offered job before an older queued job', async () => {
    const h = harness('remote', ['A', 'B']);
    await submitted(h, ['A', 'B']);
    // A's job is the older one and stays queued; B's is offered and claimed.
    h.store.updateJob(jobOf(h, 'B').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tB', verifier: live(h) });
    const o2 = await restart(h, 'remote');
    expect(jobOf(h, 'A').status).toBe('queued');
    expect(jobOf(h, 'B').status).toBe('checking');
    await o2.tick();
    await idle(o2);
    expect(h.verifier.runs.map((j) => j.taskId)[0]).toBe('B');
    expect(jobOf(h, 'B').status).toBe('published');
    expectNoClaim(jobOf(h, 'B'));
  });

  const outcomes: Array<[string, VerifierOutcome, VerifierJob['status']]> = [
    ['published', { kind: 'published', publishedSha: 'pub-1', verifiedSha: 'ver-1' }, 'published'],
    ['failed', { kind: 'failed', reason: { kind: 'checkFailed', message: 'check exited 1', output: 'boom' } }, 'failed'],
    ['conflict', { kind: 'conflict', files: ['x.txt'], since: [] }, 'conflict'],
    ['requeue', { kind: 'requeue', reason: 'lease lost' }, 'queued'],
    ['requeue with retry', { kind: 'requeue', reason: 'refused', retry: { kind: 'refused', message: 'refused' } }, 'queued'],
  ];
  for (const [name, outcome, status] of outcomes) {
    it(`a kept job's ${name} outcome is written without offer, verifier, token and result`, async () => {
      const h = harness('remote', ['A']);
      await submitted(h, ['A']);
      h.verifier.on('A', outcome);
      h.store.updateJob(jobOf(h, 'A').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tA', verifier: live(h), result: result(h) });
      const o2 = await restart(h, 'remote');
      await o2.tick();
      await idle(o2);
      expect(h.verifier.runs).toHaveLength(1);
      const j = jobOf(h, 'A');
      expect(j.status).toBe(status);
      expectNoClaim(j);
    });
  }
});

describe('cancel and offered jobs', () => {
  it('remote: a cancel drops an offered job without a result and keeps one that holds a result', async () => {
    const h = harness('remote', ['A', 'B']);
    await submitted(h, ['A', 'B']);
    h.store.updateJob(jobOf(h, 'A').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h) });
    h.store.updateJob(jobOf(h, 'B').jobId, { status: 'checking', expectedHead: 'head0', offer: offer(h), token: 'tB', verifier: live(h), result: result(h) });
    expect(h.orch.cancel('A', 'no longer needed')).toEqual({ ok: true });
    expect(h.orch.cancel('B', 'no longer needed')).toEqual({ ok: true });
    const a = jobOf(h, 'A');
    expect(a).toMatchObject({ status: 'dropped', applied: true });
    expect(a.offer).toEqual(offer(h));
    const b = jobOf(h, 'B');
    expect(b).toMatchObject({ status: 'checking', applied: false });
    expect(b.result).toEqual(result(h));
  });

  it('local: a cancel leaves a checking job without an offer and drops a queued job', async () => {
    const h = harness('local', ['A', 'B']);
    await submitted(h, ['A', 'B']);
    h.store.updateJob(jobOf(h, 'A').jobId, { status: 'checking', expectedHead: 'head0' });
    expect(h.orch.cancel('A', 'no longer needed')).toEqual({ ok: true });
    expect(h.orch.cancel('B', 'no longer needed')).toEqual({ ok: true });
    expect(jobOf(h, 'A')).toMatchObject({ status: 'checking', applied: false });
    expect(jobOf(h, 'B')).toMatchObject({ status: 'dropped', applied: true });
  });
});
