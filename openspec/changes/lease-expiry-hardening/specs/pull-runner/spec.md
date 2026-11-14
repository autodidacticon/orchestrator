## ADDED Requirements

### Requirement: Silence limit in the claim
The claim response, first and repeated, SHALL carry `health: { stuckFailAfterMs }` with the daemon's `health.stuckFailAfterMs`. A work loop SHALL take it as its silence limit when it is positive and no `--max-silence-ms` is given; when it is 0 (the daemon never fails a stuck launch) the loop SHALL keep its own default, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: Claim states the threshold
- **WHEN** a worker claims a launch under `health.stuckFailAfterMs: 1800000`
- **THEN** the response has `health: { stuckFailAfterMs: 1800000 }` and a loop without `--max-silence-ms` ends a silent agent after 1800000ms

## MODIFIED Requirements

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha), a change to a tracked file, or a path the worker staged. An untracked file alone SHALL NOT be progress, and the work-in-progress commit of an expiry SHALL NOT include untracked files: a file is added to the kept commit only when the worker stages it. With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`. When the work-in-progress commit fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt. A release with `keep` is unaffected: it commits untracked files too.

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
