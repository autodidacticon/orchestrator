## 1. Code

- [x] 1.1 `src/state/store.ts`: optional `gapRequeues` on `VerifierJob`
- [x] 1.2 `src/loop/orchestrator.ts`: note the clock and take `startedAt` before a verifier run; `failVerifierJob` for the `failed` outcome and the thrown run, re-queueing once across a gap in one transaction

## 2. Spec and docs

- [x] 2.1 `integration-pipeline`: ADDED "Failed check across a gap"
- [x] 2.2 README Health paragraph

## 3. Tests

- [x] 3.1 `test/loop/check-gap.test.ts`: timeout, non-zero exit and thrown run across a gap; once only; the re-run waits for the hold; no gap; a gap before the run; `health.gapAfterMs: 0`; a conflict after a gap; another failure kind after a gap
