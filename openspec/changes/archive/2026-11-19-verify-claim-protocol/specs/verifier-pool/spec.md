## Purpose

Verification outside the daemon. Under `verifier.mode: remote` the daemon offers each verify job over its API; a verifier loop claims it with a lease, rebases the sealed commit onto the expected head, runs the check command, pushes the rebased commit to `refs/verify/<jobId>` and posts the result; the daemon checks that ref, squashes and publishes.

## ADDED Requirements

### Requirement: Verify job offer
A verify job SHALL carry four optional fields in its JSON document, with no column and no migration: `offer` (`at`, `checkCommand`), `token`, `verifier` (`id`, `claimedAt`, `expiresAt`) and `result`. A job SHALL be claimable only when it is unapplied and `checking`, has an `offer`, holds neither `verifier` nor `result`, and its launch row exists. A job the in-process backend checks has no `offer` and SHALL never be claimable.

#### Scenario: Nothing offered
- **WHEN** the store holds a `queued` job, a `checking` job with `expectedHead` but no `offer`, and an offered job whose launch row is missing, and a verifier claims
- **THEN** the claim answers 404 `{ error: "nothing to verify" }`, the latest event sequence is unchanged and the three job rows are unchanged

#### Scenario: Fields survive a reopen on every backend
- **WHEN** a job is updated with `offer`, `token`, `verifier` and `result`, the store is reopened, then `verifier` and `token` are patched to `undefined` and the store is reopened again
- **THEN** the job first reads back with all four fields, and then holds neither `verifier` nor `token` while keeping `offer` and `result`

### Requirement: Verify claim
`POST /v1/verify/claims` with `{ verifierId }` SHALL grant the oldest claimable job, in `listJobs` order. One transaction SHALL set `token` to 48 random hex characters and `verifier` to `{ id, claimedAt: now, expiresAt: now + leaseTtlMs }`, and append `verify.claimed` with `jobId`, `verifierId` and `expectedHead`, naming the job's `taskId` and `launchId`. In M5 the claim SHALL read no credential.

#### Scenario: Grant
- **WHEN** verifier `v1` claims an offered job
- **THEN** the answer is 200 with `repeated: false` and a 48-character hex `token`, the row holds `verifier.id` `v1` with `claimedAt` at the clock and `expiresAt` at the clock plus `leaseTtlMs`, and exactly one `verify.claimed` event names the job, `v1`, the `expectedHead`, the task and the launch

#### Scenario: Oldest job first
- **WHEN** two jobs are offered and the one with the later id has the older `createdAt`
- **THEN** a claim grants the job with the older `createdAt`

### Requirement: Verify claim: refusals
A blank `verifierId`, after trimming, SHALL answer 400 `{ error: "verifierId is required" }`, and an id the store would rewrite SHALL answer 400 naming `verifierId`, before anything is written. With nothing to claim or hold the claim SHALL answer 404 `{ error: "nothing to verify" }` before resolving a repository URL; with no URL it SHALL answer 409. A 400, 404 or 409 SHALL append no event and change no row.

#### Scenario: Missing, blank and unstorable ids
- **WHEN** a claim has no `verifierId`, one of only spaces, or one holding a NUL character
- **THEN** the first two answer 400 `{ error: "verifierId is required" }`, the third is refused with the store's unstorable error naming `verifierId`, and no event is appended

#### Scenario: No repository URL
- **WHEN** the daemon's `repoPath` is an empty directory and no git URL is configured
- **THEN** a claim answers 404 while nothing is offered and 409 `{ ok: false, reason: "no repository URL: set git.workerOriginUrl or git.originUrl" }` once a job is offered, and neither appends an event or changes the job row

### Requirement: Verify claim: repeated claim
A verifier that holds an unapplied `checking` job with its id in `verifier.id` and no `result` SHALL get the same job and token again with `repeated: true`, also when its lease has run out but the tick has not ended it. The repeat SHALL move `verifier.expiresAt` to now plus `leaseTtlMs`, change nothing else and append no event. The claim SHALL look for a held or claimable job again after resolving the URL, and await nothing between that look and the grant.

#### Scenario: Same verifier claims again
- **WHEN** `v1` claims a job, the clock advances 1000 ms, and `v1` claims again
- **THEN** the answer names the same `jobId` and `token` with `repeated: true`, `expiresAt` and `leaseExpiresAt` are the new clock plus `leaseTtlMs`, and no second `verify.claimed` is appended

#### Scenario: Another verifier while the job is held
- **WHEN** `v1` holds the only offered job and `v2` claims
- **THEN** the claim answers 404 and writes nothing

