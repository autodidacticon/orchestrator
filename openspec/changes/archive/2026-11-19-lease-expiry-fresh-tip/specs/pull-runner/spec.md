## MODIFIED Requirements

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha), a change to a tracked file, or a path the worker staged. An untracked file alone SHALL NOT be progress, and the work-in-progress commit of an expiry SHALL NOT include untracked files: a file is added to the kept commit only when the worker stages it. With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`. When the work-in-progress commit fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt. A release with `keep` is unaffected: it commits untracked files too. A remote launch's expiry SHALL NOT check a worktree, preserve or remove anything: the orchestrator SHALL read the launch branch tip at origin (`ls-remote`). A tip other than the base sha, with `interruptions` under the bound, SHALL make the expiry a kept release at that tip with reason `leaseExpired` and no `wipCommit`; no branch, or a tip at the base sha, SHALL make it a failed attempt with reason `leaseExpired`. The tick SHALL NOT wait for this read beyond the short bound of integration-pipeline "The tick never waits for origin", and not at all while another remote command is queued or running; startup recovery SHALL await it in full. When origin cannot be read, or the tick's read is still running, the expiry SHALL be left for a later tick, with the launch live, until twice the lease TTL has passed since the lease was last renewed (its expiry time plus one TTL); then the attempt SHALL fail with `leaseExpired`. A read of the branch tip that the tick started SHALL be used only for the lease expiry it was started for (the lease's expiry time when it started): once the lease is renewed (by a worker call or after a gap in the daemon's clock), the next expiry SHALL drop that read and start a new one, so it decides on the tip at origin after the renewal. When a launch ends, for any reason, the orchestrator SHALL drop its read of the branch tip.

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

#### Scenario: Remote expiry after a renewed lease
- **WHEN** a remote launch's lease expires while origin's queue is held, so the read of the branch tip is still running and the expiry is skipped, the worker then renews its lease by a heartbeat, the read settles with no branch (or an older tip), the worker pushes a commit, and the lease expires again
- **THEN** the second expiry reads the tip again and is a kept release at the commit pushed last, with `attempts` unchanged, and not a failed attempt or a release at the older tip
