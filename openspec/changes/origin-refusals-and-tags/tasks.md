## 1. Fetch refusals

- [x] 1.1 `classifyFetchFailure` and `OriginFetchError` in `src/workspace/origin.ts`; `fetch` throws the classified error
- [x] 1.2 `startFromOrigin` requeues a refused fetch with retry kind `refused` and a message naming the refusal; an unreachable fetch keeps kind `unreachable`

## 2. Slow tag pushes

- [x] 2.1 `Origin.pushTagFromTick` keeps the tick's tag push and its outcome; a later call answers from it, waits on it while it runs, or pushes again after a failure

## 3. Local tags with pushing off

- [x] 3.1 The tick's tag pass re-creates a missing local tag with `git.pushIntegration` off and records `tagLocal:<id>:<version>`; a tag created when the milestone is submitted is recorded the same way

## 4. Push retry state

- [x] 4.1 `clearPushRetry` empties `pushRetry:<jobId>` in the transaction that applies the job

## 5. Spec

- [x] 5.1 ADDED `integration-pipeline` "Fetch failures are classified", "A slow tag push is confirmed when it completes", "A failed local tag is retried" and "Push retry state ends with its job"

## 6. Tests

- [x] 6.1 A refused fetch blocks at `git.pushRefusalLimit` with a message naming the refusal; an unreachable fetch is retried past the limit and never blocks; fetch stderr is classified
- [x] 6.2 A tag push slower than the tick wait is recorded as pushed with one push (slice and `Origin`)
- [x] 6.3 With pushing off, a tag that failed to be created in the clone is created on a later tick
- [x] 6.4 The retry state is gone once the job is applied, on the published and the `pushRefused` paths
