## 1. Durable publishing record

- [x] 1.1 `VerifierContext.durable?()`; the git verifier awaits it between the `publishing` record and the compare-and-swap
- [x] 1.2 `Orchestrator.waitDurable()` with `StoreFatalError`; the dispatcher records nothing on it; dropped-job re-check after the wait
- [x] 1.3 Slice tests: stalled sink after the check started (no ref move, no push until release); fatal while waiting (refs and origin unchanged)

## 2. Origin lookup before commitLost

- [x] 2.1 The orchestrator keeps the shared `Origin`
- [x] 2.2 Recovery fetches once and records undecided jobs whose launch trailer is on origin as `published` at origin's commit
- [x] 2.3 A failed fetch skips the publishing push recovery and defers queued jobs; `decideJobsOnOrigin` runs in the verifier slot until origin answers
- [x] 2.4 Slice tests: fresh clone with a job stored as `checking`, `verified` or `publishing` whose trailer is on origin; no trailer and no sealed commit; unreachable origin for both outcomes
