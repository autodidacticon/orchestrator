import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  if (h) chmodSync(h.repo, 0o755);
  await h?.cleanup();
  h = undefined;
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No token, no attachment header: the probes are unauthenticated. */
async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${h!.server.port}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('health probes (specs/cluster-runtime "Probes")', () => {
  it('healthz answers ok and readyz answers ok on a healthy daemon, without a token', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    expect(await get('/healthz')).toEqual({ status: 200, body: { ok: true } });
    expect(await get('/readyz')).toEqual({ status: 200, body: { ok: true } });
  });

  it('readyz answers 503 naming the integration branch once it is deleted, while healthz stays 200', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    gitIn(h.repo, 'checkout', '-q', '--detach');
    gitIn(h.repo, 'branch', '-q', '-D', 'main');
    const r = await get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body['reasons']).toEqual([expect.stringMatching(/^branch: main /)]);
    expect(await get('/healthz')).toEqual({ status: 200, body: { ok: true } });
  });

  it.skipIf(process.getuid?.() === 0)('readyz answers 503 naming the repository once its path is unreadable', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    chmodSync(h.repo, 0o000);
    const r = await get('/readyz');
    expect(r.status).toBe(503);
    const reasons = r.body['reasons'] as string[];
    expect(reasons.some((x) => x.startsWith('repo: '))).toBe(true);
    expect(reasons.some((x) => x.startsWith('store: '))).toBe(false);
    expect(await get('/healthz')).toEqual({ status: 200, body: { ok: true } });
    chmodSync(h.repo, 0o755);
    expect((await get('/readyz')).status).toBe(200);
  });

  it('a long sequence of health calls does not reset the idle clock, while a plain status call does', async () => {
    // No tick runs: the daemon stays quiescent, so only requests move the idle clock.
    h = await makeSlice({ graph: single('commitAndSubmit'), config: { daemon: { idleExitMs: 60_000, exitWhileAttached: true } } });
    await get('/v1/status');
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      expect((await get(i % 2 ? '/healthz' : '/readyz')).status).toBe(200);
      await pause(20);
    }
    const elapsed = Date.now() - t0;
    expect(h.orch.idleMs()).toBeGreaterThanOrEqual(elapsed);
    await get('/v1/status');
    expect(h.orch.idleMs()).toBeLessThan(elapsed);
  });
});
