## 1. Bounded remote commands

- [x] 1.1 `git()` takes `timeoutMs`: the command runs in its own process group, the group is killed on timeout, and the result says `timedOut`
- [x] 1.2 `Origin` applies `git.remoteTimeoutMs` to fetch, push and `ls-remote`, and exposes `busy`
- [x] 1.3 `maybeFetch` skips while origin is busy; `tagMilestone` leaves the tag push to a later tick while origin is busy
- [x] 1.3a A fetch or tag push the tick starts itself is awaited at most `tickWaitMs` (1 s) and runs on; recovery's `integrationHead({ awaitFetch: true })` waits in full
- [x] 1.4 Slice tests: a stalled push is killed with its helper, ticks stay fast meanwhile, and the task publishes afterwards; a stalled fetch and a stalled tag push time out

## 2. Classified push failures

- [x] 2.1 `pushBranch` returns `lease | refused | unreachable` with git's message (read under `LC_ALL=C`)
- [x] 2.2 The verifier returns `requeue` with `retry` for a refusal or an unreachable origin (a failed fetch included), and undoes the local swap for every failed push
- [x] 2.3 `src/verify/push-retry.ts`: per-job refusals, failures and `retryAt` in the key-value table; doubling backoff capped at 32 times the base
- [x] 2.4 The orchestrator records the retry, skips jobs in backoff, and fails the job as `pushRefused` at `git.pushRefusalLimit`; `drainVerification` blocks the task through `submitted -> blocked` (verifier, `pushRefused`)
- [x] 2.5 Slice and unit tests: refusals back off and block with the hook's text and no attempt spent; an unreachable origin never blocks; the classifier on real git messages

## 3. Recovery and catch-up

- [x] 3.1 Recovery always calls `recoverPublishing`, passing `originUnreachable`; the backend undoes the swap whenever it cannot confirm the push
- [x] 3.2 The catch-up push sends publications only; foreign commits count as a refusal; the job's own squash at the tip is published by the catch-up
- [x] 3.3 Slice tests: a two-commit, one-file task killed after the swap and restarted while origin is unreachable is done exactly once after origin returns; a commit made by hand in the clone is not pushed and stays foreign

## 4. Milestone tags

- [x] 4.1 `tagMilestone` returns a `clone` conflict instead of throwing, and does not push it
- [x] 4.2 The tick, `pushMilestoneTags` and recovery record the outcome through `recordTagPush`, once
- [x] 4.3 Slice tests: with pushing on and off, a tag the clone holds at another sha is one `milestone.tagConflict` across ticks, a kill after tagging, and restarts

## 5. Settings and spec

- [x] 5.1 `git.remoteTimeoutMs`, `git.pushRefusalLimit` and `git.pushRetryBackoffMs` in `src/config.ts`
- [x] 5.2 `pushRefused` blocked kind and transition row; spec deltas validated with `openspec validate origin-failure-paths --strict`
