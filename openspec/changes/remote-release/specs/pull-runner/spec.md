## MODIFIED Requirements

### Requirement: Release
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept. The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`. The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`. Lease expiry on a claimed launch SHALL follow "Lease expiry": a kept release when the worktree shows progress since the claim and the bound allows, a failed attempt with reason `leaseExpired` otherwise. A remote launch (`access: remote`) has no worktree on the daemon's host: the release body MAY carry `headSha`, the launch branch tip the worker pushed, and `wipCommit`, its work-in-progress commit, each a full hex object name (a malformed one SHALL be answered 400 naming the field, and a local release SHALL ignore both). For a remote launch, progress SHALL be any agent API call since the claim or a `headSha` that differs from the base sha, and the orchestrator SHALL NOT fingerprint, preserve or remove anything. A kept remote release SHALL fetch the launch branch from origin and require its tip to equal `headSha`: no branch on origin SHALL answer 409 `branchNotPushed`, another tip 409 `shaMismatch`, and an origin that cannot be fetched 503 `originUnreachable` or `originRefused`; on any of these the task and the launch SHALL be unchanged, the launch SHALL stay live, and no `launch.released` event SHALL be appended. A remote release with `keep` but no `headSha` cannot be kept and SHALL behave as a release without `keep`, with `keepError` naming `headSha`. Otherwise a kept remote release SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }` as a local one does, under the same `daemon.maxKeptReleases` bound, and its `launch.released` event SHALL carry `headSha`.

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

#### Scenario: Remote kept release
- **WHEN** a remote worker commits, pushes the launch branch and releases with `keep` true and `headSha` equal to the pushed tip
- **THEN** the answer has `kept: true`, the task is `unstarted` with `attempts` unchanged, `carry.interrupted.headSha` is the tip, the next remote claim carries it, and no fingerprint, preserve or worktree removal was made

#### Scenario: Remote keep with another tip
- **WHEN** a remote worker releases with `keep` and a `headSha` that is not the launch branch tip at origin, or the branch is not on origin
- **THEN** the answer is 409 with `shaMismatch` or `branchNotPushed` and the launch stays `live`

#### Scenario: Remote keep without progress
- **WHEN** a remote worker that made no API call since the claim releases with `keep` and `headSha` equal to the base sha
- **THEN** the answer has `kept: false` and the task is `unstarted` with `attempts` unchanged, as for a local release without progress

#### Scenario: Remote keeps are bounded
- **WHEN** a remote task's `interruptions` has reached `daemon.maxKeptReleases` and its worker releases with `keep` after pushing
- **THEN** the answer has `kept: false` and `keepError` naming the bound

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha), a change to a tracked file, or a path the worker staged. An untracked file alone SHALL NOT be progress, and the work-in-progress commit of an expiry SHALL NOT include untracked files: a file is added to the kept commit only when the worker stages it. With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`. When the work-in-progress commit fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt. A release with `keep` is unaffected: it commits untracked files too. A remote launch's expiry SHALL NOT check a worktree, preserve or remove anything: the orchestrator SHALL read the launch branch tip at origin (`ls-remote`). A tip other than the base sha, with `interruptions` under the bound, SHALL make the expiry a kept release at that tip with reason `leaseExpired` and no `wipCommit`; no branch, or a tip at the base sha, SHALL make it a failed attempt with reason `leaseExpired`. The tick SHALL NOT wait for this read beyond the short bound of integration-pipeline "The tick never waits for origin", and not at all while another remote command is queued or running; startup recovery SHALL await it in full. When origin cannot be read, or the tick's read is still running, the expiry SHALL be left for a later tick, with the launch live, until twice the lease TTL has passed since the lease was last renewed (its expiry time plus one TTL); then the attempt SHALL fail with `leaseExpired`.

#### Scenario: Expiry after a commit is kept
- **WHEN** a claimed launch commits, the commit is observed, and the launch then makes no call past the TTL
- **THEN** the launch ends with `leaseExpired`, the task is `unstarted` with `attempts` 0 and `interruptions` 1, and the next launch's brief says the previous launch's branch holds the work at the commit

#### Scenario: Expiry with only a dirty file is kept
- **WHEN** a claimed launch leaves a modified tracked file, or a staged new file, uncommitted and then falls silent past the TTL
- **THEN** the file is committed as a work-in-progress commit on the branch and the next brief's `interrupted` carries `wipCommit`

#### Scenario: An untracked file alone is not progress
- **WHEN** a claimed launch's only change is an untracked file (a check command's artefact, say) and its lease expires
- **THEN** the expiry is a failed attempt with reason `leaseExpired` and the branch stays at the base sha

#### Scenario: An untracked file is left out of the kept commit
- **WHEN** a claimed launch stages a new file, leaves another file untracked, and its lease expires
- **THEN** the work-in-progress commit holds the staged file only

#### Scenario: The work-in-progress commit fails
- **WHEN** a claimed launch has committed, has uncommitted changes, and holds `index.lock` when its lease expires
- **THEN** the expiry is a kept release at the launch's last commit with no `wipCommit`, `attempts` is unchanged, and the branch is kept

#### Scenario: Remote expiry after a push is kept
- **WHEN** a remote launch pushed its branch one commit ahead of the base and its lease expires
- **THEN** `launch.released` has `kept: true`, `reasonCode: "leaseExpired"` and `headSha` the pushed tip, and the task is `unstarted` with `attempts` unchanged

#### Scenario: Remote expiry with nothing pushed
- **WHEN** a remote launch's lease expires and origin has no launch branch
- **THEN** the attempt fails with reason `leaseExpired`

#### Scenario: Remote expiry with origin unreachable
- **WHEN** a remote launch's lease expires while origin cannot be reached
- **THEN** the first tick fails nothing and the launch stays live, and once twice the lease TTL has passed the attempt fails with `leaseExpired`

### Requirement: Kept expiry record
A kept expiry SHALL end the launch with reason `leaseExpired`, and its `launch.ended` event SHALL carry `kept: true`. It SHALL append `launch.released` with `reasonCode: "leaseExpired"`, `progressed: true` and `kept: true`; for a remote launch it SHALL also carry `headSha`, the tip read at origin. It SHALL increase `interruptions` by one and store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }`, so that the retry's brief names the kept branch.

#### Scenario: Events of a kept expiry
- **WHEN** a claimed launch with a commit expires
- **THEN** its `launch.ended` payload is `{ endReason: "leaseExpired", kept: true }` and its `launch.released` payload has `reasonCode: "leaseExpired"`
