import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mapIssues } from '../../src/import/mapping.js';
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

  it('an imported epic whose children declare overlapping scopes launches them one at a time', async () => {
    h = await makeSlice({ graph: 'nodes: []', fileGraph: true, config: { leaseTtlMs: 60_000 } });
    const mapped = mapIssues({
      root: 'ENG-1',
      issues: [
        { id: 'ENG-1', title: 'Checkout', state: 'open', blockedBy: [] },
        { id: 'ENG-2', title: 'API', parent: 'ENG-1', state: 'open', blockedBy: [], description: 'Build the API.\n\n## Acceptance criteria\n- works\n\n## Scope\n- src/api/**' },
        { id: 'ENG-3', title: 'Users API', parent: 'ENG-1', state: 'open', blockedBy: [], description: 'Users.\n\n## Acceptance criteria\n- works\n\n## Scope\n- src/api/users/**' },
        { id: 'ENG-4', title: 'Docs', parent: 'ENG-1', state: 'open', blockedBy: [], description: 'Docs.\n\n## Acceptance criteria\n- works\n\n## Scope\n- docs/**' },
      ],
    });
    expect(mapped.nodes.find((n) => n.id === 'ENG-3')).toMatchObject({ scope: ['src/api/users/**'] });
    // The scripted agent defaults to commitAndSubmit, so every task publishes on its own.
    const imported = await putGraph(h, { content: mapped.content });
    expect(imported.body).toMatchObject({ accepted: true });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['ENG-2', 'ENG-4']);
    expect(h.orch.status().deferred).toEqual([{ id: 'ENG-3', reason: 'scopeOverlap', with: ['ENG-2'] }]);
    await h.waitFor(() => h!.orch.entry('ENG-3').status.kind === 'running', 20_000);
    expect(h.orch.entry('ENG-2').status.kind).toBe('done');
    expect(h.orch.status().deferred).toEqual([]);
    await h.waitFor(() => h!.orch.entry('ENG-1').status.kind === 'submitted', 20_000);
    const starts = h.store.listEvents({ kind: 'launch.created' }).map((e) => e.taskId);
    expect(starts).toEqual(['ENG-2', 'ENG-4', 'ENG-3']);
  });
});
