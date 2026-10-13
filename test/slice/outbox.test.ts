import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const G = `nodes:
  - { id: T1, deps: [], behavior: hang, url: "https://tracker.example/T1", trackerState: open }
  - { id: T2, deps: [], behavior: hang, url: "https://tracker.example/T2", trackerState: open }
`;

const tracker: Config['tracker'] = { enabled: 'always', maxAttempts: 3, parentInProgress: true, commentOnDone: false, commentOnFail: false, doneAt: 'integration', answersFromComments: true };

async function http(h: SliceHarness, method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('outbox routes', () => {
  it('lists, acknowledges, rejects with retry and cap, reports in status and digest, and records the tracker on import', async () => {
    h = await makeSlice({ graph: G, config: { tracker, leaseTtlMs: 60_000 }, fileGraph: true });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T1', 'T2']);

    const list = await http(h, 'GET', '/v1/outbox');
    expect(list.status).toBe(200);
    const effects = list.body['effects'] as Array<{ id: number; taskId: string; kind: string; status: string; payload: Record<string, unknown> }>;
    expect(effects.map((e) => [e.taskId, e.kind, e.status, e.payload['state']])).toEqual([
      ['T1', 'setState', 'pending', 'inProgress'],
      ['T2', 'setState', 'pending', 'inProgress'],
    ]);
    expect(effects[0]!.id).toBeLessThan(effects[1]!.id);
    expect(list.body['policy']).toMatchObject({ enabled: true, mode: 'always', doneAt: 'integration', maxAttempts: 3, answersFromComments: true });
    expect(typeof (list.body['policy'] as Record<string, unknown>)['runId']).toBe('string');
    const [first, second] = effects;

    const acked = await http(h, 'POST', `/v1/outbox/${first!.id}/ack`, { result: { stateId: 's-started' } });
    expect(acked.body).toMatchObject({ ok: true, effect: { id: first!.id, status: 'applied', result: { stateId: 's-started' } } });
    expect(((await http(h, 'GET', '/v1/outbox')).body['effects'] as Array<{ id: number }>).map((e) => e.id)).toEqual([second!.id]);
    expect(h.orch.status()).toMatchObject({ outboxPending: 1, trackerErrors: [] });
    const dup = await http(h, 'POST', `/v1/outbox/${first!.id}/ack`, { result: { stateId: 'other' } });
    expect(dup.body).toMatchObject({ ok: true, duplicate: true, effect: { result: { stateId: 's-started' } } });

    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'rate limited' })).body).toMatchObject({ effect: { status: 'pending', attempts: 1, error: 'rate limited' } });
    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'rate limited' })).body).toMatchObject({ effect: { status: 'pending', attempts: 2 } });
    expect(((await http(h, 'GET', '/v1/outbox')).body['effects'] as unknown[]).length).toBe(1);
    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'workflow has no started state' })).body).toMatchObject({ effect: { status: 'failed', attempts: 3 } });
    expect((await http(h, 'GET', '/v1/outbox')).body['effects']).toEqual([]);
    const status = await http(h, 'GET', '/v1/status');
    expect(status.body).toMatchObject({ outboxPending: 0, trackerErrors: [{ id: second!.id, taskId: 'T2', kind: 'setState', attempts: 3, error: 'workflow has no started state' }] });
    const events = await http(h, 'GET', '/v1/events?after=0&limit=1');
    expect(events.body['digest']).toMatchObject({ outboxPending: 0, trackerErrors: [{ id: second!.id }] });

    expect((await http(h, 'POST', '/v1/outbox/999/ack', { result: {} })).status).toBe(404);
    expect((await http(h, 'POST', '/v1/outbox/999/nack', { error: 'x' })).status).toBe(404);
    expect((await http(h, 'POST', `/v1/outbox/${first!.id}/nack`, { error: 'late' })).status).toBe(409);

    const kinds = h.store.listEvents().map((e) => e.kind);
    expect(kinds.filter((k) => k === 'operator.ack')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'operator.nack')).toHaveLength(3);

    // tracker record through the import route
    expect(status.body['tracker']).toBeUndefined();
    const recorded = await http(h, 'PUT', '/v1/graph', { content: G, tracker: { kind: 'linear', workspace: 'acme' } });
    expect(recorded.body).toMatchObject({ accepted: true });
    expect((await http(h, 'GET', '/v1/status')).body['tracker']).toMatchObject({ kind: 'linear', workspace: 'acme' });
    expect(h.store.listEvents({ kind: 'tracker.recorded' })).toHaveLength(1);
    await http(h, 'PUT', '/v1/graph', { content: G });
    expect((await http(h, 'GET', '/v1/status')).body['tracker']).toMatchObject({ kind: 'linear', workspace: 'acme' });
    const bad = await http(h, 'PUT', '/v1/graph', { content: G, tracker: { kind: 'jira' } });
    expect(bad.status).toBe(400);
    expect(h.store.listEvents({ kind: 'tracker.recorded' })).toHaveLength(1);
  });

  it('a run with no tracker recorded and auto mode produces no effects', async () => {
    h = await makeSlice({ graph: G, config: { tracker: { ...tracker, enabled: 'auto' }, leaseTtlMs: 60_000 } });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T1', 'T2']);
    expect((await http(h, 'GET', '/v1/outbox')).body).toMatchObject({ effects: [], policy: { enabled: false, mode: 'auto' } });
    expect(h.orch.status().outboxPending).toBe(0);
  });
});
