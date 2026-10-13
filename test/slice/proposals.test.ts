import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function http(h: SliceHarness, method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Commit something in the task's worktree and submit through the agent API. */
async function submit(h: SliceHarness, taskId: string, extra: Record<string, unknown> = {}, seq = 1) {
  const l = h.launchOf(taskId);
  gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', `${taskId} work`);
  return h.orch.agentCall(l.launchId, l.token, 'report', { seq, kind: 'submit', summary: `did ${taskId}`, acceptance: [{ criterion: 'a', evidence: 'checked' }], ...extra });
}

const G = `nodes:
  - { id: T2, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: T3, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: MVP, kind: milestone, gated: true, deps: [T2] }
`;

describe('proposals', () => {
  it('are validated at report time, stored pending, listed, accepted into the graph file, joined to the milestone, and rejected with a note', async () => {
    h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000 }, fileGraph: true });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T2', 'T3']);
    const l2 = h.launchOf('T2');

    // Malformed: unknown dependency, and no acceptance criteria.
    const badDep = await h.orch.agentCall(l2.launchId, l2.token, 'report', { seq: 1, kind: 'submit', summary: 's', proposals: [{ title: 'X', description: 'd', acceptanceCriteria: ['c'], deps: ['NOPE'] }] });
    expect(badDep.status).toBe(400);
    expect(JSON.stringify(badDep.body)).toContain('NOPE');
    const noCriteria = await h.orch.agentCall(l2.launchId, l2.token, 'report', { seq: 1, kind: 'submit', summary: 's', proposals: [{ title: 'X', description: 'd', acceptanceCriteria: [] }] });
    expect(noCriteria.status).toBe(400);
    expect(h.orch.entry('T2').status.kind).toBe('running');
    expect(h.store.listProposals()).toEqual([]);

    const fileBefore = readFileSync(h.graphPath, 'utf8');
    const ok = await submit(h, 'T2', {
      proposals: [
        { title: 'Follow-up one', description: 'Do the follow-up.', acceptanceCriteria: ['follow-up works', 'documented'], deps: ['T3'], labels: ['follow-up'] },
        { title: 'Follow-up two', description: 'Another.', acceptanceCriteria: ['second works'] },
      ],
    });
    expect(ok.body).toMatchObject({ accepted: true, outcome: 'submitted' });
    expect(h.orch.entry('T2').status.kind).toBe('submitted');
    expect(h.store.listProposals({ status: 'pending' }).map((p) => p.id)).toEqual(['T2-p1', 'T2-p2']);
    expect(readFileSync(h.graphPath, 'utf8')).toBe(fileBefore);
    expect(h.store.listEvents({ kind: 'proposal.created' })).toHaveLength(2);

    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    const status = h.orch.status();
    expect(status.proposals).toEqual([{ id: 'T2-p1', taskId: 'T2', title: 'Follow-up one' }, { id: 'T2-p2', taskId: 'T2', title: 'Follow-up two' }]);
    const digest = ((await http(h, 'GET', '/v1/events?after=0&limit=1')).body['digest'] as Record<string, unknown>)['proposals'];
    expect(digest).toEqual(status.proposals);
    expect(((await http(h, 'GET', '/v1/proposals')).body['proposals'] as unknown[]).length).toBe(2);
    expect(((await http(h, 'GET', '/v1/proposals?status=accepted')).body['proposals'] as unknown[]).length).toBe(0);

    // Accept with a tracker id: node appended with deps plus the proposer; MVP gains the dep and resets.
    const accepted = await http(h, 'POST', '/v1/proposals/T2-p1/accept', { nodeId: 'ENG-77', payload: { priority: 2 } });
    expect(accepted.body).toMatchObject({ ok: true, id: 'T2-p1', nodeId: 'ENG-77', joined: ['MVP'], written: true, accepted: true });
    const file = readFileSync(h.graphPath, 'utf8');
    expect(file).toContain('id: ENG-77');
    expect(h.store.getProposal('T2-p1')).toMatchObject({ status: 'accepted', nodeId: 'ENG-77' });
    const node = h.orch.graph().nodes.get('ENG-77')!;
    expect([...node.deps].sort()).toEqual(['T2', 'T3']);
    expect(node.payload).toMatchObject({ title: 'Follow-up one', description: 'Do the follow-up.', acceptanceCriteria: ['follow-up works', 'documented'], labels: ['follow-up'], priority: 2, proposal: 'T2-p1', proposedBy: 'T2' });
    expect([...h.orch.graph().nodes.get('MVP')!.deps]).toEqual(['T2', 'ENG-77']);
    expect(h.orch.entry('MVP')).toMatchObject({ status: { kind: 'unstarted' }, reviewVersion: 1 });
    expect(h.store.listEvents({ kind: 'milestone.reset' })).toMatchObject([{ taskId: 'MVP', payload: { reason: 'depsChanged' } }]);
    expect(h.orch.status().proposals.map((p) => p.id)).toEqual(['T2-p2']);
    expect(h.store.listEvents({ kind: 'operator.acceptProposal' })).toHaveLength(1);

    // Idempotent: a second accept neither rewrites the file nor fails.
    const mtime = statSync(h.graphPath).mtimeMs;
    const again = await http(h, 'POST', '/v1/proposals/T2-p1/accept', { nodeId: 'ENG-77' });
    expect(again.body).toMatchObject({ ok: true, nodeId: 'ENG-77', duplicate: true, written: false });
    expect(statSync(h.graphPath).mtimeMs).toBe(mtime);

    // The new node runs after its deps: T3 is still running.
    await h.orch.tick();
    expect(h.orch.entry('ENG-77').status.kind).toBe('unstarted');
    expect((await submit(h, 'T3')).status).toBe(200);
    await h.waitFor(() => h!.orch.entry('ENG-77').status.kind === 'running', 20_000);
    const brief = JSON.parse(readFileSync(path.join(h.launchOf('ENG-77').worktree, '.orchestrator', 'brief.json'), 'utf8')) as { task: Record<string, unknown>; dependencies: Array<{ taskId: string }> };
    expect(brief.task).toMatchObject({ title: 'Follow-up one', proposedBy: 'T2' });
    expect(brief.dependencies.map((d) => d.taskId).sort()).toEqual(['T2', 'T3']);

    // Reject with a note; errors.
    expect((await http(h, 'POST', '/v1/proposals/T2-p2/reject', { note: '' })).status).toBe(409);
    const rejected = await http(h, 'POST', '/v1/proposals/T2-p2/reject', { note: 'not worth it' });
    expect(rejected.body).toMatchObject({ ok: true, rejected: true });
    expect(h.store.getProposal('T2-p2')).toMatchObject({ status: 'rejected', note: 'not worth it' });
    expect(h.orch.status().proposals).toEqual([]);
    expect((await http(h, 'POST', '/v1/proposals/T2-p2/accept', {})).status).toBe(409);
    expect((await http(h, 'POST', '/v1/proposals/NOPE/accept', {})).status).toBe(404);
    expect(readFileSync(h.graphPath, 'utf8')).toBe(file);
    expect(h.store.listEvents({ kind: 'operator.rejectProposal' })).toHaveLength(1);
  }, 60_000);

  it('accept without a node id uses the proposal id', async () => {
    h = await makeSlice({ graph: 'nodes:\n  - { id: T3, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n', config: { leaseTtlMs: 60_000 }, fileGraph: true });
    await h.orch.tick();
    expect((await submit(h, 'T3', { proposals: [{ title: 'Later', description: 'd', acceptanceCriteria: ['c'] }] })).status).toBe(200);
    const r = await http(h, 'POST', '/v1/proposals/T3-p1/accept', {});
    expect(r.body).toMatchObject({ ok: true, nodeId: 'T3-p1', joined: [], accepted: true });
    expect([...h.orch.graph().nodes.get('T3-p1')!.deps]).toEqual(['T3']);
    await h.waitFor(() => h!.orch.entry('T3-p1').status.kind === 'running', 20_000);
    expect(h.orch.entry('T3').status.kind).toBe('done');
  }, 30_000);
});
