import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import { applyTransition } from '../../src/state/transitions.js';
import { tsxLoader } from '../slice/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orch-store-'));
  store = new SqliteStore(path.join(dir, 's.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function claim(s: SqliteStore, id: string, launchId: string): boolean {
  try {
    s.transaction(() => {
      const e = s.getEntry(id) ?? defaultEntry();
      if (e.status.kind !== 'unstarted') throw new Error('not unstarted');
      const next = applyTransition(e, { kind: 'running' }, {
        nodeId: id,
        nodeKind: 'task',
        actor: 'orchestrator',
        trigger: 'admitted',
        now: 1,
        patch: { lease: { launchId, token: 't' + launchId, claimedAt: 1, expiresAt: 2, baseSha: 'b', graphRev: 'r' } },
      });
      s.setEntry(id, next);
    });
    return true;
  } catch {
    return false;
  }
}

describe('sqlite store', () => {
  it('two claims on one task yield exactly one lease', () => {
    const other = new SqliteStore(path.join(dir, 's.sqlite'));
    try {
      const a = claim(store, 'T1', 'L1');
      const b = claim(other, 'T1', 'L2');
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(store.getEntry('T1')?.lease?.launchId).toBe('L1');
      expect(store.getEntry('T1')?.launches).toBe(1);
    } finally {
      other.close();
    }
  });

  it('dedup returns the stored response', () => {
    expect(store.getDedup('L', 1)).toBeUndefined();
    store.putDedup('L', 1, { status: 200, body: { ok: true } });
    expect(store.getDedup('L', 1)).toEqual({ status: 200, body: { ok: true } });
    expect(store.getDedup('L', 2)).toBeUndefined();
  });

  it('events and overlay agree after reopening the database', () => {
    store.transaction(() => {
      store.setEntry('T1', { ...defaultEntry(), status: { kind: 'done' } });
      store.appendEvent({ kind: 'transition', taskId: 'T1', payload: { to: 'done' } }, 5);
    });
    store.setKv('paused', '1');
    store.setSnapshot('rev1', 'nodes: []');
    store.close();
    const reopened = new SqliteStore(path.join(dir, 's.sqlite'));
    try {
      expect(reopened.getEntry('T1')?.status.kind).toBe('done');
      expect(reopened.listEvents({ taskId: 'T1' })).toMatchObject([{ kind: 'transition', ts: 5 }]);
      expect(reopened.getKv('paused')).toBe('1');
      expect(reopened.getSnapshot()).toEqual({ rev: 'rev1', content: 'nodes: []' });
    } finally {
      reopened.close();
      store = new SqliteStore(path.join(dir, 's.sqlite'));
    }
  });

  it('a failing transaction leaves nothing behind', () => {
    expect(() =>
      store.transaction(() => {
        store.setEntry('T2', defaultEntry());
        store.appendEvent({ kind: 'x' }, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getEntry('T2')).toBeUndefined();
    expect(store.listEvents()).toEqual([]);
  });

  it('launches, jobs, reports, payload overlays round-trip', () => {
    store.createLaunch({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'preparing', token: 'tok', branch: 'b', worktree: 'w', baseSha: 's', graphRev: 'r', createdAt: 1 });
    store.updateLaunch('L1', { status: 'live', pid: 42 });
    expect(store.getLaunch('L1')).toMatchObject({ status: 'live', pid: 42 });
    expect(store.getLaunchByToken('tok')?.launchId).toBe('L1');
    expect(store.listLaunches({ status: ['live', 'ended'] })).toHaveLength(1);
    store.createJob({ jobId: 'J1', taskId: 'T1', launchId: 'L1', sealedSha: 'x', baseSha: 's', status: 'queued', applied: false, createdAt: 1, updatedAt: 1 });
    store.updateJob('J1', { status: 'published', publishedSha: 'p' });
    expect(store.listJobs({ applied: false })).toMatchObject([{ status: 'published', publishedSha: 'p' }]);
    store.putReport({ launchId: 'L1', taskId: 'T1', kind: 'submit', body: { summary: 'ok' }, createdAt: 1 });
    expect(store.getCompletionReport('T1')?.body['summary']).toBe('ok');
    store.setPayloadOverlay('T1', 'r', { acceptanceCriteria: ['a'] });
    expect(store.getPayloadOverlay('T1', 'r')).toEqual({ acceptanceCriteria: ['a'] });
    expect(store.getPayloadOverlay('T1', 'other')).toBeUndefined();
  });

  it('proposals round-trip and a dropped job is applied', () => {
    store.createProposal({ id: 'T2-p1', taskId: 'T2', launchId: 'L1', status: 'pending', payload: { title: 'Follow-up', description: 'd', acceptanceCriteria: ['works'], deps: ['T3'] }, createdAt: 5 });
    store.createProposal({ id: 'T2-p2', taskId: 'T2', launchId: 'L1', status: 'pending', payload: { title: 'Second', description: 'd', acceptanceCriteria: ['x'] }, createdAt: 6 });
    expect(store.listProposals({ status: 'pending' }).map((p) => p.id)).toEqual(['T2-p1', 'T2-p2']);
    store.updateProposal('T2-p1', { status: 'accepted', nodeId: 'ENG-77', decidedAt: 9 });
    expect(store.getProposal('T2-p1')).toMatchObject({ status: 'accepted', nodeId: 'ENG-77', decidedAt: 9, payload: { deps: ['T3'] } });
    expect(store.listProposals({ status: 'pending' }).map((p) => p.id)).toEqual(['T2-p2']);
    expect(store.listProposals({ taskId: 'T2' })).toHaveLength(2);
    expect(store.listProposals({ taskId: 'T9' })).toEqual([]);
    store.createJob({ jobId: 'J3', taskId: 'T2', launchId: 'L1', sealedSha: 'x', baseSha: 's', status: 'queued', applied: false, createdAt: 1, updatedAt: 1 });
    store.dropJob('J3');
    expect(store.getJob('J3')).toMatchObject({ status: 'dropped', applied: true });
    expect(store.listJobs({ status: 'queued' })).toEqual([]);
  });

  it('health and usage fields round-trip on launches and jobs, and an undefined patch removes a field', () => {
    store.createLaunch({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 'tok', branch: 'b', worktree: 'w', baseSha: 's', graphRev: 'r', createdAt: 1, spawnedAt: 2 });
    store.updateLaunch('L1', { progressAt: 50, lastSignal: 'worktree', progressText: 'editing', fingerprint: 'h:1', stuckSince: 60, waitedMs: 7, waitingSince: 70, costUsd: 1.25, turns: 3, durationMs: 900 });
    expect(store.getLaunch('L1')).toMatchObject({ progressAt: 50, lastSignal: 'worktree', progressText: 'editing', fingerprint: 'h:1', stuckSince: 60, waitedMs: 7, waitingSince: 70, costUsd: 1.25, turns: 3, durationMs: 900 });
    store.updateLaunch('L1', { stuckSince: undefined, waitingSince: undefined });
    const l = store.getLaunch('L1')!;
    expect('stuckSince' in l).toBe(false);
    expect('waitingSince' in l).toBe(false);
    store.createJob({ jobId: 'J2', taskId: 'T1', launchId: 'L1', sealedSha: 'x', baseSha: 's', status: 'queued', applied: false, createdAt: 1, updatedAt: 1 });
    store.updateJob('J2', { status: 'published', publishedSha: 'p', changedFiles: ['README.md', 'src/a.ts'] });
    expect(store.getJob('J2')?.changedFiles).toEqual(['README.md', 'src/a.ts']);
  });

  it('an inner transaction that throws is undone while the outer commits', () => {
    store.transaction(() => {
      store.setEntry('T1', defaultEntry());
      try {
        store.transaction(() => {
          store.setEntry('T2', defaultEntry());
          throw new Error('inner');
        });
      } catch (err) {
        expect((err as Error).message).toBe('inner');
      }
    });
    expect(store.getEntry('T1')).toBeDefined();
    expect(store.getEntry('T2')).toBeUndefined();
  });

  it("an outer throw undoes an inner transaction's writes", () => {
    expect(() =>
      store.transaction(() => {
        store.transaction(() => store.setEntry('T3', defaultEntry()));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(store.getEntry('T3')).toBeUndefined();
    // The store is usable afterwards at depth zero.
    store.setKv('after', '1');
    expect(store.getKv('after')).toBe('1');
  });

  it('a duplicate launch id throws and rolls back the transaction', () => {
    const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'preparing' as const, token: 'tok', branch: 'b', worktree: 'w', baseSha: 's', graphRev: 'r', createdAt: 1 };
    store.createLaunch(launch);
    expect(() =>
      store.transaction(() => {
        store.appendEvent({ kind: 'x' }, 1);
        store.createLaunch({ ...launch, token: 'tok2' });
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(store.listEvents()).toEqual([]);
    expect(store.listLaunches()).toHaveLength(1);
  });

  it('appendEvent and insertOutbox return numbers, getSnapshot returns a plain object, close twice is a no-op', () => {
    const seq = store.appendEvent({ kind: 'x' }, 1);
    expect(typeof seq).toBe('number');
    const id = store.insertOutbox({ sourceSeq: seq, taskId: 'T1', kind: 'setState', payload: { state: 'done' }, createdAt: 1 });
    expect(typeof id).toBe('number');
    store.setSnapshot('rev', 'nodes: []');
    const snap = store.getSnapshot()!;
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(snap).toEqual({ rev: 'rev', content: 'nodes: []' });
    store.close();
    expect(() => store.close()).not.toThrow();
    store = new SqliteStore(path.join(dir, 's.sqlite'));
  });

  it('a writer in another process makes this one wait, and a reader is not blocked', async () => {
    store.setKv('held', 'before');
    const flag = path.join(dir, 'flag');
    const child = execFile('node', ['--import', tsxLoader, path.join(here, 'hold-write.ts'), path.join(dir, 's.sqlite'), flag], { cwd: dir });
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 10_000;
    while (!existsSync(flag)) {
      if (Date.now() > deadline) throw new Error('child never started its transaction');
      await new Promise((r) => setTimeout(r, 20));
    }
    // The child's transaction is open with an uncommitted write: a reader sees the old value and is not blocked.
    expect(store.getKv('held')).toBe('before');
    const t0 = Date.now();
    store.setKv('held', 'parent');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(store.getKv('held')).toBe('parent');
    expect(await exit).toBe(0);
    expect(stderr).toContain('probe');
    expect(stderr).not.toContain('ExperimentalWarning');
    expect(JSON.parse(stdout.trim())).toEqual({ restored: true });
  }, 20_000);
});
