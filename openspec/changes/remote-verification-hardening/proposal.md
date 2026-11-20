## Why

The review of the M5 Verifier pool milestone (GH-184, follow-up of #30, #32 and #180) found no defect that loses or wrongly publishes work, but found these gaps in remote verification:

- The verify ref was deleted before the outcome was written. A daemon that died in between left a kept offer whose resumed run found no ref.
- `failVerifierJob`'s last write did not check that the job was still live. A crash of a run whose job a cascade had dropped wrote `failed` over the dropped, applied row.
- A lease expiry or a release put the job on offer again without counting anything. A job that crashes its verifier cycled forever.
- `conflictFiles`, the release `reason` and `verifierId` had no size limit.
- `Origin.deleteRef` refused the integration branch with an exact string compare. On a case-insensitive filesystem `refs/heads/MAIN` named `main`.

## What Changes

- **The ref outlives the outcome.** The daemon deletes `refs/verify/<jobId>` after it has written the run's outcome, through the new `VerifierBackend.afterOutcome` hook. A run that ends with nothing written (a stop, a fatal store, a kill) keeps the ref for the resumed run.
- **Guarded failed write.** `failVerifierJob` writes nothing for a job that is dropped or applied.
- **A cap on lease cycles.**
  - A job counts its lease expiries and its releases with reason `verifierError` in `leaseLosses`.
  - The third loss ends it `failed` with `failureKind` `verifierLost` and an output that names the count. The task spends an attempt.
  - A `podTerminating` release is not counted.
  - The remote wait ends when its row leaves `checking`.
- **Size limits.**
  - A release `reason` is cut to 4096 characters.
  - A result's `conflictFiles` keeps its first 200 entries.
  - A `verifierId` over 253 characters answers 400.
- **`deleteRef` takes only verify refs.** `deleteRef` refuses any name outside `refs/verify/`.
- **One write for a requeue.** The push-retry state, the `verify.requeued` event and the row are written in one transaction. A crash between them never charges a refusal twice for one result.
- **Failure kind.** `FailedKind` gains `verifierLost`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `verifier-pool`:
  - MODIFIED "Verify ref: deletion", "Verify lease: expiry" and "Verify release" (the last two end the job at the cap).
  - ADDED "Verify ref: deletion: verify refs only", "Remote verification run: the wait: ended job", "Remote verification outcomes: dropped job", "Verify lease: cycle cap", "Verify claim: refusals: long verifierId", "Verify result: body: limits" and "Verify release: reason limit".
- `task-lifecycle`: ADDED "Transition table: verifier outcomes: verifierLost".

## Impact

- `src/verify/remote.ts`, `src/verify/job.ts`, `src/verify/claims.ts`, `src/loop/orchestrator.ts`, `src/workspace/origin.ts`, `src/state/status.ts` and `src/state/store.ts`.
- Tests:
  - `test/slice/remote-verifier.test.ts`: five cases, and three existing cases now wait for the run to end before they check the ref.
  - `test/loop/verify-claims.test.ts`: four cases.
  - `test/slice/origin-ref.test.ts`: two cases.
