## ADDED Requirements

### Requirement: Waiting claim with a lost worktree
At startup, recovery SHALL end a `waiting` claimed launch whose worktree is gone with `worktreeLost`. If the task's answer has already arrived, the task SHALL be retried without spending an attempt, with the question and answer in the next brief's context. If not, the task SHALL stay `waiting`. An answer to a `waiting` task whose launch is no longer live SHALL retry the task the same way, because nothing can resume.

#### Scenario: Answer arrived before the restart
- **WHEN** a claimed launch blocks, its answer is recorded, and the daemon restarts on a fresh clone before the worker collects it
- **THEN** the launch ends with `worktreeLost`, the task is `unstarted` with `attempts` 0, and the next launch's brief carries the question and the answer

#### Scenario: Answer not yet arrived
- **WHEN** a claimed launch blocks and the daemon restarts on a fresh clone before anyone answers
- **THEN** the launch ends with `worktreeLost` and the task stays `waiting` on its question

#### Scenario: Answer after the restart
- **WHEN** the operator answers that waiting task
- **THEN** the task is `unstarted` with `attempts` 0 and the answer in its carry, and the next launch's brief carries it

### Requirement: Lost refs found at startup
With a git workspace, recovery SHALL find, before any brief is composed:
- lost launch branches: the branch of every launch not in flight that is missing from the clone's `refs/heads`;
- lost commits: those named in stored attempt context that the clone definitely lacks (an interrupted context's `headSha` and `wipCommit`, a revision's `priorPublishedSha`).

The daemon SHALL keep these refs for its life.

#### Scenario: Fresh clone
- **WHEN** the daemon restarts on a fresh clone after a launch ended with its branch kept
- **THEN** that branch is among the lost refs

### Requirement: Context naming lost work
Recovery SHALL rewrite every stored attempt context that names a lost ref, and record each rewrite as a `recovery.workLost` event naming what was lost:
- an `interrupted` context SHALL become `lostWork { priorLaunchId, reason }`;
- a conflict SHALL lose `previousBranch`;
- a revision SHALL lose `priorBranch` or `priorPublishedSha`.

#### Scenario: Kept release lost with the clone
- **WHEN** a claimed launch commits, is released with `keep`, its relaunch is parked, and the daemon restarts on a fresh clone
- **THEN** a `recovery.workLost` event names the prior launch, branch, head and reason, and the task's carry holds `lostWork` and no `interrupted`

### Requirement: No brief names a lost ref
No brief SHALL name a lost ref, in `brief.md` or `brief.json`. This includes a context composed after startup, such as a reopen's revision. A `lostWork` context SHALL tell the worker that the kept work was lost with the previous clone and that it starts from its base commit.

#### Scenario: Parked launch briefed again
- **WHEN** the parked relaunch of a kept release is prepared again on a fresh clone
- **THEN** its brief names neither the lost branch nor its commit, and says the previous launch's work was lost

### Requirement: Re-preparing a parked launch
When recovery prepares a claimable launch's missing worktree again, it SHALL NOT prepare a base commit the clone definitely lacks. Such a launch SHALL end with `baseLost`, and one whose preparation throws SHALL end with `prepareFailed`. Either way, its task SHALL fail with reason `worktreeLost`, without spending an attempt, and the daemon SHALL NOT exit.

#### Scenario: Base commit not in the clone
- **WHEN** the daemon restarts on a fresh clone that lacks a parked launch's base commit
- **THEN** the launch ends with `baseLost`, the task is `unstarted` with `attempts` 0 and a `worktreeLost` prior failure naming the base, and the next tick parks a new launch on the integration head

#### Scenario: Preparation throws
- **WHEN** preparing a parked launch's worktree fails for another reason
- **THEN** the launch ends with `prepareFailed`, the task is retried without spending an attempt, and startup completes
