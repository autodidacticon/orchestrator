import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/state/sqlite.js';
import { runIdOf, setRunId, setTracker, trackerOf } from '../../src/state/store.js';

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orch-outbox-'));
  store = new SqliteStore(path.join(dir, 's.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const effect = (sourceSeq: number, taskId = 'T1', kind: 'setState' | 'comment' = 'setState', payload: Record<string, unknown> = { issue: taskId, state: 'inProgress' }) => ({
  sourceSeq,
  taskId,
  kind,
  payload,
  createdAt: 100,
});

describe('outbox store', () => {
  it('a duplicate key keeps one row', () => {
    const first = store.insertOutbox(effect(7));
    expect(first).toBeDefined();
    expect(store.insertOutbox(effect(7))).toBeUndefined();
    const second = store.insertOutbox(effect(7, 'MVP'));
    const third = store.insertOutbox(effect(7, 'T1', 'comment', { body: 'x' }));
    expect(second!).toBeGreaterThan(first!);
    expect(third!).toBeGreaterThan(second!);
    expect(store.listOutbox().map((e) => e.id)).toEqual([first, second, third]);
  });

  it('lists pending effects in id order with paging', () => {
    for (let i = 1; i <= 5; i++) store.insertOutbox(effect(i));
    store.ackOutbox(2, { ok: true }, 200);
    expect(store.listOutbox({ status: 'pending' }).map((e) => e.id)).toEqual([1, 3, 4, 5]);
    expect(store.listOutbox({ status: 'pending', afterId: 3, limit: 1 }).map((e) => e.id)).toEqual([4]);
    expect(store.countOutbox('pending')).toBe(4);
    expect(store.countOutbox('applied')).toBe(1);
  });

  it('ack stores the result and the time; a second ack changes nothing', () => {
    store.insertOutbox(effect(1));
    const acked = store.ackOutbox(1, { commentId: 'c1' }, 500);
    expect(acked).toMatchObject({ status: 'applied', result: { commentId: 'c1' }, appliedAt: 500 });
    const again = store.ackOutbox(1, { commentId: 'other' }, 900);
    expect(again).toMatchObject({ status: 'applied', result: { commentId: 'c1' }, appliedAt: 500 });
  });

  it('nack keeps the effect pending below the cap and fails it at the cap', () => {
    store.insertOutbox(effect(1));
    expect(store.nackOutbox(1, 'rate limited', 3)).toMatchObject({ status: 'pending', attempts: 1, error: 'rate limited' });
    expect(store.nackOutbox(1, 'rate limited again', 3)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(store.nackOutbox(1, 'still', 3)).toMatchObject({ status: 'failed', attempts: 3, error: 'still' });
    expect(store.listOutbox({ status: 'pending' })).toEqual([]);
    expect(store.countOutbox('failed')).toBe(1);
    expect(store.ackOutbox(99, {}, 1)).toBeUndefined();
    expect(store.nackOutbox(99, 'x', 3)).toBeUndefined();
  });

  it('lastSetState reads the latest setState for an issue whatever its status', () => {
    expect(store.lastSetState('T1')).toBeUndefined();
    store.insertOutbox(effect(1, 'T1', 'setState', { issue: 'T1', state: 'inProgress' }));
    store.insertOutbox(effect(2, 'T1', 'comment', { body: 'question' }));
    expect(store.lastSetState('T1')).toBe('inProgress');
    store.insertOutbox(effect(3, 'T1', 'setState', { issue: 'T1', state: 'done' }));
    store.nackOutbox(3, 'boom', 1);
    expect(store.lastSetState('T1')).toBe('done');
    expect(store.lastSetState('T2')).toBeUndefined();
  });

  it('an existing store opens with an empty outbox and keeps the tracker and run id', () => {
    setTracker(store, { kind: 'linear', workspace: 'acme', recordedAt: 1 });
    setRunId(store, 'abc123');
    store.close();
    const reopened = new SqliteStore(path.join(dir, 's.sqlite'));
    try {
      expect(reopened.listOutbox()).toEqual([]);
      expect(trackerOf(reopened)).toEqual({ kind: 'linear', workspace: 'acme', recordedAt: 1 });
      expect(runIdOf(reopened)).toBe('abc123');
    } finally {
      reopened.close();
      store = new SqliteStore(path.join(dir, 's.sqlite'));
    }
  });
});
