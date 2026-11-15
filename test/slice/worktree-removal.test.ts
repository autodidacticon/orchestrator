/**
 * ORC-94-p1: a published task's worktree removal is awaited, retried while left behind, and never overlaps another
 * `git worktree` command in the same clone; startup recovery removes the worktrees of ended launches of done tasks.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recover } from '../../src/launch/recovery.js';
import { withWorktreeLock, worktreeAdd, worktreeList, worktreeRemove } from '../../src/workspace/git.js';
import { makeHarness, type Harness } from '../loop/harness.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness } from './harness.js';

const single = (behavior: string) => `
nodes:
  - id: T1
    kind: task
    title: one
    description: ${behavior}
    acceptance: [x]
`;

const ONE = `
nodes:
  - id: T1
    kind: task
    title: one
    acceptance: [x]
`;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-wt-'));
  dirs.push(d);
  return d;
}

let slice: SliceHarness | undefined;
let loop: Harness | undefined;
afterEach(async () => {
  await slice?.cleanup();
  slice = undefined;
  loop?.cleanup();
  loop = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('worktree lock', () => {
  it('runs the worktree commands of one clone one at a time, whatever spelling names the clone', async () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const alias = path.join(dir, 'alias');
    symlinkSync(repo, alias);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const job = (i: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
      order.push(i);
      active--;
      if (i === 3) throw new Error('a failure does not release the next command early');
      return i;
    };
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => withWorktreeLock(i % 2 ? alias : repo, job(i))));
    expect(maxActive).toBe(1);
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(results[3]?.status).toBe('rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(11);
  });

  it('concurrent removals and adds in one clone all succeed and leave exactly the added worktrees', async () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const root = path.join(dir, 'wt');
    mkdirSync(root);
    const old = Array.from({ length: 8 }, (_, i) => path.join(root, `old${i}`));
    for (const [i, p] of old.entries()) await worktreeAdd(repo, p, `old/${i}`, 'main');
    const fresh = Array.from({ length: 8 }, (_, i) => path.join(root, `new${i}`));
    const ops = old.flatMap((p, i) => [worktreeRemove(repo, p), worktreeAdd(repo, fresh[i]!, `new/${i}`, 'main').then(() => true)]);
    expect(await Promise.all(ops)).toEqual(Array(16).fill(true));
    const listed = (await worktreeList(repo)).map((p) => path.basename(p)).filter((b) => b !== 'repo').sort();
    expect(listed).toEqual(fresh.map((p) => path.basename(p)).sort());
    for (const p of old) expect(existsSync(p)).toBe(false);
  });

  it('worktreeRemove clears a stale registration whose directory is gone, and a directory with no registration', async () => {
    const dir = tempDir();
    const repo = makeRepo(dir);
    const stale = path.join(dir, 'wt', 'stale');
    await worktreeAdd(repo, stale, 'stale', 'main');
    rmSync(stale, { recursive: true, force: true });
    expect((await worktreeList(repo)).some((p) => p.endsWith(`${path.sep}stale`))).toBe(true);
    expect(await worktreeRemove(repo, stale)).toBe(true);
    expect((await worktreeList(repo)).some((p) => p.endsWith(`${path.sep}stale`))).toBe(false);

    const orphan = path.join(dir, 'wt', 'orphan');
    mkdirSync(path.join(orphan, '.orchestrator'), { recursive: true });
    writeFileSync(path.join(orphan, '.orchestrator', 'brief.json'), '{}');
    expect(await worktreeRemove(repo, orphan)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe('worktree removal on publish', () => {
  it('a published task whose agent is still live has no worktree at the end of the tick that marks it done', async () => {
    // A long report grace keeps the launch live after its submit, so only the publish path removes the worktree.
    loop = makeHarness({ graph: ONE, config: { health: { reportGraceMs: 600_000 } } });
    const h = loop;
    // A slow removal: one the tick does not await is still running when the tick returns.
    const remove = h.workspace.remove.bind(h.workspace);
    h.workspace.remove = async (launch) => {
      await new Promise((r) => setTimeout(r, 200));
      return remove(launch);
    };
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect((await h.submit('T1')).status).toBe(200);
    for (let i = 0; i < 20 && h.statusOf('T1') !== 'done'; i++) {
      await h.orch.settle();
      await h.orch.tick();
    }
    expect(h.statusOf('T1')).toBe('done');
    expect(h.store.getLaunch(l.launchId)?.status).toBe('live');
    expect(await h.workspace.listWorktrees()).not.toContain(l.launchId);
  });

  it('a removal that leaves the worktree behind is retried on the next tick', async () => {
    loop = makeHarness({ graph: ONE });
    const h = loop;
    await h.orch.tick();
    const l = h.launchOf('T1');
    h.workspace.failRemovals.push(l.launchId);
    expect((await h.submit('T1')).status).toBe(200);
    for (let i = 0; i < 20 && h.statusOf('T1') !== 'done'; i++) {
      await h.orch.settle();
      await h.orch.tick();
    }
    expect(h.statusOf('T1')).toBe('done');
    // The failed removal joined the pending set, or a later removal (reconcile ending the launch) already took it.
    if (h.orch.pendingRemovals.has(l.launchId)) expect(await h.workspace.listWorktrees()).toContain(l.launchId);
    await h.orch.tick();
    expect(h.orch.pendingRemovals.has(l.launchId)).toBe(false);
    expect(await h.workspace.listWorktrees()).not.toContain(l.launchId);
    expect(h.workspace.failRemovals).toEqual([]);
  });
});

describe('a submit fenced across its seal', () => {
  async function submitWhile(during: (h: Harness, launchId: string) => void) {
    loop = makeHarness({ graph: ONE });
    const h = loop;
    await h.orch.tick();
    const l = h.launchOf('T1');
    const seal = h.workspace.seal.bind(h.workspace);
    h.workspace.seal = async (launch, opts) => {
      during(h, launch.launchId);
      return seal(launch, opts);
    };
    return { h, l, res: await h.submit('T1') };
  }

  it('is refused with 401 when the launch is revoked while its worktree is sealed, and the task stays running', async () => {
    const { h, l, res } = await submitWhile((h, id) => h.store.updateLaunch(id, { status: 'revoked', endedAt: h.now.value, endReason: 'recovered from launching' }));
    expect(res.status).toBe(401);
    expect(h.statusOf('T1')).toBe('running');
    expect(h.store.listJobs({ taskId: 'T1' })).toEqual([]);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('revoked');
  });

  it('a pre-crash agent submitting while recovery revokes and relaunches is refused, and no worktree is left once the relaunch publishes', async () => {
    loop = makeHarness({ graph: ONE });
    const h = loop;
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    // As at a crash at launch.afterSpawn: the row is still launching while the agent runs.
    h.store.updateLaunch(l1.launchId, { status: 'launching' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sealing!: () => void;
    const started = new Promise<void>((r) => (sealing = r));
    const seal = h.workspace.seal.bind(h.workspace);
    h.workspace.seal = async (launch, opts) => {
      if (launch.launchId === l1.launchId) {
        sealing();
        await gate;
      }
      return seal(launch, opts);
    };
    const late = h.orch.agentCall(l1.launchId, l1.token, 'report', { seq: 1, kind: 'submit', summary: 'late', acceptance: [{ criterion: 'x', evidence: 'e' }] });
    await started;
    await recover(h.orch);
    release();
    expect((await late).status).toBe(401);
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('revoked');
    const l2 = h.launchOf('T1');
    expect(l2.launchId).not.toBe(l1.launchId);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'running' }, lease: { launchId: l2.launchId } });
    expect((await h.submit('T1')).status).toBe(200);
    for (let i = 0; i < 20 && h.statusOf('T1') !== 'done'; i++) {
      await h.orch.settle();
      await h.orch.tick();
    }
    expect(h.statusOf('T1')).toBe('done');
    await h.orch.tick();
    expect(await h.workspace.listWorktrees()).toEqual([]);
  });

  it('is refused with 409 when the task was relaunched under another lease while its worktree was sealed', async () => {
    const { h, res } = await submitWhile((h) => {
      const e = h.orch.entry('T1');
      h.store.setEntry('T1', { ...e, lease: { ...e.lease!, launchId: 'another-launch' } });
    });
    expect(res.status).toBe(409);
    expect(h.statusOf('T1')).toBe('running');
    expect(h.store.listJobs({ taskId: 'T1' })).toEqual([]);
  });
});

describe('publish removes the worktrees of the task\'s other ended launches', () => {
  it('a failed attempt\'s worktree left behind is removed when the retry publishes', async () => {
    loop = makeHarness({ graph: ONE });
    const h = loop;
    await h.orch.tick();
    const first = h.launchOf('T1');
    h.workspace.failRemovals.push(first.launchId, first.launchId);
    await h.failTask('T1', 'try again');
    await h.orch.tick();
    expect(await h.workspace.listWorktrees()).toContain(first.launchId);
    const second = h.launchOf('T1');
    expect(second.launchId).not.toBe(first.launchId);
    expect((await h.submit('T1')).status).toBe(200);
    for (let i = 0; i < 20 && h.statusOf('T1') !== 'done'; i++) {
      await h.orch.settle();
      await h.orch.tick();
    }
    expect(h.statusOf('T1')).toBe('done');
    expect(await h.workspace.listWorktrees()).not.toContain(first.launchId);
  });
});

describe('startup recovery', () => {
  it('removes the leftover worktree directory of an ended launch whose task is done', async () => {
    slice = await makeSlice({ graph: single('commitAndSubmit') });
    await slice.waitFor(() => slice!.orch.entry('T1').status.kind === 'done', 20_000);
    const [l] = slice.store.listLaunches({ taskId: 'T1' });
    await slice.waitFor(() => slice!.store.getLaunch(l!.launchId)?.status === 'ended');
    // A directory left without a registration (the removal deleted the metadata, then the daemon died): the
    // registered-worktree sweep cannot see it.
    mkdirSync(path.join(l!.worktree, 'src'), { recursive: true });
    writeFileSync(path.join(l!.worktree, 'src', 'left.txt'), 'left behind\n');
    expect(await slice.workspace.listWorktrees()).toEqual([]);
    await recover(slice.orch);
    expect(existsSync(l!.worktree)).toBe(false);

    // And one still registered with the clone.
    gitIn(slice.repo, 'worktree', 'add', '--detach', l!.worktree, 'main');
    await recover(slice.orch);
    expect(existsSync(l!.worktree)).toBe(false);
    expect(await slice.workspace.listWorktrees()).toEqual([]);
  });
});
