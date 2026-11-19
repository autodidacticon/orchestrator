import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.js';
import { makeHarness, type Harness } from './harness.js';

// See specs/health-monitoring "Usage accounting": the report grace under its default.
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const GRACE = defaultConfig().health.reportGraceMs;

function harness(): Harness {
  // The loop harness sets reportGraceMs 0 by itself; these tests run under the schema default.
  const h = makeHarness({
    config: {
      tickIntervalMs: 100,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: GRACE, gapAfterMs: 0, baseMovedNotice: true },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 },
    },
  });
  open.push(h);
  return h;
}

/** Move the clock to `ms` after `from`, in steps of at most 10 s with a tick after each. */
async function tickUntil(h: Harness, from: number, ms: number): Promise<void> {
  while (h.now.value < from + ms) {
    h.advance(Math.min(10_000, from + ms - h.now.value));
    await h.orch.tick();
  }
}

describe('report grace default', () => {
  it('is 120000', () => {
    expect(defaultConfig().health.reportGraceMs).toBe(120_000);
    expect(GRACE).toBe(120_000);
  });

  it('records usage a process writes 45 s after its report', async () => {
    const h = harness();
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect((await h.submit('T1')).status).toBe(200);
    const reportedAt = h.now.value;
    await h.orch.tick();
    await tickUntil(h, reportedAt, 45_000);
    expect(h.now.value - reportedAt).toBe(45_000);
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'live', reportedAt });
    expect(h.runner.isAlive(l.launchId)).toBe(true);
    expect(h.store.listEvents({ kind: 'launch.usage' })).toHaveLength(0);
    h.runner.usageScript.set(l.launchId, { costUsd: 3.84, turns: 7, durationMs: 1234 });
    h.runner.die(l.launchId);
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'reported', costUsd: 3.84, turns: 7 });
    expect(h.store.listEvents({ kind: 'daemon.gap' })).toHaveLength(0);
  });

  it('reaps a process that never exits on the first tick 120 s after the report, not before', async () => {
    const h = harness();
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect((await h.submit('T1')).status).toBe(200);
    const reportedAt = h.now.value;
    await h.orch.tick();
    await tickUntil(h, reportedAt, 119_000);
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'live' });
    expect(h.runner.isAlive(l.launchId)).toBe(true);
    h.advance(1_000);
    expect(h.now.value - reportedAt).toBe(120_000);
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'reported' });
    expect(h.runner.isAlive(l.launchId)).toBe(false);
    expect(h.store.listEvents({ kind: 'daemon.gap' })).toHaveLength(0);
  });
});
