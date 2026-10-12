import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRASH_POINTS } from '../../src/crash.js';
import { checkInvariants, CRASH_EXIT_CODE, setupCrashRun } from './harness.js';

const EXPECTED_STATUS = { done: ['T1', 'T2', 'T3', 'T4', 'T5'], submitted: ['MVP'] };

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

  it.each(CRASH_POINTS.map((p) => [p] as const))('crash at %s then restart converges', async (point) => {
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
