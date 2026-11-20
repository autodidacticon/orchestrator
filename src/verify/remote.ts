/**
 * Remote verifier backend (`verifier.mode: remote`). The daemon syncs with origin as the in-process backend does, then
 * offers the job over its API and waits for the result a verifier stores (src/verify/claims.ts). A `verified` result is
 * checked against `refs/verify/<jobId>` on origin, then squashed and published as today. The daemon makes no
 * worktree and runs neither the check nor the prepare command. See specs/verifier-pool.
 */
import type { Logger } from '../loop/core.js';
import type { VerifierJob } from '../state/store.js';
import { git } from '../workspace/git.js';
import { classifyFetchFailure, classifyPushFailure, OriginFetchError, VERIFY_REF_PREFIX } from '../workspace/origin.js';
import type { VerifierContext, VerifierOutcome } from './job.js';
import { GitVerifierBackend, type GitVerifierOptions } from './verifier.js';

export interface RemoteVerifierOptions extends GitVerifierOptions {
  /** The clock `offer.at` is read from; `Date.now` when unset. The daemon passes its own clock. */
  now?: () => number;
  log?: Logger;
}

type VerifyResult = NonNullable<VerifierJob['result']>;

/** The characters of a verifier's output that an origin failure's reason keeps. */
const ORIGIN_OUTPUT_TAIL = 4000;

const silent: Logger = { info() {}, warn() {}, error() {} };

/** The ref a verifier pushes its rebased commit to. */
export const verifyRefOf = (jobId: string): string => `${VERIFY_REF_PREFIX}${jobId}`;

export class RemoteVerifierBackend extends GitVerifierBackend {
  private readonly now: () => number;
  private readonly log: Logger;
  /** Jobs whose run read a `verified` result: their verify ref is deleted once the outcome is written. */
  private readonly refsToDelete = new Set<string>();
  /** Jobs whose run waited for a result: a verifier may have pushed their verify ref. */
  private readonly offered = new Set<string>();

  constructor(opts: RemoteVerifierOptions) {
    const { now, log, ...rest } = opts;
    super(rest);
    this.now = now ?? Date.now;
    this.log = log ?? silent;
  }

