## 1. Code

- [x] 1.1 Delete the verify ref after the outcome is written (`VerifierBackend.afterOutcome`), and keep it when nothing was written
- [x] 1.2 Skip `failVerifierJob`'s write for a dropped or applied job
- [x] 1.3 Count lease expiries and `verifierError` releases in `leaseLosses`, and end the job `verifierLost` at the third; end the remote wait when the row leaves `checking`
- [x] 1.4 Cut the release `reason` to 4096 characters and `conflictFiles` to 200 entries; refuse a `verifierId` over 253 characters
- [x] 1.5 `deleteRef` refuses any name outside `refs/verify/`
- [x] 1.6 Add `verifierLost` to `FailedKind`
- [x] 1.7 Write the push-retry state, `verify.requeued` and the requeued or blocked row in one transaction

## 2. Tests

- [x] 2.1 Slice: a kill after a refused `verified` result keeps the ref; the resumed run counts the refusal once
- [x] 2.2 Slice: a job dropped while `publishFromRef` runs stays dropped and applied after a non-fetch error
- [x] 2.3 Loop and slice: the lease-cycle cap
- [x] 2.4 Loop: the size limits
- [x] 2.5 Slice: `deleteRef` refusals and a missing verify ref
- [x] 2.6 Slice: a stale token answers 401; a late push is refused by the tip check
- [x] 2.7 Loop: a sleep inside the tick renews the verify lease

## 3. Specs

- [x] 3.1 verifier-pool and task-lifecycle deltas
- [x] 3.2 `openspec validate remote-verification-hardening --strict`
