## Why

A check command that was running when the machine slept can fail, by `checkTimeoutMs` (which counts wall time) or because the sleep broke it, and the failure spends an attempt on finished work. In the M2 run a finished task's verification failed while the lid was closed and the task was later blocked as exhausted. ORC-119 (release 0.6.0, task 10) puts such a job back to `queued` once, uncharged, and records why. It builds on the daemon's gap list from `clock-gaps-in-limits` (ORC-112).

## What Changes

- A verifier run that ends `failed` with kind `checkFailed` or `checkTimeout`, or that throws, and whose run overlapped a gap in the daemon's clock is put back to `queued` instead of `failed`. No attempt is spent and the task stays `submitted`.
- The run overlapped a gap when `awakeMs(startedAt, endedAt)` is less than `endedAt - startedAt`, where both instants are read after a note of the clock. The verifier keeps no clock of its own.
- One store transaction appends `verify.requeued` with `jobId`, a `reason` naming the gap and the failure kind, and `gap: { failureKind, gapMs }`, and resets the job as a `requeue` outcome does (`expectedHead`, `rebasedSha`, `verifiedSha`, `squashSha`), with `gapRequeues` raised to 1. Push retry state is not touched.
- Once per job: a job whose `gapRequeues` is 1 is written `failed` as before, gap or no gap. The count is on the job row, so a restart does not reset it.
- Unchanged: `conflict`, `published` and `requeue` outcomes, other failure kinds, a dropped job, a fatal store, the check command's own timer, and `startVerifierIfIdle`'s hold after a gap, which also holds the re-run.

## Capabilities

### New Capabilities

### Modified Capabilities
- `integration-pipeline`: ADDED "Failed check across a gap". "Check and verified tree" keeps its text.

## Impact

- Code: `src/state/store.ts` (`VerifierJob.gapRequeues?`, stored in the job's JSON document, no migration), `src/loop/orchestrator.ts` (`startVerifierIfIdle` notes the clock and takes the run's start; both failure paths go through one helper, `failVerifierJob`).
- Tests: `test/loop/check-gap.test.ts`.
- README: the Health paragraph says a check that fails across a gap is run again once, and no longer lists the check among the losses not covered.
- With `health.gapAfterMs: 0` there are no gaps, so nothing is re-queued by this rule.
- Not proven: that a check resumed after a sleep fails in practice is an inference, not an observation.
