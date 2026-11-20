## Why

On SIGTERM the verifier loop (#33) should kill the check, hand its job back and exit 0 within the pod's 30 s grace (owner, 2026-11-19). The M5 review found three ways it misses that (GH-183): a result post refused after the signal ends the loop with no release, so the job stays leased for `leaseTtlMs`; a signal during the 1000 ms pause between result posts still gets one more post; and a call already in flight keeps its full retry window (`ORCH_RETRY_WINDOW_MS`, 60 s by default), with `fetch` given no timeout. The worker loop shares the third.

## What Changes

- `src/worker/http.ts`: `apiClient` takes the loop's `termination` signal. The signal aborts the fetch in flight of every call through the `AbortSignal` passed to `fetch`; the call is then retried with no more than `TERMINATION_CALL_MS` (5000 ms, now defined here and re-exported by `src/worker/terminate.ts`) left. A call started after the signal gets the smaller of the retry window and 5000 ms. Every fetch is aborted once the call's remaining window has passed, but no sooner than 5000 ms (before the signal) or 1000 ms (after it).
- `src/verifier/loop.ts` and `src/worker/loop.ts` build one such client instead of a long and a short one.
- Verifier loop: `requested()` is tested again after the pause between result posts; a post refused after the signal (400, 5xx, no answer) is followed by a release with `podTerminating`, then exit 0.
- Worker loop: a claim that gets no answer after the signal exits 0 instead of rejecting the loop.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `verifier-pool`: MODIFIED `Verifier termination` and `Verifier termination: job in progress`; ADDED `Verifier termination: refused result post` and `Verifier termination: bounded calls`.
- `worker-pool`: MODIFIED `Pod termination` (scenarios `Claim in flight`, the new `Claim never answered`, and `Bounded calls after the signal`).

## Impact

- Code: `src/worker/http.ts`, `src/worker/terminate.ts`, `src/worker/loop.ts`, `src/verifier/loop.ts`.
- Tests: `test/verifier/loop.test.ts` (six cases under "bounded shutdown"), `test/worker/loop.test.ts` (one case).
- Not in this change (local runs only): a push in flight at SIGTERM can outlive the process, and the start-up sweep takes no lock; in a pod, container teardown and the per-pod emptyDir cover both.
