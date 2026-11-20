import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { type PrepareRunResult, settlePrepareJobs } from '../../src/launch/prepare.js';
import type { StatusReport } from '../../src/loop/orchestrator.js';
import { strongestVerdict, WORK_VERDICTS, type WorkCounts, type WorkRunFacts, workVerdict } from '../../src/loop/verdict.js';
import { digestOf } from '../../src/operator/routes.js';
import { RUNNER_KINDS } from '../../src/runner/selection.js';
// @ts-expect-error a plain .mjs host script without type declarations
import { stopVerdict } from '../../hosts/codex/bin/work.mjs';
import { makeHarness, type Harness } from './harness.js';

/**
 * The work verdict per runner kind (GH-192). See specs/operator-control "Work verdict" and
 * "Status report: work verdict per kind".
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const RUN: WorkRunFacts = { finished: false, stalled: false, paused: false, verifying: 0, openQuestions: 0, milestonesAwaitingReview: 0 };
const NONE: WorkCounts = { claimable: 0, preparing: 0, working: 0 };
const IDLE = { verdict: 'idle', claimable: 0, preparing: 0, working: 0 };

function harness(graph: string, config: ConfigInput = {}): Harness {
  const h = makeHarness({
    graph,
    config: {
      leaseTtlMs: 60_000,
      ...config,
      runner: { mode: 'pull', claimWindowMs: 10 * 60_000, ...(config.runner ?? {}) },
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: false, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  return h;
}

/**
 * Criterion 6: stopVerdict of orchestrator-work, on the same status without workByKind, stops exactly when the verdict
 * is finished, stalled or human, and is quiet exactly when it is idle. `stale` names kinds with a live launch row whose
 * task no longer runs or waits on it (the documented exception: stopVerdict still counts the row as live).
 */
function expectParity(s: StatusReport, stale: readonly string[] = []): void {
  const { workByKind, ...rest } = s;
  for (const kind of RUNNER_KINDS) {
    const verdict = workByKind[kind].verdict;
    const v = stopVerdict(rest, undefined, 0, 120_000, kind) as { stop: boolean; quiet?: boolean };
    if (stale.includes(kind)) {
      expect(v, `${kind}: the stale row counts as live`).toEqual({ stop: false, quiet: false });
      continue;
    }
    expect(v.stop, `${kind} ${verdict} stop`).toBe(verdict === 'finished' || verdict === 'stalled' || verdict === 'human');
    expect(v.quiet === true, `${kind} ${verdict} quiet`).toBe(verdict === 'idle');
  }
}

/** The verdict and its parity, checked on the status and the digest together. */
function look(h: Harness, stale: readonly string[] = []): StatusReport['workByKind'] {
  const s = h.orch.status();
  expectParity(s, stale);
  expect(digestOf(h.orch)['workByKind']).toEqual(s.workByKind);
  return s.workByKind;
}

async function claim(h: Harness, workerId: string, runner?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return h.orch.claim({ workerId, ...(runner ? { runner } : {}) });
}

describe('workVerdict: the rule as a table (criterion 1)', () => {
  it.each([
    ['finished whatever else holds', { ...RUN, finished: true, stalled: true, paused: true, verifying: 1, openQuestions: 1 }, { claimable: 1, preparing: 1, working: 1 }, 'finished'],
    ['stalled when stalled and not finished', { ...RUN, stalled: true, paused: true, openQuestions: 1 }, { claimable: 1, preparing: 0, working: 0 }, 'stalled'],
    ['paused when paused with a launch claimable', { ...RUN, paused: true }, { claimable: 1, preparing: 0, working: 0 }, 'paused'],
    ['claim with claimable 1', RUN, { claimable: 1, preparing: 0, working: 0 }, 'claim'],
    ['claim over standby and human', { ...RUN, verifying: 1, openQuestions: 1 }, { claimable: 1, preparing: 1, working: 1 }, 'claim'],
    ['standby with only preparing 1', RUN, { claimable: 0, preparing: 1, working: 0 }, 'standby'],
    ['standby with only working 1', RUN, { claimable: 0, preparing: 0, working: 1 }, 'standby'],
    ['standby with only one task under verification', { ...RUN, verifying: 1 }, NONE, 'standby'],
    ['standby over human', { ...RUN, openQuestions: 1 }, { claimable: 0, preparing: 0, working: 1 }, 'standby'],
    ['human with one open question', { ...RUN, openQuestions: 1 }, NONE, 'human'],
    ['human with one milestone awaiting review', { ...RUN, milestonesAwaitingReview: 1 }, NONE, 'human'],
    ['idle otherwise', RUN, NONE, 'idle'],
  ] as const)('%s', (_name, run, kind, verdict) => {
    expect(workVerdict(run, kind)).toBe(verdict);
    // Criterion 6 on the same state, as a status body that stopVerdict reads.
    const body = {
      finished: run.finished,
      stalled: run.stalled,
      paused: run.paused,
      claimableByKind: { codex: kind.claimable },
      preparingByKind: { codex: kind.preparing },
      liveLaunches: kind.working ? [{ runner: 'codex' }] : [],
      verifying: run.verifying ? ['V'] : [],
      openQuestions: run.openQuestions ? ['Q'] : [],
      awaitingReview: [...(run.verifying ? ['V'] : []), ...(run.milestonesAwaitingReview ? ['M'] : [])],
    };
    const v = stopVerdict(body, undefined, 0, 120_000, 'codex') as { stop: boolean; quiet?: boolean };
    expect(v.stop).toBe(verdict === 'finished' || verdict === 'stalled' || verdict === 'human');
    expect(v.quiet === true).toBe(verdict === 'idle');
  });
});

