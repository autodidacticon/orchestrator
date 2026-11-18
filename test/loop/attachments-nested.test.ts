/**
 * A session end ends an attachment only when the nearest pid its chain shares with the attachment's chain is the
 * hook's parent or grandparent; pid 1 never matches. A session nested under a shell inside an outer session leaves
 * the outer session attached. See specs/operator-control "Session attachments".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sessionEndMatches } from '../../src/runs/ancestry.js';
import { makeSlice, type SliceHarness } from '../slice/harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function post(h: SliceHarness, route: string, body: Record<string, unknown>) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const G = `nodes:
  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: T2, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: T3, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
`;

// The outer session's attachment: S the operator server (alive, so the dead-first-pid reconcile leaves it be),
// L its launcher, C the session, T the terminal, then pid 1.
const S = process.pid;
const L = 910_001;
const C = 910_002;
const T = 910_003;
// The posting hook H; a nested session N under a shell B; some process P between a hook and its session; X, Y unrelated.
const H = 920_001;
const N = 920_002;
const B = 920_003;
const P = 920_004;
const X = 920_005;
const Y = 920_006;
const chain = [S, L, C, T, 1];

describe('session end by ancestry: nearest shared pid', () => {
  it('a nested session leaves the outer attachment live; the hook\'s parent or grandparent ends it; T or 1 alone ends nothing', async () => {
    h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    await h.orch.tick();

    /** Register `id` with the outer chain, claim `taskId` through it, and return the launch id. */
    const claimThrough = async (id: string, taskId: string): Promise<string> => {
      expect((await post(h!, '/v1/attachments', { id, pids: chain })).status).toBe(200);
      const c = await post(h!, '/v1/claims', { workerId: `w-${id}`, taskId, attachment: id });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      return String(c.body['launchId']);
    };
    const expectKeptRelease = async (id: string, launchId: string, taskId: string) => {
      expect(h!.orch.isLiveAttachment(id)).toBe(false);
      await h!.orch.tick();
      expect(h!.store.getLaunch(launchId)).toMatchObject({ status: 'ended', endReason: 'released' });
      const released = h!.store.listEvents({ kind: 'launch.released' }).filter((e) => e.launchId === launchId);
      expect(released).toHaveLength(1);
      expect(released[0]!.payload).toMatchObject({ keep: true });
      expect(h!.orch.entry(taskId)).toMatchObject({ attempts: 0 });
      expect(h!.orch.status().attachments.map((a) => a.id)).not.toContain(id);
    };

    // 1. A nested session's hook H under nested session N under shell B under C: the nearest shared pid is C at
    //    pids[3], so the outer attachment stays live and its launch stays claimed.
    const l1 = await claimThrough('outer', 'T1');
    expect((await post(h, '/v1/attachments/ended', { pids: [H, N, B, C, T], reason: 'other' })).body).toMatchObject({ ok: true, ended: [] });
    expect(h.orch.isLiveAttachment('outer')).toBe(true);
    await h.orch.tick();
    expect(h.store.getLaunch(l1)).toMatchObject({ status: 'live', worker: { attachment: 'outer' } });
    expect(h.orch.status().attachments).toMatchObject([{ id: 'outer', launches: [l1] }]);

    // 2. The hook's parent is C: the attachment ends, and the next reconcile releases with keep.
    expect((await post(h, '/v1/attachments/ended', { pids: [H, C, T], reason: 'other' })).body).toMatchObject({ ended: ['outer'] });
    await expectKeptRelease('outer', l1, 'T1');

    //    The hook's grandparent is C (one process P between the hook and its session): it ends too.
    const l2 = await claimThrough('outer2', 'T2');
    expect((await post(h, '/v1/attachments/ended', { pids: [H, P, C, T], reason: 'clear' })).body).toMatchObject({ ended: ['outer2'] });
    await expectKeptRelease('outer2', l2, 'T2');

    // 3. A chain whose only shared pid is T, or only 1, ends nothing.
    const l3 = await claimThrough('outer3', 'T3');
    for (const pids of [[H, X, Y, T], [H, X, Y, T, 1], [H, 1], [H, X, 1], [H, X, Y, 1]]) {
      expect((await post(h, '/v1/attachments/ended', { pids, reason: 'other' })).body, JSON.stringify(pids)).toMatchObject({ ended: [] });
    }
    expect(h.orch.isLiveAttachment('outer3')).toBe(true);
    await h.orch.tick();
    expect(h.store.getLaunch(l3)?.status).toBe('live');
  });
});

describe('sessionEndMatches', () => {
  it('matches only when the nearest shared pid, never 1, is the hook\'s parent or grandparent', () => {
    expect(sessionEndMatches([H, C, T], chain)).toBe(true);
    expect(sessionEndMatches([H, P, C, T], chain)).toBe(true);
    expect(sessionEndMatches([H, L], chain)).toBe(true);
    expect(sessionEndMatches([H, N, B, C, T], chain)).toBe(false);
    expect(sessionEndMatches([H, X, Y, T], chain)).toBe(false);
    expect(sessionEndMatches([H, 1], chain)).toBe(false);
    expect(sessionEndMatches([H, X, 1], chain)).toBe(false);
    expect(sessionEndMatches([H, 1, C], chain)).toBe(true);
    expect(sessionEndMatches([C], chain)).toBe(false);
    expect(sessionEndMatches([], chain)).toBe(false);
  });
});