  override async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    if (!this.origin) throw new Error('remote verifier: no origin (verifier.mode remote needs git.pushIntegration)');
    if (!ctx.awaitResult) throw new Error('remote verifier: the verifier context has no awaitResult');
    let expectedHead: string;
    if (job.offer !== undefined && job.expectedHead !== undefined) {
      // A resumed job: the stored head and check command hold; no sync and no new offer.
      expectedHead = job.expectedHead;
    } else {
      const checkCommand = typeof this.opts.checkCommand === 'function' ? this.opts.checkCommand() : this.opts.checkCommand;
      const start = await this.startFromOrigin(job);
      if (start.kind !== 'head') return start.outcome;
      expectedHead = start.head;
      // Declared no-op: published at the head with no offer, as the in-process no-op is.
      if (job.sealedSha === job.baseSha) {
        ctx.progress({ status: 'checking', expectedHead });
        ctx.progress({ status: 'verified', verifiedSha: expectedHead });
        return { kind: 'published', publishedSha: expectedHead, verifiedSha: expectedHead };
      }
      if (checkCommand === undefined) {
        return { kind: 'failed', reason: { kind: 'checkFailed', message: 'no check command is configured for this repository', output: '' } };
      }
      ctx.progress({ status: 'checking', expectedHead, offer: { at: this.now(), checkCommand } });
    }
    this.offered.add(job.jobId);
    const result = await ctx.awaitResult();
    return this.outcomeOf(job, ctx, expectedHead, result);
  }

  /**
   * Called by the daemon once the run's outcome (or its failure) is written, or the job was found no longer live
   * (`written` true), or when nothing was written because the daemon stops or the store went fatal (`written` false).
   * After a run that read a `verified` result, or a run that waited for a result and whose job has `ended` (a job that
   * lost its verifier, a dropped job), a written outcome deletes `refs/verify/<jobId>` on origin and in the clone; a
   * failed deletion is logged as a warning and changes nothing else. Without a write the ref is kept.
   */
  async afterOutcome(job: VerifierJob, opts: { written: boolean; ended?: boolean }): Promise<void> {
    const read = this.refsToDelete.delete(job.jobId);
    const waited = this.offered.delete(job.jobId);
    if (!opts.written || !this.origin) return;
    if (!read && !(waited && opts.ended === true)) return;
    await this.deleteVerifyRef(job.jobId);
  }

  /**
   * At startup recovery: list origin's refs under `refs/verify/` and delete each whose job has ended (applied,
   * `published`, `failed` or `dropped`), as the daemon reads the job's row. A ref of a job that is not ended, or of no
   * job, is kept. A failed listing or deletion is logged as a warning; the next start tries again.
   * See specs/verifier-pool "Verify ref: deletion: sweep".
   */
  async sweepVerifyRefs(ended: (jobId: string) => boolean): Promise<void> {
    if (!this.origin) return;
    let refs: string[];
    try {
      refs = await this.origin.listVerifyRefs();
    } catch (err) {
      this.log.warn('verify refs could not be listed; the sweep is tried again at the next start', { err: String(err) });
      return;
    }
    for (const ref of refs) {
      const jobId = ref.slice(VERIFY_REF_PREFIX.length);
      if (!jobId || !ended(jobId)) continue;
      await this.deleteVerifyRef(jobId);
    }
  }

  private async deleteVerifyRef(jobId: string): Promise<void> {
    const ref = verifyRefOf(jobId);
    try {
      await this.origin!.deleteRef(ref);
    } catch (err) {
      this.log.warn('verify ref could not be deleted; the sweep at the next start tries again', { jobId, ref, err: String(err) });
    }
  }

  private async outcomeOf(job: VerifierJob, ctx: VerifierContext, expectedHead: string, result: VerifyResult): Promise<VerifierOutcome> {
    switch (result.outcome) {
      case 'checkFailed':
      case 'checkTimeout':
        return { kind: 'failed', reason: { kind: result.outcome, message: `check ${result.outcome} on verifier ${result.verifierId}`, output: result.output } };
      case 'rebaseFailed':
        return { kind: 'failed', reason: { kind: 'checkFailed', message: 'rebase failed', output: result.output } };
      case 'conflict':
        return { kind: 'conflict', files: [...result.conflictFiles], since: await ctx.publishedSince(job.baseSha) };
      case 'originFailed':
        return originFailed(result);
      case 'verified': {
        // The ref is deleted by `afterOutcome`, once the daemon has written the outcome: a crash before the write
        // leaves it for the resumed run. See specs/verifier-pool "Verify ref: deletion".
        this.refsToDelete.add(job.jobId);
        return this.publishFromRef(job, ctx, expectedHead, result, verifyRefOf(job.jobId));
      }
    }
    throw new Error(`remote verifier: unknown result outcome ${String((result as { outcome: unknown }).outcome)}`);
  }

  /** Check `refs/verify/<jobId>` on origin against the reported commit and `expectedHead`, then squash and publish. */
  private async publishFromRef(job: VerifierJob, ctx: VerifierContext, expectedHead: string, result: VerifyResult, ref: string): Promise<VerifierOutcome> {
    const origin = this.origin!;
    const rebasedSha = result.rebasedSha as string;
    if (rebasedSha === expectedHead) {
      ctx.progress({ status: 'verified', verifiedSha: expectedHead });
      return { kind: 'published', publishedSha: expectedHead, verifiedSha: expectedHead };
    }
    let tip: string | undefined;
    try {
      tip = await origin.fetchRef(ref);
    } catch (err) {
      if (!(err instanceof OriginFetchError)) throw err;
      const message = `fetch of ${ref} from ${origin.remote} ${err.kind === 'refused' ? 'was refused' : 'could not reach it'}: ${err.message}`;
      return { kind: 'requeue', reason: message, retry: { kind: err.kind, message } };
    }
    const refused = (why: string): VerifierOutcome => {
      const message = `${why}; reported ${rebasedSha} on ${expectedHead} by verifier ${result.verifierId}`;
      return { kind: 'requeue', reason: message, retry: { kind: 'refused', message } };
    };
    if (tip === undefined) return refused(`${origin.remote} has no ${ref}`);
    if (tip !== rebasedSha) return refused(`${ref} on ${origin.remote} holds ${tip}, not the reported ${rebasedSha}`);
    if (!(await origin.isAncestor(expectedHead, rebasedSha))) return refused(`${ref}: ${rebasedSha} does not descend from the expected head ${expectedHead}`);
    ctx.progress({ rebasedSha });
    const { repo } = this.opts;
    const rebasedTree = (await git(repo, ['rev-parse', `${rebasedSha}^{tree}`])).stdout.trim();
    const headTree = (await git(repo, ['rev-parse', `${expectedHead}^{tree}`])).stdout.trim();
    if (ctx.noChanges && rebasedTree === headTree) {
      ctx.progress({ status: 'verified', verifiedSha: expectedHead });
      return { kind: 'published', publishedSha: expectedHead, verifiedSha: expectedHead };
    }
    ctx.progress({ status: 'verified', verifiedSha: rebasedSha });
    return this.publishVerified(job, ctx, expectedHead, rebasedSha, rebasedTree, repo);
  }
}

/**
 * A verifier's `originFailed` result: requeued with `retry`, `refused` when git's output reads as a refused push or
 * fetch, `unreachable` otherwise. See specs/verifier-pool "Remote verification outcomes: origin failures".
 */
function originFailed(result: VerifyResult): VerifierOutcome {
  const output = result.output.length > ORIGIN_OUTPUT_TAIL ? result.output.slice(result.output.length - ORIGIN_OUTPUT_TAIL) : result.output;
  const push = classifyPushFailure(result.output);
  const kind = push === 'refused' || push === 'lease' || classifyFetchFailure(result.output) === 'refused' ? 'refused' : 'unreachable';
  const message = `verifier ${result.verifierId} ${kind === 'refused' ? 'was refused by origin' : 'could not reach origin'}: ${output}`;
  return { kind: 'requeue', reason: message, retry: { kind, message } };
}
