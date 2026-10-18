/**
 * Git verifier backend. See specs/integration-pipeline.
 *   queued -> checking (temp worktree, rebase) -> verified (check green)
 *   -> publishing (squash with trailers, compare-and-swap) -> published
 * Every step after a durable progress record has a crash point.
 */
import { spawn } from 'node:child_process';
import { childEnv } from '../runs/childEnv.js';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { crashPoint } from '../crash.js';
import type { VerifierJob } from '../state/store.js';
import {
  commitTrailers,
  findTrailer,
  git,
  revParse,
  updateRefCas,
  worktreeAddDetached,
  worktreeList,
  worktreeRemove,
} from '../workspace/git.js';
import type { VerifierBackend, VerifierContext, VerifierOutcome } from './job.js';

export const TRAILER_TASK = 'Orchestrator-Task';
export const TRAILER_LAUNCH = 'Orchestrator-Launch';

export interface GitVerifierOptions {
  repo: string;
  integrationBranch: string;
  /** Root for temporary verification worktrees. */
  tempRoot: string;
  /** The run's data directory, the root of the isolated child environment; defaults to the parent of `tempRoot`. */
  dataDir?: string;
  /** The check command, or a getter read once when a job starts checking and held for the job. See specs/integration-pipeline "Check and verified tree". */
  checkCommand: string | undefined | (() => string | undefined);
  checkTimeoutMs: number;
  /** Head when the orchestrator first ran; commits before it are never foreign. */
  baselineSha?: string;
  /** Keep at most this many bytes of check output. */
  maxOutputBytes?: number;
}

const identity = {
  GIT_AUTHOR_NAME: 'orchestrator',
  GIT_AUTHOR_EMAIL: 'orchestrator@localhost',
  GIT_COMMITTER_NAME: 'orchestrator',
  GIT_COMMITTER_EMAIL: 'orchestrator@localhost',
};

export class GitVerifierBackend implements VerifierBackend {
  constructor(private readonly opts: GitVerifierOptions) {}

  private get ref(): string {
    return `refs/heads/${this.opts.integrationBranch}`;
  }