describe('the exported order (criterion 3)', () => {
  it('WORK_VERDICTS and strongestVerdict', () => {
    expect(WORK_VERDICTS).toEqual(['finished', 'stalled', 'paused', 'claim', 'standby', 'human', 'idle']);
    expect(strongestVerdict(['human', 'claim', 'idle'])).toBe('claim');
    expect(strongestVerdict([])).toBe('idle');
    expect(strongestVerdict(['nonsense', 'standby'])).toBe('standby');
    expect(strongestVerdict(['nonsense'])).toBe('idle');
    expect(strongestVerdict(['idle', 'finished'])).toBe('finished');
  });
});

const TWO = `nodes:
  - { id: A, deps: [] }
  - { id: C, deps: [], runner: codex }`;

describe('status().workByKind (criterion 2)', () => {
  it('one claude-code and one codex task parked: claim for both, idle for opencode; claimed: standby with working 1', async () => {
    const h = harness(TWO);
    await h.orch.tick();
    expect(look(h)).toEqual({
      'claude-code': { verdict: 'claim', claimable: 1, preparing: 0, working: 0 },
      codex: { verdict: 'claim', claimable: 1, preparing: 0, working: 0 },
      opencode: { verdict: 'idle', claimable: 0, preparing: 0, working: 0 },
    });
    expect((await claim(h, 'w1', 'claude-code')).status).toBe(200);
    const w = look(h);
    expect(w['claude-code']).toEqual({ verdict: 'standby', claimable: 0, preparing: 0, working: 1 });
    expect(w.codex).toEqual({ verdict: 'claim', claimable: 1, preparing: 0, working: 0 });
    expect(w.opencode).toEqual(IDLE);
  });
});

describe('working launches (criterion 4)', () => {
  it('a task waiting on a question keeps its kind at standby; once blocked by the wait limit and its launch ended, human', async () => {
    const h = harness(TWO, { maxWaitMs: 5_000 });
    await h.orch.tick();
    expect((await claim(h, 'w1', 'claude-code')).status).toBe(200);
    void h.block('A', 'which way?');
    await h.orch.settle();
    expect(h.statusOf('A')).toBe('waiting');
    let w = look(h);
    expect(w['claude-code']).toEqual({ verdict: 'standby', claimable: 0, preparing: 0, working: 1 });
    expect(h.orch.status().openQuestions).toEqual(['A']);

    h.advance(6_000);
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('blocked');
    // The launch row stays live until the next tick's reconcile: the documented parity exception.
    expect(h.store.listLaunches({ taskId: 'A', status: 'live' })).toHaveLength(1);
    w = look(h, ['claude-code']);
    expect(w['claude-code']).toEqual({ verdict: 'human', claimable: 0, preparing: 0, working: 0 });

    await h.orch.tick();
    expect(h.store.listLaunches({ taskId: 'A', status: 'live' })).toHaveLength(0);
    const s = h.orch.status();
    expect(s.stalled).toBe(false);
    w = look(h);
    expect(w['claude-code']).toEqual({ verdict: 'human', claimable: 0, preparing: 0, working: 0 });
    expect(w.codex).toEqual({ verdict: 'claim', claimable: 1, preparing: 0, working: 0 });
    expect(w.opencode).toMatchObject({ verdict: 'human' });
  });

  it('with the blocked task alone in the graph the verdict is stalled', async () => {
    const h = harness(`nodes:\n  - { id: A, deps: [] }`, { maxWaitMs: 5_000 });
    await h.orch.tick();
    expect((await claim(h, 'w1')).status).toBe(200);
    void h.block('A', 'which way?');
    await h.orch.settle();
    h.advance(6_000);
    await h.orch.tick();
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('blocked');
    const w = look(h);
    for (const kind of RUNNER_KINDS) expect(w[kind].verdict).toBe('stalled');
  });

  it('a live launch whose task has submitted is not counted in working', async () => {
    const h = harness(TWO);
    await h.orch.tick();
    expect((await claim(h, 'w1', 'claude-code')).status).toBe(200);
    expect((await h.submit('A')).status).toBe(200);
    expect(h.statusOf('A')).toBe('submitted');
    expect(h.store.listLaunches({ taskId: 'A', status: 'live' })).toHaveLength(1);
    const w = look(h);
    expect(w['claude-code']).toEqual({ verdict: 'standby', claimable: 0, preparing: 0, working: 0 });
  });

  it('a claimed launch whose worker is gone counts until its lease expiry ends it', async () => {
    const h = harness(TWO);
    await h.orch.tick();
    const c = await claim(h, 'w1', 'claude-code');
    expect(c.status).toBe(200);
    h.advance(30_000);
    await h.orch.tick();
    expect(look(h)['claude-code']).toMatchObject({ working: 1, verdict: 'standby' });
    h.advance(31_000);
    await h.orch.tick();
    expect(h.store.getLaunch(String(c.body['launchId']))?.status).toBe('ended');
    expect(look(h)['claude-code']).toMatchObject({ working: 0 });
  });
});

