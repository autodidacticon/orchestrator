## MODIFIED Requirements

### Requirement: Verify ref: deletion
Every run that read a `verified` result SHALL delete `refs/verify/<jobId>` on origin and in the clone after the daemon has written its outcome, whatever the outcome, a failed run, a drop and a job found no longer live included. A run that ends with nothing written, because the daemon stops, the store went fatal or the daemon dies, SHALL keep the ref for the resumed run. A failed deletion SHALL be logged as a warning and SHALL change nothing else.

#### Scenario: Ref gone after publication
- **WHEN** a job verified through its ref is published
- **THEN** `git ls-remote <origin> 'refs/verify/*'` prints nothing and the clone has no ref under `refs/verify/`

#### Scenario: Daemon killed before the outcome is written
- **WHEN** with `git.pushRefusalLimit: 2` a verified result is refused because the ref holds another commit, the daemon dies before it writes the outcome, and the daemon restarts
- **THEN** origin still holds `refs/verify/<jobId>` after the restart, the resumed run appends one `verify.requeued` with `retry` `refused` and `refusals` 1 naming the commit the ref holds, the ref is then deleted, and the task stays `submitted` with `attempts` 0

### Requirement: Verify lease: expiry
Each tick SHALL, first in its verification phase and after writing pending gaps, end every lease of an unapplied `checking` job with a `verifier`, no `result` and `verifier.expiresAt` at or before now: one transaction SHALL remove `verifier` and `token` and append `verify.leaseExpired` with `jobId` and `verifierId`. Unless "Verify lease: cycle cap" ends it, the job SHALL stay `checking` with its `offer`, claimable again, and no attempt SHALL be spent.

#### Scenario: Lease runs out
- **WHEN** `leaseTtlMs` passes after a claim without a heartbeat and the tick runs
- **THEN** `verifier` and `token` are removed, one `verify.leaseExpired` names the job and `v1`, the job stays `checking` with its `offer`, the old token answers 401, and a claim by `v2` is granted with another token

#### Scenario: Heartbeats keep the lease
- **WHEN** the verifier sends a heartbeat every third of `leaseTtlMs` over three lease lengths while the tick runs
- **THEN** no `verify.leaseExpired` is appended

#### Scenario: A job with a result is not expired
- **WHEN** a job holds a `result` and two lease lengths pass before a tick
- **THEN** its `verifier` stays and no `verify.leaseExpired` is appended

### Requirement: Verify release
`POST /v1/verify/:jobId/release` with `{ reason? }` and the job token SHALL hand the claim back: a job holding a `result` SHALL answer 409 `{ ok: false, reason: "a result is already recorded" }`; a `reason` that is not a string SHALL answer 400 naming `reason`. Otherwise one transaction SHALL remove `verifier` and `token` and append `verify.released` with `jobId`, `verifierId` and `reason` (default `released by verifier`). Unless the cycle cap ends it, the job SHALL keep its `offer`.

#### Scenario: Release and claim again
- **WHEN** `v1` releases with `reason: terminating`, `v2` claims, and `v1` releases again with its old token
- **THEN** the first release answers 200, removes `verifier` and `token` and appends one `verify.released` with the job, `v1` and `terminating`; `v2` is granted with another token; and the second release answers 401

#### Scenario: Release after a result
- **WHEN** a verifier that has posted a result releases the job
- **THEN** the release answers 409 and the row is unchanged

## ADDED Requirements

### Requirement: Verify ref: deletion: verify refs only
`Origin.deleteRef` SHALL refuse with an `Error` any name that does not start with `refs/verify/`, whatever its case, before it runs a command that talks to origin, changes a ref, or adds or re-points a remote. A verify ref that origin or the clone lacks SHALL NOT be an error.

#### Scenario: Branches and the tracking ref
- **WHEN** `deleteRef` is called with `refs/heads/main`, `refs/heads/MAIN` and `refs/remotes/origin/main`
- **THEN** each rejects with an `Error` naming the ref and `refs/verify/`, the clone's `main` and tracking ref and origin's `main` are unchanged, and no remote is added

#### Scenario: Missing verify ref
- **WHEN** `deleteRef` is called with a ref under `refs/verify/` that neither origin nor the clone has, or git answers `remote ref does not exist`
- **THEN** the call resolves and the clone has no such ref

### Requirement: Remote verification run: the wait: ended job
The wait SHALL end with nothing recorded when the job row has left `checking` without a result, as a job that lost its verifier three times has. The verifier slot SHALL then be free.

#### Scenario: Verifier lost while waiting
- **WHEN** three verifiers in turn claim an offered job and release it with reason `verifierError`
- **THEN** the job is `failed` with `failureKind` `verifierLost`, the verifier slot is free, and the task has spent an attempt

### Requirement: Remote verification outcomes: dropped job
A failed run, including a run that throws, SHALL write nothing to a job row that is gone, `dropped` or applied. The row SHALL keep its status, `applied` flag and fields.

#### Scenario: Dropped during the ref check
- **WHEN** a cascade drops a `checking` job that holds a `verified` result while its ref is fetched, and the run then throws an error that is not an `OriginFetchError`
- **THEN** the job stays `dropped` and applied with its result, has no `failureKind`, and the task's `attempts` is unchanged

### Requirement: Verify lease: cycle cap
A job SHALL count in `leaseLosses`, never cleared, each lease expiry and each release with reason `verifierError`. A release with any other reason, `podTerminating` included, SHALL NOT be counted. The event of a counted loss SHALL carry `leaseLosses`. At the third loss, the same transaction SHALL set the job `failed` with `failureKind` `verifierLost`, an output that names the count, and no `offer`, `verifier`, `token` or `result`. The tick SHALL then fail the task, spending an attempt.

#### Scenario: Third loss
- **WHEN** a job's lease expires, a verifier releases it with `podTerminating`, another releases it with `verifierError`, and a further lease expires
- **THEN** after the second counted loss the job is still `checking` with its offer and claimable, and after the third it is `failed` with `failureKind` `verifierLost`, `leaseLosses` 3 and an output naming 3, and the task has `attempts` 1

### Requirement: Verify claim: refusals: long verifierId
A `verifierId` longer than 253 characters, the longest pod name, after trimming, SHALL answer 400 `{ error, field: "verifierId" }` before anything is written.

#### Scenario: 254 characters
- **WHEN** a claim carries a `verifierId` of 254 characters, and then one of 253
- **THEN** the first answers 400 naming `verifierId` and appends no event, and the second is granted

### Requirement: Verify result: body: limits
A result's `conflictFiles` SHALL be stored with its first 200 entries.

#### Scenario: 500 conflict files
- **WHEN** a `conflict` result carries 500 `conflictFiles`
- **THEN** the stored result holds the first 200 files

### Requirement: Verify release: reason limit
A release `reason` SHALL be stored in `verify.released` with its first 4096 characters.

#### Scenario: Long reason
- **WHEN** a verifier releases a job with a `reason` of 10000 characters
- **THEN** `verify.released` carries the reason's first 4096 characters