  async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    const { repo } = this.opts;
    const checkCommand = typeof this.opts.checkCommand === 'function' ? this.opts.checkCommand() : this.opts.checkCommand;
    const expectedHead = await revParse(repo, this.opts.integrationBranch);
    ctx.progress({ status: 'checking', expectedHead });
    const temp = path.join(this.opts.tempRoot, job.jobId);
    await mkdir(this.opts.tempRoot, { recursive: true });
    await worktreeRemove(repo, temp);
    await rm(temp, { recursive: true, force: true });
    await worktreeAddDetached(repo, temp, expectedHead);
    try {
      // 1. Rebase the sealed range onto the current head, from the merge base so a branch the
      //    agent already rebased onto a newer head does not replay published commits.
      const mergeBase = (await git(temp, ['merge-base', expectedHead, job.sealedSha], { allowFail: true })).stdout.trim() || job.baseSha;
      const rebase = await git(temp, ['rebase', '--onto', 'HEAD', mergeBase, job.sealedSha], { allowFail: true, env: identity });
      if (rebase.code !== 0) {
        const unmerged = (await git(temp, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
        await git(temp, ['rebase', '--abort'], { allowFail: true });
        if (unmerged.length || /CONFLICT|conflict/i.test(rebase.stdout + rebase.stderr)) {
          return { kind: 'conflict', files: unmerged, since: await ctx.publishedSince(job.baseSha) };
        }
        return { kind: 'failed', reason: { kind: 'checkFailed', message: 'rebase failed', output: tail(rebase.stderr || rebase.stdout, this.maxOut) } };
      }
      const rebasedSha = await revParse(temp, 'HEAD');
      ctx.progress({ rebasedSha });
      crashPoint('verify.afterRebase');

      // Declared no-op: nothing to publish.
      const rebasedTree = (await git(temp, ['rev-parse', `${rebasedSha}^{tree}`])).stdout.trim();
      const headTree = (await git(temp, ['rev-parse', `${expectedHead}^{tree}`])).stdout.trim();
      if (rebasedSha === expectedHead || (ctx.noChanges && rebasedTree === headTree)) {
        ctx.progress({ status: 'verified', verifiedSha: expectedHead });
        return { kind: 'published', publishedSha: expectedHead, verifiedSha: expectedHead };
      }

      // 2. Check command on the rebased tree.
      if (checkCommand === undefined) {
        return { kind: 'failed', reason: { kind: 'checkFailed', message: 'no check command is configured for this repository', output: '' } };
      }
      const check = await runCheck(checkCommand, temp, this.opts.checkTimeoutMs, this.maxOut, this.opts.dataDir ?? path.dirname(this.opts.tempRoot));
      crashPoint('verify.afterCheck');
      if (check.timedOut) {
        return { kind: 'failed', reason: { kind: 'checkTimeout', message: `check exceeded ${this.opts.checkTimeoutMs}ms`, output: check.output } };
      }
      if (check.code !== 0) {
        return { kind: 'failed', reason: { kind: 'checkFailed', message: `check exited ${check.code}`, output: check.output } };
      }
      ctx.progress({ status: 'verified', verifiedSha: rebasedSha });

      // 3. Squash: the verified tree with one parent and the trailers.
      const message = `${ctx.summary.trim() || job.taskId}\n\n${TRAILER_TASK}: ${job.taskId}\n${TRAILER_LAUNCH}: ${job.launchId}\n`;
      const squashSha = (await git(repo, ['commit-tree', rebasedTree, '-p', expectedHead, '-m', message], { env: identity })).stdout.trim();
      crashPoint('verify.afterSquash');
      ctx.progress({ status: 'publishing', squashSha });

      // 4. Compare-and-swap publication.
      const changedFiles = (await git(temp, ['diff', '--name-only', expectedHead, rebasedSha], { allowFail: true })).stdout.trim().split('\n').filter(Boolean).sort();
      const ok = await updateRefCas(repo, this.ref, squashSha, expectedHead);
      crashPoint('verify.afterPublish');
      if (!ok) return { kind: 'requeue' };
      await this.syncPrimaryWorktree();
      return { kind: 'published', publishedSha: squashSha, verifiedSha: rebasedSha, changedFiles };
    } finally {
      await worktreeRemove(repo, temp);
      await rm(temp, { recursive: true, force: true });
    }
  }

  /** The ref moved by CAS; bring the primary clone's index and tree along. Never used for work. */
  private async syncPrimaryWorktree(): Promise<void> {
    const head = (await git(this.opts.repo, ['symbolic-ref', '--quiet', 'HEAD'], { allowFail: true })).stdout.trim();
    if (head === this.ref) await git(this.opts.repo, ['reset', '--quiet', '--hard', 'HEAD'], { allowFail: true });
  }

  async recoverPublishing(job: VerifierJob): Promise<'published' | 'requeue'> {
    const found = await findTrailer(this.opts.repo, this.opts.integrationBranch, TRAILER_LAUNCH, job.launchId);
    if (found) {
      await this.syncPrimaryWorktree();
      return 'published';
    }
    return 'requeue';
  }

  async sweepTemp(): Promise<void> {
    const { repo } = this.opts;
    const root = await realpath(this.opts.tempRoot).catch(() => undefined);
    if (!root) return;
    for (const wt of await worktreeList(repo)) {
      const real = await realpath(wt).catch(() => wt);
      if (real.startsWith(`${root}${path.sep}`)) await worktreeRemove(repo, wt);
    }
    await rm(this.opts.tempRoot, { recursive: true, force: true });
  }

  async foreignCommits(): Promise<string[]> {
    const range = this.opts.baselineSha ? `${this.opts.baselineSha}..${this.opts.integrationBranch}` : this.opts.integrationBranch;
    const list = (await git(this.opts.repo, ['rev-list', '--first-parent', '-n', '500', range], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
    const foreign: string[] = [];
    for (const sha of list) {
      const trailers = await commitTrailers(this.opts.repo, sha);
      if (!trailers[TRAILER_LAUNCH]) foreign.push(sha);
    }
    return foreign;
  }

  private get maxOut(): number {
    return this.opts.maxOutputBytes ?? 64 * 1024;
  }
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export async function runCheck(command: string, cwd: string, timeoutMs: number, maxOut: number, dataDir: string): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    // Repository code runs here: same isolation as a spawned agent. See specs/integration-pipeline "Check environment".
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: childEnv(dataDir, identity), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString('utf8'), maxOut);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, output: `${output}\n${String(err)}` });
    });
  });
}
