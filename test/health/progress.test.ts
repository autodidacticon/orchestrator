import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headOf } from '../../src/health/progress.js';
import type { Launch } from '../../src/state/store.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from '../slice/harness.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const launchAt = (worktree: string): Launch => ({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree, baseSha: 's', graphRev: 'r', createdAt: 1 });

describe('progress fingerprint', () => {
  it('fake workspace: scripted per launch, head plus clean by default', async () => {
    const ws = new FakeWorkspace();
    const l = launchAt('/nowhere');
    expect(await ws.fingerprint(l)).toBe('head0:clean');
    ws.fingerprints.set('L1', 'head0:dirty');
    expect(await ws.fingerprint(l)).toBe('head0:dirty');
    expect(headOf('abc:def')).toBe('abc');
    expect(headOf(undefined)).toBeUndefined();
  });

  it('git workspace: changes on an uncommitted edit, on a further edit to the same file, on an untracked file, and on a commit', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-fp-'));
    const repo = makeRepo(dir);
    const ws = new GitWorkspace(repo, 'main', path.join(dir, 'wt'));
    const l = launchAt(repo);
    const clean = await ws.fingerprint(l);
    expect(clean).toMatch(/^[0-9a-f]{40}:[0-9a-f]{16}$/);
    expect(await ws.fingerprint(l)).toBe(clean);
    writeFileSync(path.join(repo, 'shared.txt'), 'edit one\n');
    const edited = await ws.fingerprint(l);
    expect(edited).not.toBe(clean);
    expect(headOf(edited)).toBe(headOf(clean));
    writeFileSync(path.join(repo, 'shared.txt'), 'edit two\n');
    const editedAgain = await ws.fingerprint(l);
    expect(editedAgain).not.toBe(edited);
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const untracked = await ws.fingerprint(l);
    expect(untracked).not.toBe(editedAgain);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'work');
    const committed = await ws.fingerprint(l);
    expect(headOf(committed)).not.toBe(headOf(clean));
    // .orchestrator/ never counts
    writeFileSync(path.join(repo, '.orchestrator-marker'), 'x');
    const before = await ws.fingerprint(l);
    rmSync(path.join(repo, '.orchestrator-marker'));
    expect(await ws.fingerprint(l)).not.toBe(before);
    expect(await ws.fingerprint(l)).toBe(committed);
  });
});

/**
 * A remote launch has no tree on the daemon's host: reconcile never fingerprints it, and its worker's heartbeats carry
 * the clone's fingerprint instead. See specs/health-monitoring "Progress signals" and specs/worker-pool "Loop heartbeat".
 */
