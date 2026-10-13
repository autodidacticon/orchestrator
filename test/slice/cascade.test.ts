import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../src/runner/subprocess.js';
import { gitIn, makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const G = `nodes:
  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }
  - { id: T2, deps: [T1], behavior: hang, description: d, acceptanceCriteria: [a] }
  - { id: MVP, kind: milestone, gated: true, deps: [T1] }
`;

const trailers = (repo: string) =>
  gitIn(repo, 'log', '--first-parent', '--format=%H %(trailers:key=Orchestrator-Task,valueonly)', 'main')
    .split('\n')
    .map((l) => l.trim().split(' ') as [string, string | undefined])
    .filter((p): p is [string, string] => Boolean(p[1]));

describe('cascade with real agents and the real verifier', () => {
  it('leaves the integration branch untouched, resets the milestone, kills the dependent, and the revision adds a second trailer commit', async () => {
    h = await makeSlice({ graph: G, realVerifier: true, config: { leaseTtlMs: 60_000, tickIntervalMs: 100 } });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted' && h!.orch.entry('T2').status.kind === 'running', 30_000);
    const head = gitIn(h.repo, 'rev-parse', 'main');
    const v1 = h.orch.entry('MVP');
    const tagV1 = gitIn(h.repo, 'rev-parse', 'milestone/MVP/v1^{commit}');
    expect(tagV1).toBe(v1.integrationSha);
    const l2 = h.launchOf('T2');
    const firstPublish = trailers(h.repo);
    expect(firstPublish.map(([, t]) => t)).toEqual(['T1']);

    const res = await fetch(`${h.orch.apiBaseUrl}/v1/tasks/T1/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cascade: true }) });
    const body = (await res.json()) as { ok: boolean; reset: Array<{ id: string; from: string }> };
    expect(res.status).toBe(200);
    expect(body.reset).toEqual(expect.arrayContaining([{ id: 'T1', from: 'done' }, { id: 'T2', from: 'running' }, { id: 'MVP', from: 'submitted' }]));
    await h.orch.tick();
    // The branch is untouched; the milestone is reset; the dependent is gone.
    expect(gitIn(h.repo, 'rev-parse', 'main')).toBe(head);
    expect(gitIn(h.repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(tagV1);
    expect(h.orch.status().foreignCommits).toEqual([]);
    expect(h.orch.entry('MVP')).toMatchObject({ status: { kind: 'unstarted' }, reviewVersion: 1 });
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'cascade' });
    for (let i = 0; i < 40 && pidAlive(l2.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(l2.pid!)).toBe(false);

    // T1 is revised: its new brief names the prior commit, and the revision lands as a second trailer commit.
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'running' || h!.orch.entry('T1').status.kind === 'submitted' || h!.orch.entry('T1').status.kind === 'done', 10_000);
    const t1Launch = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(t1Launch.launchNo).toBe(2);
    expect(t1Launch.baseSha).toBe(head);
    const t1Brief = JSON.parse(readFileSync(path.join(t1Launch.worktree, '.orchestrator', 'brief.json'), 'utf8').toString()) as { context?: { revision?: Record<string, unknown> } };
    expect(t1Brief.context?.revision).toMatchObject({ cause: 'reopened', priorBranch: 'task/T1/l1', priorPublishedSha: firstPublish[0]![0] });
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted' && h!.orch.entry('T2').status.kind === 'running', 40_000);
    const after = trailers(h.repo);
    expect(after.map(([, t]) => t)).toEqual(['T1', 'T1']);
    expect(gitIn(h.repo, 'merge-base', '--is-ancestor', after[1]![0], after[0]![0])).toBe('');
    const v2 = h.orch.entry('MVP');
    expect(v2.reviewVersion).toBe(2);
    expect(gitIn(h.repo, 'rev-parse', 'milestone/MVP/v2^{commit}')).toBe(v2.integrationSha);
    expect(gitIn(h.repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(tagV1);
    const t2Launch = h.launchOf('T2');
    const t2Brief = JSON.parse(readFileSync(path.join(t2Launch.worktree, '.orchestrator', 'brief.json'), 'utf8')) as { context?: { revision?: Record<string, unknown> } };
    expect(t2Brief.context?.revision).toMatchObject({ cause: 'upstreamReopened', upstream: 'T1', priorBranch: 'task/T2/l1' });
    expect(t2Brief.context?.revision).not.toHaveProperty('priorPublishedSha');
  }, 90_000);
});
