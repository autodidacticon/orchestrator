/**
 * Remote verifier backend (`verifier.mode: remote`). The daemon syncs with origin as the in-process backend does, then
 * offers the job over its API and waits for the result a verifier stores (src/verify/claims.ts). A `verified` result is
 * checked against `refs/verify/<jobId>` on origin, then squashed and published as today. The daemon makes no
 * worktree and runs neither the check nor the prepare command. See specs/verifier-pool.
 */
import type { Logger } from '../loop/core.js';
import type { VerifierJob } from '../state/store.js';
import { git } from '../workspace/git.js';
import { classifyFetchFailure, classifyPushFailure, OriginFetchError } from '../workspace/origin.js';
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
export const verifyRefOf = (jobId: string): string => `refs/verify/${jobId}`;

export class RemoteVerifierBackend extends GitVerifierBackend {
  private readonly now: () => number;
  private readonly log: Logger;

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
    const result = await ctx.awaitResult();
    return this.outcomeOf(job, ctx, expectedHead, result);
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
        const ref = verifyRefOf(job.jobId);
        try {
          return await this.publishFromRef(job, ctx, expectedHead, result, ref);
        } finally {
          // Deleted whatever the outcome, a drop and a fatal store included; a failed deletion changes nothing.
          try {
            await this.origin!.deleteRef(ref);
          } catch (err) {
            this.log.warn('verify ref could not be deleted', { jobId: job.jobId, ref, err: String(err) });
          }
        }
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
