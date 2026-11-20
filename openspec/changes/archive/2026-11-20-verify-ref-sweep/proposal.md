## Why

The review of milestone 18 (M5 follow-ups, GH-190, follow-up of #184 and #187) found that `refs/verify/<jobId>` is deleted only after a run reads a `verified` result. Three paths still leave a ref on origin, and nothing sweeps such refs:

- A job that ends `verifierLost` after its last verifier pushed and then released.
- A daemon killed after the publication push and before the `published` write. Recovery settles the job and deletes nothing.
- A cancel while the run waits after a push.

The review also found four small slips: a mislabeled error log, a duplicated reason string, an orphaned doc comment and two unbounded sizes.

## What Changes

- **Sweep at startup.** Under `verifier.mode: remote`, recovery lists origin's refs under `refs/verify/` once every verifier job is settled. It deletes each ref whose job is applied, `published`, `failed` or `dropped`. A ref of a job that has not ended, or of no job, is kept. A failed listing or deletion is logged as a warning and tried again at the next start. With origin unreachable the sweep waits for the next start. The sweep is gated on durability (`VERIFIER_METHODS`), so the `published` write of recovery is durable before the ref goes.
- **Deletion when a waited run's job ends.** A run that waited for a result and whose job has ended once its outcome is written deletes the ref too: a job that lost its verifier, a dropped job.
- **Small fixes.**
  - An error thrown by `failVerifierJob` is logged as "the failure could not be written", not as an after-outcome failure, and the ref is kept.
  - `src/verify/claims.ts` imports `VERIFIER_ERROR` from `src/verifier/loop.ts`.
  - The doc comment of `OriginFetchError` is back above it.
  - Each `conflictFiles` entry is cut to 4096 characters.
  - The agent server answers 413 to a request body over 1 MiB, and runs no handler.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `verifier-pool`:
  - MODIFIED "Verify result: body: limits" (the entry length).
  - ADDED "Verify ref: deletion: sweep" and "Verify ref: deletion: ended job".
- `agent-protocol`: ADDED "Request body limit".

## Impact

- `src/verify/remote.ts`, `src/verify/job.ts`, `src/verify/claims.ts`, `src/launch/recovery.ts`, `src/loop/orchestrator.ts`, `src/state/gate.ts`, `src/workspace/origin.ts` and `src/agent/server.ts`.
- Tests: `test/slice/remote-verifier.test.ts` (six cases), `test/loop/verify-claims.test.ts` (one case), `test/agent/server.test.ts` (one case). Tests that sent the reason `verifierError` as a literal now use `VERIFIER_ERROR`.
