## Why

The review of CLOUD-M2 v1 (rejected 2026-11-13 at 5c427c4) found two holes in "anything with an outside effect waits until its record is durable" (ORC-86). The verifier records `publishing` and then moves the integration branch and pushes to origin at once: `gateOnDurable` waits only when `run` is entered, so with a stalled sink the push lands during the stall. If the daemon then dies, Postgres holds the job as `checking` or `verified`, and startup on a fresh clone (`store-selection`) drops it as `commitLost` without looking on origin: the task runs again although its commit is published. A job durable as `publishing` takes the same path when the one fetch at recovery fails.

## What Changes

- The verifier context gains an awaitable `durable()`. The verifier awaits it once, between the `publishing` record and the compare-and-swap. The orchestrator's callback waits for `store.durable()`. It throws `StoreFatalError` when the journal goes fatal: no swap, no push, and nothing recorded. It throws `JobDroppedError` when a cascade dropped the job meanwhile. Other progress records are not gated.
- Recovery, with `git.pushIntegration` on, fetches origin once and records every unapplied `queued`, `checking`, `verified` or `publishing` job whose `Orchestrator-Launch` trailer is on origin's integration branch as `published` at that commit. Only a job with no trailer on origin and no sealed commit is `commitLost`.
- A failed fetch at recovery decides nothing: the publishing push recovery is skipped, every undecided job is queued and deferred, and the orchestrator runs a resolution pass in the verifier slot (at most once a second) until origin answers. A deferred job is not handed to the verifier, where a missing sealed commit would fail as `checkFailed` and spend an attempt.
- The shared `Origin` is kept on the orchestrator (`o.origin`), so the lookup does not depend on the verifier backend.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `integration-pipeline`: the durability wait before publication.
- `crash-recovery`: the origin lookup before `commitLost`, and the failed fetch.

## Impact

- Code: `src/verify/job.ts`, `src/verify/verifier.ts`, `src/loop/orchestrator.ts`, `src/launch/recovery.ts`.
- Tests: new `test/slice/durable-publish.test.ts`.
- With `store.kind: sqlite` the store is always durable and the wait returns at once. With `git.pushIntegration` off there is no origin and recovery is unchanged.
