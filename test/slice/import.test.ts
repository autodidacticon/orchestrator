import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function putGraph(h: SliceHarness, body: Record<string, unknown>) {
  const res = await fetch(`${h.orch.apiBaseUrl}/v1/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('graph import route', () => {
  it('valid import is adopted, incompatible import is rejected whole, invalid import is not written', async () => {
    h = await makeSlice({ graph: single('hang'), fileGraph: true });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running).toEqual(['T1']);
    // compatible: add T2
    const added = await putGraph(h, { nodes: [{ id: 'T1', deps: [], behavior: 'hang' }, { id: 'T2', deps: ['T1'], behavior: 'commitAndSubmit' }] });
    expect(added.body).toMatchObject({ accepted: true, reasons: [] });
    expect(h.orch.graph().rev).toBe(added.body['rev']);
    expect(h.orch.graph().nodes.has('T2')).toBe(true);
    // incompatible: remove the running T1
    const removed = await putGraph(h, { content: 'nodes:\n  - { id: T2, deps: [] }\n' });
    expect(removed.body).toMatchObject({ accepted: false });
    expect((removed.body['reasons'] as string[]).join(' ')).toMatch(/T1/);
    expect(h.orch.graph().rev).toBe(added.body['rev']);
    expect(readFileSync(h.graphPath, 'utf8')).toContain('id: T2');
    // invalid: cycle, nothing written
    const before = readFileSync(h.graphPath, 'utf8');
    const invalid = await putGraph(h, { content: 'nodes:\n  - { id: A, deps: [B] }\n  - { id: B, deps: [A] }\n' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'cycle', details: { path: ['A', 'B', 'A'] } });
    expect(readFileSync(h.graphPath, 'utf8')).toBe(before);
    expect(h.store.listEvents({ kind: 'graph.imported' })).toHaveLength(2);
  });
});
