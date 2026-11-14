import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../../src/agent/server.js';
import type { Orchestrator } from '../../src/loop/orchestrator.js';
import { SqliteStore } from '../../src/state/sqlite.js';

/** The HTTP boundary answers 400 naming the field when the store refuses a value. See specs/agent-protocol "Integer fields". */
const servers: ApiServer[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const s of stores.splice(0)) s.close();
});

function serve(store: SqliteStore): ApiServer {
  const orch = { store, apiBaseUrl: '', requestBegan: () => undefined, requestEnded: () => undefined, isLiveAttachment: () => true } as unknown as Orchestrator;
  const server = new ApiServer(orch);
  servers.push(server);
  return server;
}

describe('ApiServer and unstorable values', () => {
  it('a route whose write the store refuses answers 400 with the field, and nothing is written', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const server = serve(store);
    server.addRoute('POST', /^\/v1\/probe-write$/, async (_req, body) => {
      store.transaction(() => {
        store.appendEvent({ kind: 'before' }, 1);
        store.putDedup('L1', body['n'] as number, { ok: true });
      });
      return { status: 200, body: { ok: true } };
    });
    const url = await server.listen(0);
    const res = await fetch(`${url}/v1/probe-write`, { method: 'POST', body: JSON.stringify({ n: 1.5 }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'dedup.seq', error: expect.stringMatching(/dedup\.seq must be a safe integer/) });
    expect(store.latestEventSeq()).toBe(0);
    const ok = await fetch(`${url}/v1/probe-write`, { method: 'POST', body: JSON.stringify({ n: 2 }) });
    expect(ok.status).toBe(200);
  });

  it('any other error still answers 500', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const server = serve(store);
    server.addRoute('POST', /^\/v1\/boom$/, async () => {
      throw new Error('boom');
    });
    const url = await server.listen(0);
    const res = await fetch(`${url}/v1/boom`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
  });
});