describe('remote progress from heartbeats', () => {
  let h: SliceHarness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  const fp = (head: string, hash: string) => `${head.repeat(40)}:${hash.repeat(16)}`;
  const task = ', description: d, acceptanceCriteria: [a]';

  /** A pull run (remote with a bare origin, or local) on a fake clock, with T1 claimed by w1 and a counting fingerprint. */
  async function claimed(access: 'remote' | 'local', health: Record<string, unknown> = {}) {
    const d = mkdtempSync(path.join(tmpdir(), 'orch-remote-progress-'));
    const repo = makeRepo(d);
    const bare = path.join(d, 'origin.git');
    gitIn(d, 'clone', '-q', '--bare', repo, bare);
    let now = 1_000_000;
    h = await makeSlice({
      graph: single('hang', task),
      dir: d,
      repo,
      clock: () => now,
      config: {
        leaseTtlMs: 60_000,
        apiBaseUrl: 'http://orchestrator.example:8080',
        runner: { mode: 'pull', access, claimWindowMs: 600_000 },
        git: access === 'remote' ? { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 } : {},
        health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, gapAfterMs: 0, ...health },
      },
    });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1', access });
    expect(c.status).toBe(200);
    const launchId = String(c.body['launchId']);
    const token = String(c.body['token']);
    const ws = h.orch.workspace;
    const original = ws.fingerprint.bind(ws);
    let fingerprints = 0;
    ws.fingerprint = async (l: Launch) => {
      fingerprints++;
      return original(l);
    };
    return {
      h,
      launchId,
      advance: (ms: number) => void (now += ms),
      launch: () => h!.store.getLaunch(launchId)!,
      fingerprints: () => fingerprints,
      heartbeat: (body: Record<string, unknown>) => h!.orch.agentCall(launchId, token, 'heartbeat', body),
    };
  }

  it('reconcile of a live remote launch calls Workspace.fingerprint zero times; of a local launch, as before', async () => {
    const remote = await claimed('remote');
    for (let i = 0; i < 3; i++) {
      remote.advance(5000);
      await remote.h.orch.tick();
    }
    expect(remote.h.orch.entry('T1').status.kind).toBe('running');
    expect(remote.fingerprints()).toBe(0);
    expect(remote.launch().fingerprint).toBeUndefined();
    await remote.h.cleanup();
    h = undefined;

    const local = await claimed('local');
    for (let i = 0; i < 3; i++) {
      local.advance(5000);
      await local.h.orch.tick();
    }
    expect(local.h.orch.entry('T1').status.kind).toBe('running');
    expect(local.fingerprints()).toBe(3);
    expect(local.launch().fingerprint).toMatch(/^[0-9a-f]{40}:[0-9a-f]{16}$/);
  });

  it('a remote heartbeat with a new fingerprint records commit when the head changed, worktree when only the hash did, and stores it; the same again records nothing', async () => {
    const r = await claimed('remote');
    // The first fingerprint is a baseline, as a daemon-read one is.
    expect((await r.heartbeat({ fingerprint: fp('a', '0') })).status).toBe(200);
    const baseline = r.launch();
    expect(baseline.fingerprint).toBe(fp('a', '0'));

    r.advance(1000);
    await r.heartbeat({ fingerprint: fp('a', '1') });
    expect(r.launch()).toMatchObject({ fingerprint: fp('a', '1'), lastSignal: 'worktree', progressAt: baseline.progressAt! + 1000 });

    r.advance(1000);
    await r.heartbeat({ fingerprint: fp('b', '1') });
    expect(r.launch()).toMatchObject({ fingerprint: fp('b', '1'), lastSignal: 'commit', progressAt: baseline.progressAt! + 2000 });

    r.advance(1000);
    const before = r.launch();
    await r.heartbeat({ fingerprint: fp('b', '1') });
    expect(r.launch()).toMatchObject({ fingerprint: fp('b', '1'), lastSignal: 'commit', progressAt: before.progressAt });
    // The lease was renewed by every heartbeat, the unchanged one too.
    expect(r.h.orch.entry('T1').lease!.expiresAt).toBe(r.h.orch.now() + 60_000);
    // A malformed fingerprint is refused before anything is written.
    const bad = await r.heartbeat({ fingerprint: 'not-a-fingerprint' });
    expect(bad).toMatchObject({ status: 400, body: { field: 'fingerprint' } });
    expect(r.launch().fingerprint).toBe(fp('b', '1'));
  });

  it('a heartbeat with fingerprint on a local launch leaves the stored fingerprint unchanged', async () => {
    const l = await claimed('local');
    await l.h.orch.tick();
    const stored = l.launch().fingerprint;
    expect(stored).toMatch(/^[0-9a-f]{40}:[0-9a-f]{16}$/);
    l.advance(1000);
    expect((await l.heartbeat({ fingerprint: fp('c', '2') })).status).toBe(200);
    expect(l.launch().fingerprint).toBe(stored);
    // It is an ordinary heartbeat: progress of kind heartbeat.
    expect(l.launch().lastSignal).toBe('heartbeat');
  });

  it('a remote launch with a changing fingerprint is not stuck; one whose fingerprint stays the same past the limit fails as stuck, as a local launch does', async () => {
    const stuckEnd = (c: Awaited<ReturnType<typeof claimed>>) => {
      expect(c.launch()).toMatchObject({ status: 'ended', endReason: 'stuck' });
      // The attempt failed with reason stuck (the retry carries it).
      expect(c.h.orch.entry('T1').carry?.priorFailure).toMatchObject({ kind: 'stuck' });
    };
    const r = await claimed('remote', { stuckFailAfterMs: 30_000 });
    // 80 s, past twice the limit, with a new fingerprint every 10 s: never stuck.
    for (let i = 0; i < 8; i++) {
      await r.heartbeat({ fingerprint: fp('a', String(i)) });
      r.advance(10_000);
      await r.h.orch.tick();
    }
    expect(r.launch().status).toBe('live');
    expect(r.h.orch.entry('T1').status.kind).toBe('running');
    // From now on the loop's heartbeats renew the lease but carry the same fingerprint.
    for (let i = 0; i < 4 && r.launch().status === 'live'; i++) {
      await r.heartbeat({ fingerprint: fp('a', '7') });
      r.advance(10_000);
      await r.h.orch.tick();
    }
    stuckEnd(r);
    expect(r.launch().endedAt! - r.launch().progressAt!).toBeGreaterThan(30_000);
    expect(r.fingerprints()).toBe(0);
    await r.h.cleanup();
    h = undefined;

    const l = await claimed('local', { stuckFailAfterMs: 30_000 });
    for (let i = 0; i < 4 && l.launch().status === 'live'; i++) {
      l.advance(10_000);
      await l.h.orch.tick();
    }
    stuckEnd(l);
  });
});
