## 1. Code

- [x] 1.1 `Origin.listVerifyRefs` reads origin's refs under `refs/verify/` with `ls-remote`
- [x] 1.2 `RemoteVerifierBackend.sweepVerifyRefs`, gated in `VERIFIER_METHODS`, called by recovery under `verifier.mode: remote` once the verifier jobs are settled
- [x] 1.3 `afterOutcome` also deletes the ref of a waited run whose job has ended (`verifyJobEnded`)
- [x] 1.4 Log an error thrown by `failVerifierJob` with its own message
- [x] 1.5 `claims.ts` imports `VERIFIER_ERROR`; the `OriginFetchError` doc comment moves back
- [x] 1.6 Cut each `conflictFiles` entry to 4096 characters; answer 413 to a request body over 1 MiB

## 2. Tests

- [x] 2.1 Slice: the three leftover paths, each swept at the next start
- [x] 2.2 Slice: a cancel deletes the ref when the wait ends; the sweep keeps refs of live jobs and of no job
- [x] 2.3 Slice: the `failVerifierJob` log message
- [x] 2.4 Loop: a 10,000-character `conflictFiles` entry; server: the 413
