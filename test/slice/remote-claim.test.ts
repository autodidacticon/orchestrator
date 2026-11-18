/**
 * A remote worker clones the claim's `repoUrl` and finds the integration branch at the claim's `baseSha`. See
 * specs/pull-runner "Claim".
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('slice: a remote claim over the API', () => {
  it('git clone <repoUrl> succeeds and origin/<integrationBranch> in the clone is the claim baseSha', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-claim-slice-'));
    const repo = makeRepo(dir);
    const bare = path.join(dir, 'origin.git');
    gitIn(dir, 'clone', '-q', '--bare', repo, bare);
    h = await makeSlice({
      graph: single('hang', ', description: d, acceptanceCriteria: [a]'),
      dir,
      repo,
      config: {
        leaseTtlMs: 60_000,
        apiBaseUrl: 'http://orchestrator.example:8080',
        runner: { mode: 'pull', access: 'remote', claimWindowMs: 60_000 },
        git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
        health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 },
      },
    });
    await h.orch.tick();
    // The worker's own claim goes over the real API, as a remote worker loop makes it.
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'remote-1', access: 'remote' }) });
    expect(res.status).toBe(200);
    const claim = (await res.json()) as Record<string, unknown>;
    expect(claim).toMatchObject({ access: 'remote', repoUrl: bare, integrationBranch: 'main', taskId: 'T1' });
    expect(claim).not.toHaveProperty('worktree');

    const clone = path.join(mkdtempSync(path.join(tmpdir(), 'orch-remote-worker-')), 'clone');
    gitIn(dir, 'clone', '-q', String(claim['repoUrl']), clone);
    expect(gitIn(clone, 'rev-parse', `origin/${String(claim['integrationBranch'])}`)).toBe(claim['baseSha']);
    // The worker creates the launch branch at the base commit there.
    gitIn(clone, 'checkout', '-q', '-b', String(claim['branch']), String(claim['baseSha']));
    expect(gitIn(clone, 'rev-parse', 'HEAD')).toBe(claim['baseSha']);
  }, 60_000);
});