describe('run-level classes (criterion 5)', () => {
  it('with a task under verification every kind is standby', async () => {
    const h = harness(`nodes:\n  - { id: A, deps: [] }`);
    await h.orch.tick();
    expect((await claim(h, 'w1')).status).toBe(200);
    await h.submit('A');
    expect(h.orch.status().verifying).toEqual(['A']);
    const w = look(h);
    for (const kind of RUNNER_KINDS) expect(w[kind]).toMatchObject({ verdict: 'standby', working: 0 });
  });

  it('with a gated milestone awaiting review and nothing else every kind is human', async () => {
    const h = harness(`nodes:\n  - { id: A, deps: [] }\n  - { id: M, kind: milestone, gated: true, deps: [A] }`);
    await h.orch.tick();
    expect((await claim(h, 'w1')).status).toBe(200);
    await h.submit('A');
    for (let i = 0; i < 5 && h.statusOf('M') !== 'submitted'; i++) {
      await h.orch.settle();
      await h.orch.tick();
    }
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('done');
    expect(h.orch.status().awaitingReview).toEqual(['M']);
    expect(h.store.listLaunches({ status: 'live' })).toHaveLength(0);
    const w = look(h);
    for (const kind of RUNNER_KINDS) expect(w[kind]).toEqual({ ...IDLE, verdict: 'human' });
  });

  it('a paused run with a parked launch gives paused for its kind while claim() answers 404 with paused: true', async () => {
    const h = harness(TWO);
    await h.orch.tick();
    h.orch.pause();
    const w = look(h);
    expect(w['claude-code']).toEqual({ verdict: 'paused', claimable: 1, preparing: 0, working: 0 });
    for (const kind of RUNNER_KINDS) expect(w[kind].verdict).toBe('paused');
    const c = await claim(h, 'w1', 'claude-code');
    expect(c.status).toBe(404);
    expect(c.body).toMatchObject({ paused: true });
  });

  it('a launch whose prepare command runs gives standby with preparing 1, and so does a task that waits for a prepare retry', async () => {
    const calls: Array<{ cwd: string; resolve(r: PrepareRunResult): void }> = [];
    const h = harness(`nodes:\n  - { id: C, deps: [], runner: codex }`, { prepareCommand: 'install' });
    h.orch.prepareRunner = (_command, cwd) => new Promise<PrepareRunResult>((resolve) => calls.push({ cwd, resolve }));
    await h.orch.tick();
    await h.orch.prepareStarted();
    let w = look(h);
    expect(w.codex).toEqual({ verdict: 'standby', claimable: 0, preparing: 1, working: 0 });
    expect(w['claude-code']).toEqual(IDLE);

    const [l] = h.store.listLaunches({ taskId: 'C' });
    calls.at(-1)!.resolve({ code: 1, timedOut: false, output: 'boom' });
    await h.orch.prepareJobs.get(l!.launchId)!.done;
    await settlePrepareJobs(h.orch);
    expect(h.store.getLaunch(l!.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
    expect(h.orch.status().prepareRetry.map((r) => r.taskId)).toEqual(['C']);
    w = look(h);
    expect(w.codex).toEqual({ verdict: 'standby', claimable: 0, preparing: 1, working: 0 });
  });
});
