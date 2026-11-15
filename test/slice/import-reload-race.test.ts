import { afterEach, describe, expect, it } from 'vitest';
import { makeSlice, single, type SliceHarness } from './harness.js';

/**
 * The import route writes the graph file and reloads, then answers `accepted` by comparing the active rev with the
 * written one. A reload that runs alongside (the tick's `loadGraph`) can take the file's new mtime first:
 * `FileGraphSource.poll` (src/graph/source.ts 43-52) stores `lastMtime` before it reads the file, so the route's own
 * poll sees an unchanged mtime and `lastRev === knownRev` and returns nothing. The route then answers
 * `accepted: false` with no reasons, and the other reload makes the graph active a moment later. Seen once in the
 * ORC-102 measurement (operator-mcp.test.ts "records the tracker at import ...", ORCH_TEST_PG=off run 10).
 *
 * ORCH_TEST_REPRO=import-reload-race starts that other reload just before the route's poll, and the test fails on
 * demand. Product defect, reported as a proposal in openspec/changes/suite-flake-causes; no fix under src/ here.
 */
let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('graph import with a reload alongside', () => {
  it('an import that is adopted is answered accepted', async () => {
    h = await makeSlice({ graph: single('hang'), fileGraph: true });
    await h.orch.tick();
    const src = h.orch.graphSource;
    const poll = src.poll.bind(src);
    let armed = process.env['ORCH_TEST_REPRO'] === 'import-reload-race';
    let other: Promise<void> | undefined;
    src.poll = async (known) => {
      if (!armed) return poll(known);
      armed = false;
      // A tick's reload starts first and records the file's new mtime before the route's poll reads it.
      const seen = (src as unknown as { lastMtime: number }).lastMtime;
      other = h!.orch.loadGraph();
      for (let i = 0; i < 1000 && (src as unknown as { lastMtime: number }).lastMtime === seen; i++) await new Promise((r) => setImmediate(r));
      return poll(known);
    };
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/graph`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'T1', deps: [], behavior: 'hang' }, { id: 'T2', deps: ['T1'], behavior: 'commitAndSubmit' }] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    await other;
    // Either way the written graph is active once both reloads are over.
    expect(h.orch.graph().rev).toBe(body['rev']);
    expect(body).toMatchObject({ accepted: true, reasons: [] });
  });
});
