/**
 * The verify-claim fields of a job (and leaseLosses) live in its JSON document: no column and no migration, on every backend.
 * See specs/verifier-pool "Verify job offer".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store, VerifierJob } from '../../src/state/store.js';
import { backends } from './backends.js';

for (const backend of backends) (backend.available ? describe : describe.skip)(`verify job fields (${backend.name})`, () => {
  let dir: string;
  let store: Store;

  afterAll(() => backend.shutdown());
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-verify-fields-'));
    store = await backend.open(dir);
  });
  afterEach(async () => {
    try {
      store.close();
    } finally {
      await backend.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offer, token, verifier and result read back after reopen, and removed keys are gone', async () => {
    store.createJob({ jobId: 'J1', taskId: 'T1', launchId: 'L1', sealedSha: 'x', baseSha: 's', status: 'checking', expectedHead: 'h', applied: false, createdAt: 1, updatedAt: 1 });
    const fields: Partial<VerifierJob> = {
      offer: { at: 2, checkCommand: 'npm test' },
      token: 'ab'.repeat(24),
      verifier: { id: 'v1', claimedAt: 3, expiresAt: 600003 },
      result: { outcome: 'conflict', rebasedSha: 'c'.repeat(40), output: 'conflict in x', conflictFiles: ['x.txt', 'y.txt'], verifierId: 'v1', at: 4 },
    };
    store.updateJob('J1', fields);
    store = await backend.reopen(store, dir);
    expect(store.getJob('J1')).toMatchObject({ ...fields, status: 'checking', expectedHead: 'h' });
    await backend.check(store);

    store.updateJob('J1', { verifier: undefined, token: undefined });
    store = await backend.reopen(store, dir);
    const row = store.getJob('J1')!;
    expect(row).not.toHaveProperty('verifier');
    expect(row).not.toHaveProperty('token');
    expect(row).toMatchObject({ offer: fields.offer, result: fields.result });
    await backend.check(store);
  });

  it('leaseLosses and a verifierLost failure read back after reopen', async () => {
    store.createJob({ jobId: 'J2', taskId: 'T2', launchId: 'L2', sealedSha: 'x', baseSha: 's', status: 'checking', expectedHead: 'h', applied: false, createdAt: 1, updatedAt: 1 });
    store.updateJob('J2', { leaseLosses: 2, offer: { at: 2, checkCommand: 'npm test' } });
    store = await backend.reopen(store, dir);
    expect(store.getJob('J2')).toMatchObject({ status: 'checking', leaseLosses: 2 });
    await backend.check(store);

    // The third loss: failed as verifierLost, the claim fields gone. See specs/verifier-pool "Verify lease: cycle cap".
    store.updateJob('J2', { leaseLosses: 3, status: 'failed', failureKind: 'verifierLost', output: 'the job lost its verifier 3 times', offer: undefined, updatedAt: 5 });
    store = await backend.reopen(store, dir);
    const row = store.getJob('J2')!;
    expect(row).toMatchObject({ status: 'failed', failureKind: 'verifierLost', leaseLosses: 3, output: 'the job lost its verifier 3 times', updatedAt: 5 });
    expect(row).not.toHaveProperty('offer');
    await backend.check(store);
  });
});
