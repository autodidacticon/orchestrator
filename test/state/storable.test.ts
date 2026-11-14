import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindRow, isUnstorable, storableJson, storableString, UnstorableValueError } from '../../src/state/storable.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import type { Store, VerifierJob } from '../../src/state/store.js';
import { backends } from './backends.js';

/** Storable values (ORC-88). See specs/state-backend "Storable values". */

describe('storable strings and JSON', () => {
  it('replaces NUL and lone surrogates of either half with U+FFFD and keeps pairs and other text', () => {
    expect(storableString('a\u0000b')).toBe('a�b');
    expect(storableString('x\uD83D')).toBe('x�');
    expect(storableString('\uDE00x')).toBe('�x');
    expect(storableString('\uDE00\uD83D')).toBe('��');
    expect(storableString('ok 😀 é \\u0000')).toBe('ok 😀 é \\u0000');
    const s = 'plain';
    expect(storableString(s)).toBe(s);
  });

  it('cleans every string and key inside a JSON value and leaves clean documents as JSON.stringify writes them', () => {
    expect(JSON.parse(storableJson({ 'k\u0000': ['\uD800', { n: 1, t: 'a\u0000' }], ok: '😀' }))).toEqual({ 'k�': ['�', { n: 1, t: 'a�' }], ok: '😀' });
    const clean = { a: 1, b: ['x', null], c: 'a\\u0000 literal' };
    expect(storableJson(clean)).toBe(JSON.stringify(clean));
    expect(storableJson(null)).toBe('null');
  });

  it('refuses a number that is not a safe integer for an integer column, naming the column', () => {
    for (const bad of [1.5, 1e30, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
      let err: unknown;
      try {
        bindRow('dedup', { launch_id: 'L', seq: bad, response: null });
      } catch (e) {
        err = e;
      }
      expect(isUnstorable(err), String(bad)).toBe(true);
      expect((err as UnstorableValueError).field).toBe('dedup.seq');
    }
    expect(bindRow('outbox', { applied_at: null, result: undefined })).toEqual([null, null]);
    expect(() => bindRow('events', { ts: null })).toThrow(UnstorableValueError);
  });
});

describe('the store refuses an unstorable integer before writing', () => {
  it('a putDedup with seq 1.5 throws UnstorableValueError and writes nothing', () => {
    const s = new SqliteStore(':memory:');
    expect(() => s.putDedup('L1', 1.5, { ok: true })).toThrow(UnstorableValueError);
    expect(() => s.appendEvent({ kind: 'x' }, 1e30)).toThrow(/events\.ts/);
    expect(s.latestEventSeq()).toBe(0);
    expect(s.getDedup('L1', 1.5)).toBeUndefined();
    s.close();
  });
});

// Check output as the verifier keeps it: cut by UTF-16 unit, so the cut can split a surrogate pair, and with NUL from the tool.
const emoji = '😀';
const raw = `start ${emoji.repeat(3)} middle\u0000 end ${emoji}`;
const cut = raw.slice(raw.indexOf(emoji) + 1); // starts with a lone low surrogate
const cutEnd = raw.slice(0, raw.lastIndexOf(emoji) + 1); // ends with a lone high surrogate

const job = (output: string): VerifierJob => ({ jobId: 'J1', taskId: 'T1', launchId: 'L1', sealedSha: 's', baseSha: 'b', status: 'failed', output, failureKind: 'check', applied: false, createdAt: 1, updatedAt: 1 });

for (const backend of backends) {
  (backend.available ? describe : describe.skip)(`check output with NUL and a cut surrogate pair (${backend.name})`, () => {
    let dir: string;
    let store: Store;
    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'orch-storable-'));
      store = await backend.open(dir);
    });
    afterEach(async () => {
      store.close();
      await backend.release();
      rmSync(dir, { recursive: true, force: true });
    });
    afterAll(() => backend.shutdown());

    it('is stored in the job and the task carry with U+FFFD, flushed, and reloads equal to the image', async () => {
      expect(cut.charCodeAt(0)).toBeGreaterThanOrEqual(0xdc00);
      expect(cutEnd.charCodeAt(cutEnd.length - 1)).toBeLessThan(0xdc00);
      store.transaction(() => {
        store.createJob(job(cut));
        store.updateJob('J1', { output: cutEnd });
        store.setEntry('T1', { ...defaultEntry(), carry: { verifierOutput: cut, priorFailure: { kind: 'checkFailed', output: cutEnd } as never } });
      });
      const expectedEnd = cutEnd.slice(0, -1).replace('\u0000', '�') + '�';
      expect(store.getJob('J1')!.output).toBe(expectedEnd);
      const carry = store.getEntry('T1')!.carry!;
      expect(carry.verifierOutput).toBe('�' + cut.slice(1).replace('\u0000', '�'));
      expect(carry.verifierOutput).not.toMatch(/\u0000/);
      // The durable copy holds it and a reload from it equals the image (SQLite file: reopen; journals: backend.check).
      await backend.check(store);
      store = await backend.reopen(store, dir);
      expect(store.getJob('J1')!.output).toBe(expectedEnd);
      expect(store.getEntry('T1')!.carry!.verifierOutput).toBe(carry.verifierOutput);
      await backend.check(store);
    });

    it('a text column with NUL (an outbox error, an attachment key) is stored with U+FFFD and flushed', async () => {
      const id = store.insertOutbox({ sourceSeq: 1, taskId: 'T1', kind: 'comment', payload: { body: 'a\u0000' }, createdAt: 1 })!;
      store.nackOutbox(id, 'tracker said \u0000\uD800', 3);
      store.putAttachment({ id: 'att\u0000', pids: [1], since: 1 });
      expect(store.getOutbox(id)!.error).toBe('tracker said ��');
      expect(store.getOutbox(id)!.payload).toEqual({ body: 'a�' });
      expect(store.getKv('attachment:att�')).toBeDefined();
      store.deleteAttachment('att\u0000');
      expect(store.listAttachments()).toEqual([]);
      await backend.check(store);
    });
  });
}
