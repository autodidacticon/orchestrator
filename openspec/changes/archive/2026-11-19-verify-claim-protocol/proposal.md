## Why

Every verify job runs inside the daemon: the tick starts the oldest `queued` job, and the in-process backend rebases the sealed commit and runs the check command in the daemon's own container. The M5 verifier pool moves the rebase and the check to verifier pods, and no route lets a process outside the daemon take a job, keep it, hand it back or report on it. This change adds the daemon side of that protocol (GH-30), which the remote backend (#32), the verifier loop (#33) and its Deployment (#35) build on.

## What Changes

- A verify job gains four optional fields in its JSON document: `offer`, `token`, `verifier` and `result`. No store method, column or migration is added.
- `POST /v1/verify/claims` hands the oldest claimable job to a verifier with a per-job bearer token and a lease, or the job the verifier already holds (`repeated: true`, lease renewed). A claim that grants nothing writes nothing.
- `POST /v1/verify/:jobId/heartbeat`, `/result` and `/release` take the job token from `Authorization: Bearer`. A result is stored once and leaves the job `checking`; a release hands the claim back.
- The tick ends a verify lease that has run out (`verify.leaseExpired`), first in its verification phase; a gap in the daemon's clock renews every verify lease in the transaction that writes the gaps.
- In-memory waiters (`verifyJobChanged`, `wakeVerifyWaiters`) let the remote backend wait for a claim or a result.
- New events: `verify.claimed`, `verify.result`, `verify.released`, `verify.leaseExpired`; none carries the job token or the output.

Nothing offers a job until #32, so with this change alone every claim answers 404 and the daemon verifies as before. Verification stays one job at a time.

## Capabilities

### New Capabilities
- `verifier-pool`: the verify-job offer, claim, job token, lease, result and release.

### Modified Capabilities
None. integration-pipeline "Verifier serialization and job states" stays as written.

## Impact

- Code: `src/state/store.ts` (`VerifierJob` fields), new `src/verify/claims.ts` and `src/verify/routes.ts`, one call each in `src/loop/orchestrator.ts` (`recordGaps`; `workerRepoUrl` no longer private), `src/loop/tick.ts` (`drainVerification`) and `src/operator/routes.ts` (`registerOperatorRoutes`).
- Tests: `test/loop/verify-claims.test.ts`, `test/slice/verify-routes.test.ts`, `test/state/verify-job-fields.test.ts`.
- Follow-ups: state-backend "Storable ids" does not yet list `POST /v1/verify/claims`; the deploy notes count only the launch token until #35; in M6 #34 puts a verifier token on the claim route.
