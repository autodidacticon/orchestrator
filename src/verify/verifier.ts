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
import { type Origin, OriginConfigError, OriginFetchError, type PushResult } from '../workspace/origin.js';
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
  /** Run in the temporary worktree immediately before the check command, read once when the backend is built. See specs/integration-pipeline "Prepare command before the check". */
  prepareCommand?: string;
  /** Bound on the prepare command; 600000 when unset. */
  prepareTimeoutMs?: number;
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
  protected origin: Origin | undefined;

  constructor(protected readonly opts: GitVerifierOptions) {}

  /** Make origin the source of truth for publication. See specs/integration-pipeline "Origin as source of truth". */
  useOrigin(origin: Origin | undefined): void {
    this.origin = origin;
  }

  protected get ref(): string {
    return `refs/heads/${this.opts.integrationBranch}`;
  }

  async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    const { repo } = this.opts;
    const checkCommand = typeof this.opts.checkCommand === 'function' ? this.opts.checkCommand() : this.opts.checkCommand;
    let expectedHead: string;
    if (this.origin) {
      const start = await this.startFromOrigin(job);
      if (start.kind !== 'head') return start.outcome;
      expectedHead = start.head;
    } else {
      expectedHead = await revParse(repo, this.opts.integrationBranch);
    }
    ctx.progress({ status: 'checking', expectedHead });
    const temp = path.join(this.opts.tempRoot, job.jobId);
    await mkdir(this.opts.tempRoot, { recursive: true });
    await worktreeRemove(repo, temp);
    await rm(temp, { recursive: true, force: true });
    await worktreeAddDetached(repo, temp, expectedHead);
    try {
      // 1. Rebase the sealed range onto the current head.
      const rebased = await rebaseSealed(temp, expectedHead, job.sealedSha, job.baseSha, this.maxOut);
      if (rebased.kind === 'conflict') {
        return { kind: 'conflict', files: rebased.files, since: await ctx.publishedSince(job.baseSha) };
      }
      if (rebased.kind === 'failed') {
        return { kind: 'failed', reason: { kind: 'checkFailed', message: 'rebase failed', output: rebased.output } };
      }
      const { rebasedSha } = rebased;
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
      // The prepare command installs what the check needs. The published tree was read above, so nothing it writes is published.
      // The failed job keeps the output, not the message, so the output leads with the message.
      if (this.opts.prepareCommand !== undefined) {
        const prepareTimeoutMs = this.opts.prepareTimeoutMs ?? 600000;
        const prep = await runCheck(this.opts.prepareCommand, temp, prepareTimeoutMs, this.maxOut, this.opts.dataDir ?? path.dirname(this.opts.tempRoot), { closeWaitMs: 2000 });
        if (prep.timedOut) {
          const message = `prepare command exceeded ${prepareTimeoutMs}ms`;
          return { kind: 'failed', reason: { kind: 'checkTimeout', message, output: `${message}\n${prep.output}` } };
        }
        if (prep.code !== 0) {
          const message = `prepare command exited ${prep.code}`;
          return { kind: 'failed', reason: { kind: 'checkFailed', message, output: `${message}\n${prep.output}` } };
        }
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

      return await this.publishVerified(job, ctx, expectedHead, rebasedSha, rebasedTree, temp);
    } finally {
      await worktreeRemove(repo, temp);
      await rm(temp, { recursive: true, force: true });
    }
  }

  /**
   * Squash the rebased, verified tree onto `expectedHead` with the trailers and publish it by compare-and-swap (and a
   * push with a lease when origin is on). `diffDir` is any checkout of the clone's object store that holds both
   * commits; the changed files are read there.
   */
  protected async publishVerified(job: VerifierJob, ctx: VerifierContext, expectedHead: string, rebasedSha: string, rebasedTree: string, diffDir: string): Promise<VerifierOutcome> {
    const { repo } = this.opts;
    // 3. Squash: the verified tree with one parent and the trailers.
    const message = `${ctx.summary.trim() || job.taskId}\n\n${TRAILER_TASK}: ${job.taskId}\n${TRAILER_LAUNCH}: ${job.launchId}\n`;
    const squashSha = (await git(repo, ['commit-tree', rebasedTree, '-p', expectedHead, '-m', message], { env: identity })).stdout.trim();
    crashPoint('verify.afterSquash');
    ctx.progress({ status: 'publishing', squashSha });
    // The ref update and the push are outside effects: they wait until the publishing record is durable.
    await ctx.durable?.();

    // 4. Compare-and-swap publication.
    const changedFiles = (await git(diffDir, ['diff', '--name-only', expectedHead, rebasedSha], { allowFail: true })).stdout.trim().split('\n').filter(Boolean).sort();
    const ok = await updateRefCas(repo, this.ref, squashSha, expectedHead);
    crashPoint('verify.afterPublish');
    if (!ok) return { kind: 'requeue' };
    if (this.origin) {
      this.origin.inFlight = squashSha;
      try {
        const pushed = await this.origin.pushBranch(squashSha, expectedHead);
        if (!pushed.ok) {
          // Undo the local swap, whatever the cause: the clone never keeps a squash origin did not take.
          await updateRefCas(repo, this.ref, expectedHead, squashSha);
          return pushRequeue(this.origin.remote, `push of ${squashSha} (lease on ${expectedHead})`, pushed);
        }
      } finally {
        this.origin.inFlight = undefined;
      }
    }
    await this.syncPrimaryWorktree();
    return { kind: 'published', publishedSha: squashSha, verifiedSha: rebasedSha, changedFiles };
  }

  /** The ref moved by CAS; bring the primary clone's index and tree along. Never used for work. */
  protected async syncPrimaryWorktree(): Promise<void> {
    const head = (await git(this.opts.repo, ['symbolic-ref', '--quiet', 'HEAD'], { allowFail: true })).stdout.trim();
    if (head === this.ref) await git(this.opts.repo, ['reset', '--quiet', '--hard', 'HEAD'], { allowFail: true });
  }

  /**
   * Fetch, then bring the clone to origin: fast-forward when behind, push the clone's publications when ahead.
   * A launch already on origin (a push whose answer was lost) is published as found; a diverged clone fails the job.
   */
  protected async startFromOrigin(job: VerifierJob): Promise<{ kind: 'head'; head: string } | { kind: 'done'; outcome: VerifierOutcome }> {
    const origin = this.origin as Origin;
    try {
      await origin.fetch();
    } catch (err) {
      if (err instanceof OriginConfigError) throw err;
      // A fetch origin refused (an expired or revoked credential, a missing permission) counts against
      // git.pushRefusalLimit; one that did not reach origin is retried without a limit.
      // See specs/integration-pipeline "Fetch failures are classified".
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof OriginFetchError && err.kind === 'refused') {
        const message = `fetch from ${origin.remote} was refused: ${detail}`;
        return { kind: 'done', outcome: { kind: 'requeue', reason: message, retry: { kind: 'refused', message } } };
      }
      const message = `fetch from ${origin.remote} could not reach it: ${detail}`;
      return { kind: 'done', outcome: { kind: 'requeue', reason: message, retry: { kind: 'unreachable', message } } };
    }
    const remote = await origin.head();
    if (remote) {
      const landed = await findTrailer(this.opts.repo, origin.trackingRef, TRAILER_LAUNCH, job.launchId);
      if (landed) {
        await this.fastForwardTo(remote);
        return { kind: 'done', outcome: { kind: 'published', publishedSha: landed, verifiedSha: landed } };
      }
    }
    const local = await origin.localHead();
    const rel = await origin.relation(local, remote);
    if (rel === 'behind') {
      await this.fastForwardTo(remote as string);
      return { kind: 'head', head: remote as string };
    }
    if (rel === 'ahead' || rel === 'noRemoteBranch') {
      return this.catchUp(job, local, remote);
    }
    if (rel === 'diverged') {
      const diverged = `the clone's ${this.opts.integrationBranch} (${local}) and ${origin.trackingRef} (${remote}) have diverged; reconcile them by hand`;
      return {
        kind: 'done',
        outcome: {
          kind: 'failed',
          reason: { kind: 'checkFailed', message: diverged, output: diverged },
        },
      };
    }
    return { kind: 'head', head: local };
  }

  /**
   * The clone is ahead of origin: publications made before pushing was on. Only commits that are publications (a
   * launch trailer, or older than the baseline) are pushed; a commit made in the clone by hand is never published by a
   * catch-up and stays reported as foreign. This job's own squash at the clone's tip (left by a daemon that died before
   * its push) is published by the catch-up itself, so the sealed branch is never rebased onto its own squash.
   * See specs/integration-pipeline "Catch-up push publishes publications only".
   */
  private async catchUp(job: VerifierJob, local: string, remote: string | undefined): Promise<{ kind: 'head'; head: string } | { kind: 'done'; outcome: VerifierOutcome }> {
    const origin = this.origin as Origin;
    const range = remote ? [local, `^${remote}`] : [local];
    if (this.opts.baselineSha) range.push(`^${this.opts.baselineSha}`);
    const ahead = (await git(this.opts.repo, ['rev-list', '--first-parent', ...range], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
    const foreign: string[] = [];
    let own: string | undefined;
    for (const sha of ahead) {
      const launch = (await commitTrailers(this.opts.repo, sha))[TRAILER_LAUNCH];
      if (!launch) foreign.push(sha);
      else if (launch === job.launchId) own = sha;
    }
    if (foreign.length) {
      const message = `the clone's ${this.opts.integrationBranch} holds ${foreign.length} commit(s) that ${origin.remote} lacks and that carry no ${TRAILER_LAUNCH} trailer (${foreign.slice(0, 5).join(', ')}); they are not pushed. Push or drop them by hand.`;
      return { kind: 'done', outcome: { kind: 'requeue', reason: message, retry: { kind: 'refused', message } } };
    }
    if (own && own !== local) {
      const message = `launch ${job.launchId}'s squash ${own} is in the clone below other unpushed commits (tip ${local}); reconcile the clone with ${origin.remote} by hand`;
      return { kind: 'done', outcome: { kind: 'requeue', reason: message, retry: { kind: 'refused', message } } };
    }
    const pushed = await origin.pushBranch(local, remote);
    if (!pushed.ok) return { kind: 'done', outcome: pushRequeue(origin.remote, `catch-up push of ${local}`, pushed) };
    if (own) {
      await this.syncPrimaryWorktree();
      return { kind: 'done', outcome: { kind: 'published', publishedSha: own, verifiedSha: job.verifiedSha ?? own } };
    }
    return { kind: 'head', head: local };
  }

  /** Move the clone's integration branch forward to `sha` and bring the primary worktree along. */
  private async fastForwardTo(sha: string): Promise<void> {
    const local = await revParse(this.opts.repo, this.opts.integrationBranch);
    if (local === sha) return;
    if (!(await (this.origin as Origin).isAncestor(local, sha))) return;
    if (await updateRefCas(this.opts.repo, this.ref, sha, local)) await this.syncPrimaryWorktree();
  }

  async recoverPublishing(job: VerifierJob, opts: { originUnreachable?: boolean } = {}): Promise<'published' | 'requeue'> {
    if (this.origin) return this.recoverPublishingFromOrigin(job, opts.originUnreachable === true);
    const found = await findTrailer(this.opts.repo, this.opts.integrationBranch, TRAILER_LAUNCH, job.launchId);
    if (found) {
      await this.syncPrimaryWorktree();
      return 'published';
    }
    return 'requeue';
  }

  /**
   * Origin first: the launch trailer on origin means published. On the clone alone means the daemon died between
   * its compare-and-swap and the push: push the recorded squash once, with the lease the job started from. Any other
   * end (a lost lease, a refusal, an unreachable origin) undoes the local swap and requeues: the clone never keeps an
   * unpushed squash at its tip, and the next run finds a push that did land on origin by its trailer.
   * See specs/crash-recovery "Publishing recovery while origin is unreachable".
   */
  private async recoverPublishingFromOrigin(job: VerifierJob, unreachable: boolean): Promise<'published' | 'requeue'> {
    const origin = this.origin as Origin;
    let fetched = !unreachable;
    if (fetched) {
      try {
        await origin.fetch();
      } catch {
        fetched = false;
      }
    }
    if (!fetched) {
      await this.undoSwap(job);
      return 'requeue';
    }
    const remote = await origin.head();
    if (remote && (await findTrailer(this.opts.repo, origin.trackingRef, TRAILER_LAUNCH, job.launchId))) {
      await this.fastForwardTo(remote);
      return 'published';
    }
    const local = await findTrailer(this.opts.repo, this.opts.integrationBranch, TRAILER_LAUNCH, job.launchId);
    if (!local || !job.squashSha || local !== job.squashSha) {
      return 'requeue';
    }
    const expected = job.expectedHead;
    if (expected && remote === expected) {
      if ((await origin.pushBranch(job.squashSha, remote)).ok) {
        await this.syncPrimaryWorktree();
        return 'published';
      }
    }
    // Origin moved past the job's expected head, or refused or did not answer: undo the swap if it is still the tip.
    await this.undoSwap(job);
    return 'requeue';
  }

  /** Put the clone's integration branch back on the job's expected head when the job's squash is still its tip. */
  private async undoSwap(job: VerifierJob): Promise<void> {
    if (!job.expectedHead || !job.squashSha) return;
    if (await updateRefCas(this.opts.repo, this.ref, job.expectedHead, job.squashSha)) await this.syncPrimaryWorktree();
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

  /**
   * Without an origin, commits since the baseline lacking the launch trailer. With one, origin is the source of
   * truth and commits that arrive there are expected: only commits on the clone that origin lacks are considered.
   */
  async foreignCommits(): Promise<string[]> {
    const range = [this.opts.integrationBranch];
    if (this.opts.baselineSha) range.push(`^${this.opts.baselineSha}`);
    if (this.origin && (await this.origin.head())) range.push(`^${this.origin.trackingRef}`);
    const list = (await git(this.opts.repo, ['rev-list', '--first-parent', '-n', '500', ...range], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
    const foreign: string[] = [];
    for (const sha of list) {
      const trailers = await commitTrailers(this.opts.repo, sha);
      if (!trailers[TRAILER_LAUNCH]) foreign.push(sha);
    }
    return foreign;
  }

  protected get maxOut(): number {
    return this.opts.maxOutputBytes ?? 64 * 1024;
  }
}

/** The outcome of a failed push: a lost lease requeues at once; a refusal or an unreachable origin requeues after a backoff. */
function pushRequeue(remote: string, what: string, pushed: Exclude<PushResult, { ok: true }>): VerifierOutcome {
  if (pushed.kind === 'lease') return { kind: 'requeue', reason: `${what} to ${remote}: lease failed, origin moved` };
  const reason = pushed.kind === 'refused' ? `${what} was refused by ${remote}: ${pushed.message}` : `${what} could not reach ${remote}: ${pushed.message}`;
  return { kind: 'requeue', reason, retry: { kind: pushed.kind, message: reason } };
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/**
 * Rebase the sealed range onto `expectedHead` in `dir`, a worktree whose `HEAD` is `expectedHead`, detached. The range
 * starts from the merge base of `expectedHead` and `sealedSha` (or `baseSha` when there is none), so a branch the agent
 * already rebased onto a newer head does not replay published commits. A failed rebase is aborted first.
 */
export async function rebaseSealed(
  dir: string,
  expectedHead: string,
  sealedSha: string,
  baseSha: string,
  maxOut: number,
): Promise<{ kind: 'rebased'; rebasedSha: string } | { kind: 'conflict'; files: string[] } | { kind: 'failed'; output: string }> {
  // Rebase from the merge base so a branch the agent already rebased onto a newer head does not replay published commits.
  const mergeBase = (await git(dir, ['merge-base', expectedHead, sealedSha], { allowFail: true })).stdout.trim() || baseSha;
  const rebase = await git(dir, ['rebase', '--onto', 'HEAD', mergeBase, sealedSha], { allowFail: true, env: identity });
  if (rebase.code !== 0) {
    const unmerged = (await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
    await git(dir, ['rebase', '--abort'], { allowFail: true });
    await git(dir, ['checkout', '--quiet', '--detach', expectedHead], { allowFail: true });
    if (unmerged.length || /CONFLICT|conflict/i.test(rebase.stdout + rebase.stderr)) {
      return { kind: 'conflict', files: unmerged };
    }
    return { kind: 'failed', output: tail(rebase.stderr || rebase.stdout, maxOut) };
  }
  const rebasedSha = await revParse(dir, 'HEAD');
  return { kind: 'rebased', rebasedSha };
}

/**
 * Run a command in `cwd` with the check environment. With `label` it is started as
 * `/bin/sh -c '/bin/sh -c "$1"; exit $?' <label> <command>`, so the label is on the outer shell's command line. An
 * aborted `signal` before the spawn starts nothing; after it, the process group is killed as at the timeout. With
 * `closeWaitMs`, after a kill it resolves that many milliseconds later when `close` has not come by then.
 */
export async function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOut: number,
  dataDir: string,
  opts: { label?: string; signal?: AbortSignal; closeWaitMs?: number } = {},
): Promise<{ code: number | null; timedOut: boolean; aborted?: boolean; spawnError?: boolean; output: string }> {
  type RunCheckResult = { code: number | null; timedOut: boolean; aborted?: boolean; spawnError?: boolean; output: string };
  const { label, signal, closeWaitMs } = opts;
  if (signal?.aborted) return { code: null, timedOut: false, aborted: true, output: '' };
  return new Promise((resolve) => {
    const args = label === undefined ? ['-c', command] : ['-c', '/bin/sh -c "$1"; exit $?', label, command];
    // Repository code runs here: same isolation as a spawned agent. See specs/integration-pipeline "Check environment".
    const child = spawn('/bin/sh', args, { cwd, env: childEnv(dataDir, identity), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let closeWait: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString('utf8'), maxOut);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (result: RunCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeWait) clearTimeout(closeWait);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...result, ...(aborted ? { aborted: true } : {}) });
    };
    const kill = () => {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // A process outside the group that holds the output pipe keeps `close` from coming: stop waiting after closeWaitMs.
      if (closeWaitMs !== undefined && !closeWait) {
        closeWait = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: null, timedOut, output });
        }, closeWaitMs);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      finish({ code, timedOut, output });
    });
    child.on('error', (err) => {
      finish({ code: null, timedOut, spawnError: true, output: `${output}\n${String(err)}` });
    });
  });
}
