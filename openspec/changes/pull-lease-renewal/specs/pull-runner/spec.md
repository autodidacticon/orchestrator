## ADDED Requirements

### Requirement: Lease facts in the claim
The claim response, first and repeated, SHALL carry `leaseTtlMs`, `leaseExpiresAt` (the task's lease expiry when the response is made), and `lease: { ttlMs, expiresAt, renewEveryMs }`. `renewEveryMs` is a third of the TTL, rounded down: the longest a worker may go between calls. A repeated claim SHALL state the lease as it stands, not a fresh `now + leaseTtlMs`.

#### Scenario: First claim states the lease
- **WHEN** a worker claims a parked launch at time t under `leaseTtlMs: 60000`
- **THEN** the response has `leaseTtlMs: 60000`, `leaseExpiresAt: t + 60000`, and `lease: { ttlMs: 60000, expiresAt: t + 60000, renewEveryMs: 20000 }`

#### Scenario: Repeated claim states the current expiry
- **WHEN** the worker heartbeats 5 seconds after the claim and then claims again with the same worker id
- **THEN** the repeated response has `leaseExpiresAt: t + 5000 + 60000`

### Requirement: Lease renewal by the work loop
`POST /v1/launches/:id/renew` with `Authorization: Bearer <launch token>` SHALL set the lease of a live claimed launch to expire at `now + leaseTtlMs`, provided the task is `running` or `waiting` on that launch, and answer 200 with `{ ok, ttlMs, expiresAt, renewEveryMs }`. It SHALL answer 401 for a wrong token or an ended or revoked launch. It SHALL answer 409 for a launch with a pid or one that no longer holds its task.

#### Scenario: Renewal keeps a silent claim
- **WHEN** a claimed launch makes no call and changes nothing in its worktree for five TTLs while its loop renews every third of the TTL
- **THEN** the launch is still live, its task is `running` with `attempts` unchanged, and `launches` is 1

#### Scenario: Renewal stops
- **WHEN** the loop renews once and then stops
- **THEN** the lease expires no later than `leaseTtlMs` plus one tick after the last renewal, and a later renewal answers 401

#### Scenario: Renewal of a spawned launch
- **WHEN** the renew route is called for a launch the daemon spawned
- **THEN** it answers 409 and the lease is unchanged

### Requirement: Renewal is not progress
A renewal SHALL NOT be a progress signal. It SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged, and SHALL append no event. A launch that only renews SHALL still be flagged stuck after `health.stuckAfterMs` and failed after `health.stuckFailAfterMs`.

#### Scenario: A launch that only renews goes stuck
- **WHEN** a claimed launch only renews for longer than `health.stuckAfterMs`
- **THEN** its `progressAt` is still the claim time, `lastSignal` is still `claimed`, a `launch.stuck` event is appended once, and `status.stuck` lists its task

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha) or a dirty file. With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`.

#### Scenario: Expiry after a commit is kept
- **WHEN** a claimed launch commits, the commit is observed, and the launch then makes no call past the TTL
- **THEN** the launch ends with `leaseExpired`, the task is `unstarted` with `attempts` 0 and `interruptions` 1, and the next launch's brief says the previous launch's branch holds the work at the commit

#### Scenario: Expiry with only a dirty file is kept
- **WHEN** a claimed launch leaves a modified file uncommitted and then falls silent past the TTL
- **THEN** the file is committed as a work-in-progress commit on the branch and the next brief's `interrupted` carries `wipCommit`

### Requirement: Kept expiry record
A kept expiry SHALL end the launch with reason `leaseExpired`, and its `launch.ended` event SHALL carry `kept: true`. It SHALL append `launch.released` with `reasonCode: "leaseExpired"`, `progressed: true` and `kept: true`. It SHALL increase `interruptions` by one and store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }`, so that the retry's brief names the kept branch.

#### Scenario: Events of a kept expiry
- **WHEN** a claimed launch with a commit expires
- **THEN** its `launch.ended` payload is `{ endReason: "leaseExpired", kept: true }` and its `launch.released` payload has `reasonCode: "leaseExpired"`

### Requirement: Lease expiry without progress
An expiry without progress in the worktree SHALL be a failed attempt with reason `leaseExpired`, as before, even when the launch made calls. So SHALL an expiry once the task's kept releases have reached `daemon.maxKeptReleases`. If a call renews the lease while the worktree is being checked, the launch SHALL stay live.

#### Scenario: Expiry without progress spends the attempt
- **WHEN** a claimed launch heartbeats but never touches its worktree, then falls silent past the TTL
- **THEN** the task fails with reason `leaseExpired`, `attempts` is 1, and the next brief carries `priorFailure` with kind `leaseExpired`

#### Scenario: Kept expiries are bounded
- **WHEN** `daemon.maxKeptReleases` is 1 and a task's second claimed launch expires after a commit
- **THEN** the expiry spends an attempt and `interruptions` stays at 1

## MODIFIED Requirements

### Requirement: Release
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept. The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`. The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`. Lease expiry on a claimed launch SHALL follow "Lease expiry": a kept release when the worktree shows progress since the claim and the bound allows, a failed attempt with reason `leaseExpired` otherwise.

#### Scenario: Release without progress
- **WHEN** a worker releases a launch it has not touched
- **THEN** the task is `unstarted`, `attempts` is unchanged, the worktree is gone, and the next tick prepares a new claimable launch with `launches` increased

#### Scenario: Release after progress
- **WHEN** a worker commits in the worktree and then releases with a reason
- **THEN** the task is `failed` with reason `released`, `attempts` increases, and the retry brief carries the worker's reason

#### Scenario: Release while waiting
- **WHEN** a worker releases a launch whose task is `waiting` on its question
- **THEN** the task is `blocked` with the question preserved and the launch has ended

#### Scenario: Kept release after progress
- **WHEN** a worker commits once, leaves a modified file uncommitted, and releases with `keep` true
- **THEN** the branch holds the commit and a work-in-progress commit of the modified file, the worktree is gone, the task is `unstarted` with `attempts` unchanged, and the next claim's brief carries `interrupted` with that branch and head

#### Scenario: Kept release without progress
- **WHEN** a worker releases an untouched launch with `keep` true
- **THEN** the outcome is the same as a release without progress and no `interrupted` context is stored

#### Scenario: Kept release while waiting
- **WHEN** a worker releases a `waiting` launch with `keep` true after committing
- **THEN** the task is `blocked` with its question, the branch is kept, and the brief after `answer` carries both the answer and `interrupted`

#### Scenario: Interruptions bounded
- **WHEN** `daemon.maxKeptReleases` is 2 and T2, which has not submitted, is released with `keep` after progress for the third time
- **THEN** T2 is `failed` with reason `released`, `attempts` increases, and `interruptions` stays at 2
