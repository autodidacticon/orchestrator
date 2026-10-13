import type { Id } from '../graph/model.js';
import type { VerifierJob } from '../state/store.js';
import type { VerifierBackend, VerifierContext, VerifierOutcome } from './job.js';

export type FakeOutcome = VerifierOutcome | ((job: VerifierJob) => VerifierOutcome);

/** Scripted verifier for logic tests. Default outcome: published. */
export class FakeVerifierBackend implements VerifierBackend {
  readonly script = new Map<Id, FakeOutcome[]>();
  readonly runs: VerifierJob[] = [];
  private counter = 0;
  /** Simulated integration head, advanced on publish. */
  head = 'head0';

  on(taskId: Id, ...outcomes: FakeOutcome[]): void {
    this.script.set(taskId, [...(this.script.get(taskId) ?? []), ...outcomes]);
  }

  async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    this.runs.push(job);
    ctx.progress({ status: 'checking', expectedHead: this.head });
    const queue = this.script.get(job.taskId);
    const next = queue?.shift();
    const outcome: VerifierOutcome =
      next === undefined
        ? { kind: 'published', publishedSha: `pub-${job.taskId}-${++this.counter}`, verifiedSha: `ver-${job.taskId}`, changedFiles: [`${job.taskId}.txt`] }
        : typeof next === 'function'
          ? next(job)
          : next;
    if (outcome.kind === 'published') {
      ctx.progress({ status: 'verified', verifiedSha: outcome.verifiedSha });
      ctx.progress({ status: 'publishing', squashSha: outcome.publishedSha });
      this.head = outcome.publishedSha;
    }
    return outcome;
  }
}
