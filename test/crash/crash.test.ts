import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRASH_POINTS } from '../../src/crash.js';
import { runCli } from '../../src/operator/cli.js';
import { gitIn } from '../slice/harness.js';
import { checkInvariants, CRASH_EXIT_CODE, setupCrashRun } from './harness.js';

const EXPECTED_STATUS = { done: ['T1', 'T2', 'T3', 'T4', 'T5'], submitted: ['MVP'] };
/** One row per derivable transition, whatever was retried: in progress once and done once per task; the parent in progress once plus its review comment. */
const EXPECTED_OUTBOX = {
  T1: ['inProgress', 'done'], T2: ['inProgress', 'done'], T3: ['inProgress', 'done'], T4: ['inProgress', 'done'], T5: ['inProgress', 'done'],
  MVP: ['inProgress', 'comment'],
};

async function assertConverged(run: Awaited<ReturnType<typeof setupCrashRun>>, label: string) {
  const inv = await checkInvariants(run);
  const ctx = `[${label}] ${JSON.stringify(inv)}\n${readFileSync(run.daemonLog, 'utf8').slice(-3000)}`;
  expect(inv.trailerCommitsPerTask, ctx).toEqual({ T1: 1, T2: 1, T3: 1, T4: 1, T5: 1 });
  expect(inv.foreign, ctx).toEqual([]);
  expect(inv.worktrees, ctx).toEqual([]);
  expect(inv.tempDirs, ctx).toEqual([]);
  expect(inv.liveLaunches, ctx).toBe(0);
  expect(inv.pidOverlaps, ctx).toEqual([]);
  expect(inv.alivePids, ctx).toEqual([]);
  expect(inv.byStatus, ctx).toEqual(EXPECTED_STATUS);
  expect(inv.outboxSummary, ctx).toEqual(EXPECTED_OUTBOX);
  expect(inv.outboxOrphans, ctx).toEqual([]);
}

describe('crash suite', () => {
  it('uninterrupted run converges', async () => {
    const run = await setupCrashRun();
    try {
      const child = run.start();
      await run.waitTerminal();
      await run.stop(child);
      await assertConverged(run, 'no-crash');
    } finally {
      run.cleanup();
    }
  }, 120_000);

  const PULL_ONLY = new Set(['launch.afterClaimable', 'claim.afterRecord', 'cascade.afterPlan']);
  it.each(CRASH_POINTS.filter((p) => !PULL_ONLY.has(p)).map((p) => [p] as const))('crash at %s then restart converges', async (point) => {
    const run = await setupCrashRun();
    try {
      const crashing = run.start({ ORCH_CRASH_AT: point });
      const code = await run.waitExit(crashing, 60_000);
      expect(code, `daemon did not crash at ${point}; log:\n${readFileSync(run.daemonLog, 'utf8').slice(-2000)}`).toBe(CRASH_EXIT_CODE);
      const resumed = run.start();
      await run.waitTerminal(90_000);
      await run.stop(resumed);
      // Give killed orphans a moment to disappear before checking pids.
      await new Promise((r) => setTimeout(r, 300));
      await assertConverged(run, point);
    } finally {
      run.cleanup();
    }
  }, 240_000);
});

/** After a cascade reopen of T1: T1 published twice, T2 once (its first launch was reaped), MVP reviewed at version 2. */
const CASCADE_STATUS = { done: ['T1', 'T2'], submitted: ['MVP'] };
const CASCADE_TRAILERS = { T1: 2, T2: 1 };
const CASCADE_OUTBOX = { T1: ['inProgress', 'done', 'inProgress', 'done'], T2: ['inProgress', 'done'], MVP: ['inProgress', 'comment', 'comment'] };

