/**
 * The two verifier steps a second backend or the verifier loop can call: `rebaseSealed` (the rebase of `run`) and
 * `GitVerifierBackend.publishVerified` (its squash and publication). See specs/integration-pipeline "Rebase and
 * conflict handling", "Rebase from the merge base", "Squash with trailers" and "Compare-and-swap publication".
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierContext, VerifierOutcome } from '../../src/verify/job.js';
import { GitVerifierBackend, rebaseSealed, TRAILER_LAUNCH, TRAILER_TASK } from '../../src/verify/verifier.js';
import { worktreeAddDetached } from '../../src/workspace/git.js';
import { Origin } from '../../src/workspace/origin.js';
import { gitIn, makeRepo } from './harness.js';

function setup(): { dir: string; repo: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-rebase-sealed-'));
  return { dir, repo: makeRepo(dir) };
}

/** Write `file` with `content` and commit it in `cwd`; answer the new head. */
function commit(cwd: string, file: string, content: string): string {
  writeFileSync(path.join(cwd, file), content);
  gitIn(cwd, 'add', file);
  gitIn(cwd, 'commit', '-q', '-m', `write ${file}`);
  return gitIn(cwd, 'rev-parse', 'HEAD');
}

/** A worktree of `repo` detached at `sha`, as `run` adds one. */
async function detached(dir: string, repo: string, sha: string, name = 'wt'): Promise<string> {
  const wt = path.join(dir, name);
  await worktreeAddDetached(repo, wt, sha);
  return wt;
}

describe('rebaseSealed', () => {
  it('criterion 6: rebases the sealed branch onto the expected head', async () => {
    const { dir, repo } = setup();
    const B = gitIn(repo, 'rev-parse', 'HEAD');
    gitIn(repo, 'checkout', '-q', '-b', 'sealed');
    const S = commit(repo, 'a.txt', 'branch\n');
    gitIn(repo, 'checkout', '-q', 'main');
    const H = commit(repo, 'h.txt', 'head\n');
    const wt = await detached(dir, repo, H);

    const r = await rebaseSealed(wt, H, S, B, 65536);
    expect(r.kind).toBe('rebased');
    const rebasedSha = (r as { kind: 'rebased'; rebasedSha: string }).rebasedSha;
    expect(gitIn(repo, 'rev-parse', `${rebasedSha}^`)).toBe(H);
    expect(gitIn(wt, 'rev-parse', 'HEAD')).toBe(rebasedSha);
    const files = gitIn(repo, 'ls-tree', '--name-only', rebasedSha).split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'h.txt']));
  }, 30_000);

  it('criterion 6: rebases from the merge base, so a head commit the branch already holds is not replayed', async () => {
    const { dir, repo } = setup();
    const B = gitIn(repo, 'rev-parse', 'HEAD');
    const H1 = commit(repo, 'h.txt', 'one\n');
    const H2 = commit(repo, 'h.txt', 'two\n');
    gitIn(repo, 'checkout', '-q', '-b', 'sealed', H1);
    const S = commit(repo, 'a.txt', 'branch\n');
    gitIn(repo, 'checkout', '-q', 'main');
    const wt = await detached(dir, repo, H2);

    // baseSha is still B: replaying H1 onto H2 would conflict on h.txt.
    const r = await rebaseSealed(wt, H2, S, B, 65536);
    expect(r.kind).toBe('rebased');
    const rebasedSha = (r as { kind: 'rebased'; rebasedSha: string }).rebasedSha;
    expect(gitIn(repo, 'rev-list', `${H2}..${rebasedSha}`).split('\n')).toHaveLength(1);
    expect(gitIn(repo, 'rev-parse', `${rebasedSha}:h.txt`)).toBe(gitIn(repo, 'rev-parse', `${H2}:h.txt`));
  }, 30_000);

  it('criterion 7: a conflict answers the unmerged files and a failure the tail of the output, each after aborting', async () => {
    const { dir, repo } = setup();
    const B = gitIn(repo, 'rev-parse', 'HEAD');
    gitIn(repo, 'checkout', '-q', '-b', 'sealed');
    const S = commit(repo, 'shared.txt', 'branch\n');
    gitIn(repo, 'checkout', '-q', 'main');
    const H = commit(repo, 'shared.txt', 'head\n');

    const wt = await detached(dir, repo, H);
    expect(await rebaseSealed(wt, H, S, B, 65536)).toEqual({ kind: 'conflict', files: ['shared.txt'] });
    expect(gitIn(wt, 'rev-parse', 'HEAD')).toBe(H);
    expect(gitIn(wt, 'status', '--porcelain')).toBe('');

    const unknown = '0123456789abcdef0123456789abcdef01234567';
    const failed = await rebaseSealed(wt, H, unknown, B, 16);
    expect(failed.kind).toBe('failed');
    const output = (failed as { kind: 'failed'; output: string }).output;
    expect(output.length).toBeGreaterThanOrEqual(1);
    expect(output.length).toBeLessThanOrEqual(16);
    expect(gitIn(wt, 'rev-parse', 'HEAD')).toBe(H);
    expect(gitIn(wt, 'status', '--porcelain')).toBe('');
  }, 30_000);
});