### Requirement: Verify claim: answer
A claim SHALL answer 200 `{ ok, repeated, jobId, token, taskId, branch, repoUrl, integrationBranch, expectedHead, sealedSha, baseSha, noChanges, checkCommand, checkTimeoutMs, leaseTtlMs, leaseExpiresAt, lease }`: `branch` from the launch row, `repoUrl` as in a remote worker claim, `integrationBranch`, `checkTimeoutMs` and `leaseTtlMs` at their start values, `noChanges` from the submit report, `checkCommand` from the offer, and `lease` as `{ ttlMs, expiresAt, renewEveryMs }` from `verifier`.

#### Scenario: Answer fields
- **WHEN** `v1` claims an offered job on a harness whose `git.workerOriginUrl` is `file:///origin.git`
- **THEN** the answer holds `branch` equal to the launch row's, `repoUrl` `file:///origin.git`, `noChanges: false`, `leaseExpiresAt` equal to `verifier.expiresAt`, and `lease.renewEveryMs` a third of `leaseTtlMs`

#### Scenario: Check command kept for the offer
- **WHEN** the check command is overridden to `make check` and a job offered with `checkCommand: "true"` is claimed
- **THEN** the answer's `checkCommand` is `true`

#### Scenario: Same repository URL as a remote worker
- **WHEN** on a remote run with a bare origin a worker claims with `access: remote` and later a verifier claims an offered job over HTTP
- **THEN** both answers carry the same `repoUrl`

### Requirement: Verify claim: pause and hold
Neither a paused run nor the hold after a gap in the daemon's clock SHALL stop the claim, heartbeat, result or release route.

#### Scenario: Paused and in the hold
- **WHEN** the run is paused, and again when the daemon is inside the hold after a gap, a verifier claims an offered job and sends a heartbeat and a result
- **THEN** the claim is granted and the heartbeat and the result answer 200

### Requirement: Verify claim: waiters
The daemon SHALL keep in-memory waiters per job: `verifyJobChanged` SHALL resolve at the job's next grant, repeated claim, result, release or lease expiry, and at the end of every lease-expiry pass of the tick; `wakeVerifyWaiters` SHALL resolve every pending one. Nothing about a waiter is stored.

#### Scenario: Waiters resolve
- **WHEN** a waiter is pending on a job and the job is granted, released, expired or given a result, or a tick changes nothing, or `wakeVerifyWaiters` is called
- **THEN** the waiter resolves each time

### Requirement: Verify job token
The heartbeat, result and release routes SHALL accept a request only when the job named in the path exists, is unapplied and `checking`, and its `token` equals the `Authorization: Bearer` value; anything else SHALL answer 401 `{ error: "unauthorized" }`. A missing header SHALL read as the empty token, and a job without a token SHALL never pass.

#### Scenario: Refused tokens
- **WHEN** a heartbeat, result or release is sent with a wrong token, an empty token, for an unknown job, for a claimed job set back to `queued`, or for a claimed job dropped by a cascade with its own token
- **THEN** each answers 401 `{ error: "unauthorized" }`, while the right token on the claimed job answers 200

#### Scenario: No header over HTTP
- **WHEN** heartbeat, result and release are sent over HTTP without an `Authorization` header
- **THEN** each answers 401

### Requirement: Verify job token: only in the claim answer
The job token SHALL leave the daemon only in the claim answer: no event, log line, status or other answer SHALL carry it.

#### Scenario: Status and events carry no token
- **WHEN** two verifiers have claimed a job over HTTP in turn
- **THEN** no answer of `GET /v1/status` or `GET /v1/events` contains either job token

### Requirement: Verify lease
`POST /v1/verify/:jobId/heartbeat` with the job token SHALL set `verifier.expiresAt` to now plus `leaseTtlMs`, append no event, and answer 200 `{ ok: true, ttlMs, expiresAt, renewEveryMs }`. A heartbeat on a job that holds a result SHALL also answer 200.

#### Scenario: Heartbeat
- **WHEN** the clock advances 1000 ms after a claim and the verifier sends a heartbeat
- **THEN** `verifier.expiresAt` is the clock plus `leaseTtlMs`, the answer holds `ttlMs`, `expiresAt` and `renewEveryMs`, and the latest event sequence is unchanged

### Requirement: Verify lease: expiry
Each tick SHALL, first in its verification phase and after writing pending gaps, end every lease of an unapplied `checking` job with a `verifier`, no `result` and `verifier.expiresAt` at or before now: one transaction SHALL remove `verifier` and `token` and append `verify.leaseExpired` with `jobId` and `verifierId`. The job SHALL stay `checking` with its `offer`, claimable again, and no attempt SHALL be spent.

