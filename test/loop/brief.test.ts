import { afterEach, describe, expect, it } from 'vitest';
import { StaticRemediator } from '../../src/brief/remediate.js';
import { SlotValidator, slotValue } from '../../src/brief/template.js';
import { composeBrief } from '../../src/brief/compose.js';
import { parseGraph } from '../../src/graph/load.js';
import { makeHarness, type Harness } from './harness.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';

const graph = `nodes:
  - { id: A, deps: [], description: "do A" }
  - { id: B, deps: [], description: "do B", acceptanceCriteria: [works] }
  - { id: M, kind: milestone, deps: [A, B] }`;

let h: Harness | undefined;
afterEach(() => h?.cleanup());

function withValidator(opts: Parameters<typeof makeHarness>[0], remediator?: StaticRemediator) {
  const base = makeHarness(opts);
  const orch = new Orchestrator({
    store: base.store,
    config: base.orch.config,
    graphSource: base.source,
    runner: base.runner,
    workspace: base.workspace,
    verifier: base.verifier,
    briefValidator: new SlotValidator(),
    remediator,
    clock: () => base.now.value,
  });
  base.orch = orch;
  return base;
}

describe('slot validation', () => {
  it('reports missing required slots; arrays count; milestones are skipped', () => {
    const g = parseGraph(graph);
    const v = new SlotValidator();
    expect(v.validate(g.nodes.get('A')!, g.nodes.get('A')!.payload)).toEqual({ ok: false, missing: ['acceptanceCriteria'] });
    expect(v.validate(g.nodes.get('B')!, g.nodes.get('B')!.payload)).toEqual({ ok: true });
    expect(v.validate(g.nodes.get('M')!, {})).toEqual({ ok: true });
    expect(slotValue({ x: ['a', ' ', 'b'] }, 'x')).toBe('a\nb');
    expect(new SlotValidator({ d: { source: 'description', required: true, minLength: 10 } }).validate(g.nodes.get('A')!, g.nodes.get('A')!.payload)).toEqual({ ok: false, missing: ['d'] });
  });

  it('blocks a ready task with the missing slot list (policy block)', async () => {
    h = withValidator({ graph });
    await h.orch.tick();
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'insufficientSpec', missing: ['acceptanceCriteria'] } });
    expect(h.statusOf('B')).toBe('running');
    expect(h.orch.status().stallRoots).toContain('A');
  });

  it('review mode lands the candidate as needsDecision; unblock applies it', async () => {
    const rem = new StaticRemediator(() => ['remediated criterion']);
    h = withValidator({ graph, config: { onInsufficient: 'remediate', remediateMode: 'review' } }, rem);
    await h.orch.tick();
    expect(rem.calls).toEqual([{ taskId: 'A', missing: ['acceptanceCriteria'] }]);
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsDecision', candidate: { acceptanceCriteria: ['remediated criterion'] } } });
    expect(h.orch.unblock('A', { acceptCandidate: true })).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('running');
    const brief = h.workspace.briefs.get(h.launchOf('A').launchId)!;
    expect(brief.node.payload['acceptanceCriteria']).toEqual(['remediated criterion']);
    expect(h.store.getPayloadOverlay('A', h.orch.graph().rev)).toEqual({ acceptanceCriteria: ['remediated criterion'] });
    const { json } = composeBrief(brief, { fallbackPath: '/x' });
    expect(json.acceptanceCriteria).toEqual(['remediated criterion']);
  });

  it('auto mode launches directly with the candidate applied', async () => {
    h = withValidator({ graph, config: { onInsufficient: 'remediate', remediateMode: 'auto' } }, new StaticRemediator());
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('running');
    expect(h.workspace.briefs.get(h.launchOf('A').launchId)!.node.payload['acceptanceCriteria']).toBe('candidate acceptanceCriteria');
  });

  it('strict ingest mode rejects the whole graph', async () => {
    h = withValidator({ graph, config: { validateAt: 'ingest' } });
    await h.orch.tick();
    expect(h.orch.hasGraph()).toBe(false);
    expect(h.store.listEvents({ kind: 'graph.rejected' })[0]?.payload?.['reasons']).toEqual(['A: missing acceptanceCriteria']);
    expect(h.store.listLaunches()).toEqual([]);
  });
});