/** A second backend, as #32's will be: it reaches the publish step through the protected method. */
class PublishingBackend extends GitVerifierBackend {
  publish(job: VerifierJob, ctx: VerifierContext, expectedHead: string, rebasedSha: string, rebasedTree: string, diffDir: string): Promise<VerifierOutcome> {
    return this.publishVerified(job, ctx, expectedHead, rebasedSha, rebasedTree, diffDir);
  }
}

describe('publishVerified', () => {
  it('criterion 8: a subclass publishes a verified commit with the squash and the trailers', async () => {
    const { dir, repo } = setup();
    const bare = path.join(dir, 'origin.git');
    gitIn(dir, 'clone', '-q', '--bare', repo, bare);
    const H = gitIn(repo, 'rev-parse', 'main');
    gitIn(repo, 'checkout', '-q', '-b', 'verified');
    const R = commit(repo, 'r.txt', 'verified\n');
    gitIn(repo, 'checkout', '-q', 'main');
    const tree = gitIn(repo, 'rev-parse', `${R}^{tree}`);

    const backend = new PublishingBackend({ repo, integrationBranch: 'main', tempRoot: path.join(dir, 'verify'), checkCommand: 'true', checkTimeoutMs: 60_000 });
    backend.useOrigin(new Origin({ repo, integrationBranch: 'main', url: bare }));
    const job: VerifierJob = { jobId: 'j1', taskId: 'T1', launchId: 'L1', sealedSha: R, baseSha: H, status: 'verified', applied: false, createdAt: 0, updatedAt: 0 };
    const progress: Array<Partial<VerifierJob>> = [];
    const ctx: VerifierContext = { progress: (p) => void progress.push(p), summary: 'T1 summary', publishedSince: async () => [], noChanges: false };

    const outcome = await backend.publish(job, ctx, H, R, tree, repo);
    expect(outcome.kind).toBe('published');
    const published = outcome as Extract<VerifierOutcome, { kind: 'published' }>;
    expect(published.verifiedSha).toBe(R);
    expect(published.changedFiles).toEqual(['r.txt']);

    const squash = gitIn(repo, 'rev-parse', 'main');
    expect(published.publishedSha).toBe(squash);
    expect(gitIn(bare, 'rev-parse', 'main')).toBe(squash);
    expect(gitIn(repo, 'rev-list', `${H}..main`).split('\n')).toEqual([squash]);
    expect(gitIn(repo, 'rev-parse', `${squash}^`)).toBe(H);
    expect(gitIn(repo, 'rev-parse', `${squash}^{tree}`)).toBe(tree);
    const message = gitIn(repo, 'log', '-1', '--format=%B', squash);
    expect(message).toContain(`${TRAILER_TASK}: T1`);
    expect(message).toContain(`${TRAILER_LAUNCH}: L1`);
    expect(progress).toContainEqual({ status: 'publishing', squashSha: squash });
  }, 30_000);
});