#### Scenario: Lease runs out
- **WHEN** `leaseTtlMs` passes after a claim without a heartbeat and the tick runs
- **THEN** `verifier` and `token` are removed, one `verify.leaseExpired` names the job and `v1`, the job stays `checking` with its `offer`, the old token answers 401, and a claim by `v2` is granted with another token

#### Scenario: Heartbeats keep the lease
- **WHEN** the verifier sends a heartbeat every third of `leaseTtlMs` over three lease lengths while the tick runs
- **THEN** no `verify.leaseExpired` is appended

#### Scenario: A job with a result is not expired
- **WHEN** a job holds a `result` and two lease lengths pass before a tick
- **THEN** its `verifier` stays and no `verify.leaseExpired` is appended

### Requirement: Verify lease: renewal after a gap
The transaction that writes gaps in the daemon's clock SHALL, after renewing the leases of live launches, set `verifier.expiresAt` to the time of the write plus `leaseTtlMs` for every unapplied `checking` job that has a `verifier` and no `result`, and append no event for it.

#### Scenario: Sleep past the lease
- **WHEN** after a claim the daemon does not run for five lease lengths and then ticks
- **THEN** no `verify.leaseExpired` is appended and `verifier.expiresAt` is at or after the wake plus `leaseTtlMs`, and after a further `leaseTtlMs` of awake time a tick expires the lease

### Requirement: Verify result
`POST /v1/verify/:jobId/result` with the job token SHALL store `result` once, with `verifierId` from the row's `verifier.id` and `at` set to now, and append `verify.result` with `jobId`, `verifierId` and `outcome` in the same transaction; the event MUST NOT carry the output. The job SHALL stay `checking` and keep `token` and `verifier`, and the job's own `rebasedSha`, `output` and `conflictFiles` SHALL not change.

#### Scenario: Verified result
- **WHEN** `v1` posts `outcome: verified` with an upper-case full `rebasedSha` and an output
- **THEN** `result` holds the lower-cased sha, the output, `conflictFiles: []`, `verifierId` `v1` and `at` at the clock, one `verify.result` event without an `output` key is appended, and the job stays `checking` with its `token`

### Requirement: Verify result: body
The result body SHALL be `{ outcome, rebasedSha?, output?, conflictFiles? }`: `outcome` one of `verified`, `checkFailed`, `checkTimeout`, `conflict`, `rebaseFailed`, `originFailed`; `rebasedSha` required for `verified`, a full hex object name when present, stored lower-cased; `output` a string, empty when absent, cut to its last 65536 characters; `conflictFiles` an array of strings, empty when absent. A malformed body SHALL answer 400 `{ error, field }` and store nothing.

#### Scenario: Outcomes and malformed bodies
- **WHEN** each of the six outcomes is posted on a job of its own, and then an unknown outcome, `verified` without `rebasedSha`, a short `rebasedSha`, a non-string `output` and a `conflictFiles` that is not an array of strings are posted
- **THEN** the six are accepted, and each malformed body answers 400 naming its field and stores no `result`

#### Scenario: Long output
- **WHEN** a result carries an `output` of 70000 characters
- **THEN** the stored output is its last 65536 characters

### Requirement: Verify result: duplicate
A result for a job that already holds a `result` SHALL answer 200 `{ ok: true, duplicate: true }` before its body is checked, and SHALL change nothing.

#### Scenario: Posted twice
- **WHEN** the same result is posted again, or a second result with another body
- **THEN** each answers `{ ok: true, duplicate: true }` and still one `verify.result` event exists

### Requirement: Verify release
`POST /v1/verify/:jobId/release` with `{ reason? }` and the job token SHALL hand the claim back: a job holding a `result` SHALL answer 409 `{ ok: false, reason: "a result is already recorded" }`; a `reason` that is not a string SHALL answer 400 naming `reason`. Otherwise one transaction SHALL remove `verifier` and `token` and append `verify.released` with `jobId`, `verifierId` and `reason` (default `released by verifier`). The job keeps its `offer`.

#### Scenario: Release and claim again
- **WHEN** `v1` releases with `reason: terminating`, `v2` claims, and `v1` releases again with its old token
- **THEN** the first release answers 200, removes `verifier` and `token` and appends one `verify.released` with the job, `v1` and `terminating`; `v2` is granted with another token; and the second release answers 401

#### Scenario: Release after a result
- **WHEN** a verifier that has posted a result releases the job
- **THEN** the release answers 409 and the row is unchanged
