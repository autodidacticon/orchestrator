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
  lastBody = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: lastBody };
}
/** The body of the last answer, so a check can follow an assertion that makes its request inline. */
let lastBody: Record<string, unknown> = {};

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
    // The answers carry the effect's id and state, not its payload; the listing keeps the payload. See specs/operator-control "Tracker outbox".
    const allowed = ['id', 'taskId', 'kind', 'status', 'attempts', 'result', 'error'];
    const shortForm = (body: Record<string, unknown>) => {
      const effect = body['effect'] as Record<string, unknown>;
      expect(effect).toBeTypeOf('object');
      expect(effect).not.toHaveProperty('payload');
      for (const key of Object.keys(effect)) expect(allowed, key).toContain(key);
    };
    shortForm(acked.body);
    expect(acked.body['effect']).toEqual({ id: first!.id, taskId: 'T1', kind: 'setState', status: 'applied', attempts: 0, result: { stateId: 's-started' } });
    shortForm(dup.body);
    const stillPending = (await http(h, 'GET', '/v1/outbox')).body['effects'] as Array<Record<string, unknown>>;
    expect(stillPending.map((e) => e['id'])).toEqual([second!.id]);
    expect(stillPending[0]).toHaveProperty('payload');
    expect((stillPending[0]!['payload'] as Record<string, unknown>)['state']).toBe('inProgress');

    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'rate limited' })).body).toMatchObject({ effect: { status: 'pending', attempts: 1, error: 'rate limited' } });
    shortForm(lastBody);
    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'rate limited' })).body).toMatchObject({ effect: { status: 'pending', attempts: 2 } });
    shortForm(lastBody);
    expect(((await http(h, 'GET', '/v1/outbox')).body['effects'] as unknown[]).length).toBe(1);
    expect((await http(h, 'POST', `/v1/outbox/${second!.id}/nack`, { error: 'workflow has no started state' })).body).toMatchObject({ effect: { status: 'failed', attempts: 3 } });
    shortForm(lastBody);
    expect((await http(h, 'GET', '/v1/outbox')).body['effects']).toEqual([]);
    const status = await http(h, 'GET', '/v1/status');
    expect(status.body).toMatchObject({ outboxPending: 0, trackerErrors: [{ id: second!.id, taskId: 'T2', kind: 'setState', attempts: 3, error: 'workflow has no started state' }] });
    const events = await http(h, 'GET', '/v1/events?after=0&limit=1');
    expect(events.body['digest']).toMatchObject({ outboxPending: 0, trackerErrors: [{ id: second!.id }] });

    expect((await http(h, 'POST', '/v1/outbox/999/ack', { result: {} })).status).toBe(404);
    expect((await http(h, 'POST', '/v1/outbox/999/nack', { error: 'x' })).status).toBe(404);
    const late = await http(h, 'POST', `/v1/outbox/${first!.id}/nack`, { error: 'late' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ ok: false, reason: `effect ${first!.id} is already applied`, effect: { id: first!.id, status: 'applied' } });
    shortForm(late.body);

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
    // A GitHub tracker carries owner/repo and the in-progress label, which status and the outbox policy report to drainers. See specs/graph-import "Tracker record".
    const gh = await http(h, 'PUT', '/v1/graph', { content: G, tracker: { kind: 'github', workspace: 'acme/app', inProgressLabel: 'in-progress' } });
    expect(gh.body).toMatchObject({ accepted: true });
    expect((await http(h, 'GET', '/v1/status')).body['tracker']).toMatchObject({ kind: 'github', workspace: 'acme/app', inProgressLabel: 'in-progress' });
    expect((await http(h, 'GET', '/v1/outbox')).body['policy']).toMatchObject({ tracker: { kind: 'github', inProgressLabel: 'in-progress' } });
    expect((await http(h, 'PUT', '/v1/graph', { content: G, tracker: { kind: 'linear', inProgressLabel: 'x' } })).status).toBe(400);
    expect(h.store.listEvents({ kind: 'tracker.recorded' })).toHaveLength(2);
  });

  it('a run with no tracker recorded and auto mode produces no effects', async () => {
    h = await makeSlice({ graph: G, config: { tracker: { ...tracker, enabled: 'auto' }, leaseTtlMs: 60_000 } });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T1', 'T2']);
    expect((await http(h, 'GET', '/v1/outbox')).body).toMatchObject({ effects: [], policy: { enabled: false, mode: 'auto' } });
    expect(h.orch.status().outboxPending).toBe(0);
  });
});
