import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { makeHarness, type Harness } from '../loop/harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

function harness(config: ConfigInput = {}): Harness {
  const h = makeHarness({ config: { tickIntervalMs: 100, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true }, budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 }, ...config } });
  open.push(h);
  return h;
}

const contended = { reason: 'startupContended', detail: 'database is locked' };

/** Kill T1's current launch with `failure` scripted for it, and tick so the daemon relaunches. */
async function dieWith(h: Harness, failure: { reason: string; detail?: string } | undefined): Promise<string> {
  const l = h.launchOf('T1');
  if (failure) h.runner.failureScript.set(l.launchId, failure);
  h.runner.die(l.launchId);
  await h.orch.tick();
  return l.launchId;
}

// See specs/task-lifecycle "Retry and exhaustion" and "Health failure reasons".
describe('startupContended relaunch', () => {
  it('two contended deaths relaunch without charge; the task reaches done with attempts unchanged', async () => {
    const h = harness();
    await h.orch.tick();
    const dead = [await dieWith(h, contended), await dieWith(h, contended)];
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 3, status: { kind: 'running' } });
    const failed = h.store.listEvents({ kind: 'launch.failed', taskId: 'T1' });
    expect(failed.map((e) => e.launchId)).toEqual(dead);
    expect(failed.map((e) => e.payload)).toEqual([
      { reason: 'startupContended', detail: 'database is locked', charged: false },
      { reason: 'startupContended', detail: 'database is locked', charged: false },
    ]);
    const relaunches = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).filter((e) => e.payload?.['trigger'] === 'released');
    expect(relaunches.map((e) => e.payload?.['reason'])).toEqual(['startupContended', 'startupContended']);
    const prior = h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry?.['priorFailure'] as { message: string };
    expect(prior.message).toContain('startupContended');

    await h.submit('T1');
    await h.orch.settle();
    expect(h.statusOf('T1')).toBe('done');
    expect(h.orch.entry('T1').attempts).toBe(0);
  });

  it('the fourth contended death counts against the retry budget', async () => {
    const h = harness();
    await h.orch.tick();
    for (let i = 0; i < 3; i++) await dieWith(h, contended);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 4, status: { kind: 'running' } });
    await dieWith(h, contended);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 5, status: { kind: 'running' } });
    expect(h.store.listEvents({ kind: 'launch.failed', taskId: 'T1' }).map((e) => e.payload?.['charged'])).toEqual([false, false, false, true]);
  });

  it('health.contendedRetries bounds the allowance; 0 charges every contended death', async () => {
    const h = harness({ health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, contendedRetries: 0 } });
    await h.orch.tick();
    await dieWith(h, contended);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2 });
  });

  it('any other death is charged and still recorded as launch.failed', async () => {
    const h = harness();
    await h.orch.tick();
    await dieWith(h, { reason: 'exitBeforeTurn' });
    await dieWith(h, undefined);
    expect(h.store.listEvents({ kind: 'launch.failed', taskId: 'T1' }).map((e) => e.payload)).toEqual([{ reason: 'exitBeforeTurn', charged: true }, { charged: true }]);
    expect(h.statusOf('T1')).toBe('blocked');
  });
});
