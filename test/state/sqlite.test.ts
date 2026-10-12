import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import { applyTransition } from '../../src/state/transitions.js';

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
});
