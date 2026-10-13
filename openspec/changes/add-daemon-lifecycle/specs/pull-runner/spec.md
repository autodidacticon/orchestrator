## ADDED Requirements

### Requirement: Session attachments
A claim MAY carry `attachment`, the id of a registered session attachment, which SHALL be stored on the launch's worker record as `worker.attachment`. When an attachment ends, by its own end request, by the first pid of its chain being found dead at reconcile, or by a session end naming any pid in its chain, every live claimed launch whose worker carries it SHALL be released with `keep` and reason `sessionEnded` at the next reconcile. A claim without an attachment SHALL be governed by its lease alone, as before. A kept release SHALL end the launch, so the former worker's token SHALL no longer authenticate.

#### Scenario: Worker dies with its session
- **WHEN** a worker claimed T2 through attachment A, committed twice, and A's process dies
- **THEN** the next reconcile ends T2's launch with reason `released`, T2 is `unstarted` with `attempts` unchanged and `carry.interrupted` naming the branch, and a call with the old token answers 401

#### Scenario: Lease still governs an unattached claim
- **WHEN** a worker claims without an attachment and stops calling for longer than the lease TTL
- **THEN** the task is `failed` with reason `leaseExpired` as before

## MODIFIED Requirements

### Requirement: Release
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept. The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`. The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`. Lease expiry on a claimed launch SHALL follow the existing failure path with reason `leaseExpired`.

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