async function runCascadeScenario(point?: string): Promise<void> {
  const run = await setupCrashRun({ scenario: 'cascade' });
  try {
    const child = run.start();
    await run.waitUntil(() => {
      const e = run.entries();
      return e.get('T1')?.status.kind === 'done' && e.get('MVP')?.status.kind === 'submitted' && e.get('T2')?.status.kind === 'running';
    });
    const v1 = run.entries().get('MVP')!;
    if (point) run.armCrash(point);
    try {
      await runCli(['reopen', 'T1', '--cascade', '--url', run.url()]);
    } catch {
      /* the daemon may die inside the request */
    }
    let resumed = child;
    if (point) {
      const code = await run.waitExit(child, 60_000);
      expect(code, `daemon did not crash at ${point}; log:\n${readFileSync(run.daemonLog, 'utf8').slice(-2000)}`).toBe(CRASH_EXIT_CODE);
      run.disarmCrash();
      resumed = run.start();
    }
    await run.waitTerminal(120_000);
    await run.stop(resumed);
    await new Promise((r) => setTimeout(r, 300));
    const inv = await checkInvariants(run);
    const ctx = `[cascade ${point ?? 'no-crash'}] ${JSON.stringify(inv)}\n${readFileSync(run.daemonLog, 'utf8').slice(-3000)}`;
    expect(inv.trailerCommitsPerTask, ctx).toEqual(CASCADE_TRAILERS);
    expect(inv.foreign, ctx).toEqual([]);
    expect(inv.worktrees, ctx).toEqual([]);
    expect(inv.tempDirs, ctx).toEqual([]);
    expect(inv.liveLaunches, ctx).toBe(0);
    expect(inv.pidOverlaps, ctx).toEqual([]);
    expect(inv.alivePids, ctx).toEqual([]);
    expect(inv.byStatus, ctx).toEqual(CASCADE_STATUS);
    expect(inv.outboxSummary, ctx).toEqual(CASCADE_OUTBOX);
    expect(inv.outboxOrphans, ctx).toEqual([]);
    const mvp = run.entries().get('MVP')!;
    expect(mvp.reviewVersion, ctx).toBe(2);
    expect(gitIn(run.repo, 'rev-parse', 'milestone/MVP/v1^{commit}'), ctx).toBe(v1.integrationSha);
    expect(gitIn(run.repo, 'rev-parse', 'milestone/MVP/v2^{commit}'), ctx).toBe(mvp.integrationSha);
    expect(mvp.integrationSha, ctx).not.toBe(v1.integrationSha);
  } finally {
    run.cleanup();
  }
}

describe('cascade crash scenario', () => {
  it('uninterrupted cascade converges', () => runCascadeScenario(), 180_000);

  it.each((['cascade.afterPlan', 'tick.afterPhase1', 'tick.afterPhase2', 'tick.afterPhase3', 'tick.afterPhase4', 'tick.afterPhase5'] as const).map((p) => [p] as const))(
    'cascade crash at %s then restart converges',
    (point) => runCascadeScenario(point),
    240_000,
  );
});

/** Pull mode: two scripted workers claim every launch; points that only a spawned launch reaches are skipped. */
const SPAWN_ONLY = new Set(['launch.afterWorktree', 'launch.afterSpawn', 'launch.afterPid', 'cascade.afterPlan']);

describe('pull-mode crash matrix', () => {
  it('uninterrupted pull run converges with every launch claimed by a worker', async () => {
    const run = await setupCrashRun({ pull: true });
    try {
      const child = run.start();
      await run.waitTerminal(120_000);
      await run.stop(child);
      await assertConverged(run, 'pull no-crash');
      const launches = run.entries();
      expect(launches.size).toBeGreaterThan(0);
      expect(readFileSync(run.dir + '/worker-events.log', 'utf8')).toMatch(/report T1 200/);
    } finally {
      run.cleanup();
    }
  }, 180_000);

  it.each(CRASH_POINTS.filter((p) => !SPAWN_ONLY.has(p)).map((p) => [p] as const))('pull-mode crash at %s then restart converges', async (point) => {
    const run = await setupCrashRun({ pull: true });
    try {
      const crashing = run.start({ ORCH_CRASH_AT: point });
      const code = await run.waitExit(crashing, 90_000);
      expect(code, `daemon did not crash at ${point}; log:\n${readFileSync(run.daemonLog, 'utf8').slice(-2000)}`).toBe(CRASH_EXIT_CODE);
      const resumed = run.start();
      await run.waitTerminal(150_000);
      await run.stop(resumed);
      await new Promise((r) => setTimeout(r, 300));
      await assertConverged(run, `pull ${point}`);
    } finally {
      run.cleanup();
    }
  }, 300_000);
});
