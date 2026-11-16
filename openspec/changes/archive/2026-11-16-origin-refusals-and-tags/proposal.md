## Why

The review of CLOUD-M2 v2 (ORC-97) found four gaps in how origin failures are handled, by reading the code:

- `startFromOrigin` turned every failed fetch (other than a missing remote) into a requeue of kind `unreachable`. An expired or revoked credential therefore never counted against `git.pushRefusalLimit`. The job was requeued without end, the task never blocked, and the operator was never told.
- `pushTagFromTick` waited `tickWaitMs` (1 s) and dropped the push it started. No later tick learned the push's outcome. A later tick pushed again, so a tag push that always took longer than the wait was never recorded as pushed.
- With `git.pushIntegration` off, the tag pass returned at once. A milestone tag that failed to be created in the clone was never tried again.
- The `pushRetry:<jobId>` kv entry stayed after its job was applied.

## What Changes

- `src/workspace/origin.ts`: `classifyFetchFailure` reads git's stderr. Failed authentication, a denied permission, an HTTP 401 or 403, and `could not read Username` or `terminal prompts disabled` mean `refused`. Anything else, a timeout included, means `unreachable`. `fetch` throws `OriginFetchError` carrying that kind, and its message is unchanged.
- `src/verify/verifier.ts`: a refused fetch at the start of a job requeues with retry kind `refused`, and the message reads `fetch from <remote> was refused: …`. It counts against `git.pushRefusalLimit` and, at the limit, blocks the task as `pushRefused` with that message. An unreachable fetch keeps retry kind `unreachable` and is retried without a limit.
- `src/workspace/origin.ts`: `Origin` keeps each tag push started from the tick, by tag name, until a later call uses its outcome. A later `pushTagFromTick` for the same tag and sha behaves by state:
  - Still running: it waits on that push and does not start another.
  - Landed: it answers `'pushed'` without pushing again.
  - Failed: it pushes again.
- `src/loop/tick.ts`, with `git.pushIntegration` off: the tag pass re-creates the tag in the clone for every gated `submitted` or `done` milestone whose tag has no record. A tag created by the tick, or by this pass, is recorded as `tagLocal:<id>:<version>`. A conflict is still recorded once under `tagPushed:<id>:<version>` and never retried.
- `src/verify/push-retry.ts` and `src/loop/tick.ts`: `clearPushRetry` empties `pushRetry:<jobId>` in the same transaction that marks the job applied. Readers take an empty entry as no state.

## Capabilities

### New Capabilities

### Modified Capabilities
- `integration-pipeline`: ADDED "Fetch failures are classified", "A slow tag push is confirmed when it completes", "A failed local tag is retried" and "Push retry state ends with its job".

## Impact

- `src/workspace/origin.ts`, `src/verify/verifier.ts`, `src/verify/push-retry.ts`, `src/loop/tick.ts`.
- Tests are in `test/slice/origin-failures.test.ts`:
  - A refused fetch blocks the task at the limit and the message names the refusal.
  - An unreachable fetch is retried past the limit without blocking.
  - Fetch stderr is classified.
  - A tag push slower than the tick wait is recorded once with a single push. Both the slice and `Origin` are tested.
  - With pushing off, a failed local tag is created on a later tick.
  - The retry state is emptied when the job is applied, on both the published and the `pushRefused` paths.
- The `Store` has no kv delete, and adding one would change every backend (`src/state/**`), which is outside this change's scope. So the retry entry is emptied rather than deleted: the row stays with an empty value.
- `GitWorkspace.tagMilestone` still answers `busy` while any remote command runs. A tag push that outlives the wait is confirmed by the first tag call after origin is free, which is the next tick in practice. That call does not push again.
- Startup recovery (`src/launch/recovery.ts`) still marks `tagged:` whatever the tag outcome. With pushing off, the tick's pass does not read `tagged:`, so a tag that recovery failed to create is created by the next tick.
