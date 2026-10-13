## ADDED Requirements

### Requirement: Idle exit and revival
An idle exit SHALL be a graceful stop: the orchestrator loop stops, in-flight verification is awaited (none exists when quiescent), no agent is reaped, the store is closed, and the exit record is written. A daemon started afterwards SHALL run the same recovery as after any stop and SHALL find nothing to adopt or repair: a `submitted` milestone keeps its `integrationSha`, `reviewVersion`, and tag; a `blocked` task keeps its question and answer; pending outbox effects stay pending; parked launches stay `claimable` with their worktrees re-prepared when missing; and the next tick proceeds from the stored state. The exit record SHALL NOT be consulted by recovery. The crash matrix SHALL keep passing with the default idle window, because every run in it finishes well inside it.

#### Scenario: Review survives an idle exit
- **WHEN** the daemon exits idle while MVP is `submitted` at version 2 and is revived by `accept` with that sha and version
- **THEN** MVP becomes `done` and no launch, job, or tag is created or changed by recovery

#### Scenario: Blocked question survives an idle exit
- **WHEN** the daemon exits idle while T3 is `blocked` with a question and is revived by `answer`
- **THEN** T3 becomes `unstarted` with the answer in its carry and is launched on the next tick

#### Scenario: Parked launches survive an idle exit
- **WHEN** the daemon exits idle with two launches parked in `pull` mode and is revived by a worker's `claim`
- **THEN** the worker receives the oldest parked launch with its worktree present

### Requirement: Attachment end is durable
The end of an attachment SHALL be a durable record written before any launch is released, and the release of its launches SHALL happen in the next tick's reconcile as one transaction per launch, so that a daemon crash between the record and the release, or between two releases, converges after restart: recovery SHALL leave the record in place, reconcile SHALL release the remaining launches, and a launch already released SHALL NOT be released twice. The kept release SHALL preserve uncommitted work on the launch branch before the launch is ended, so a crash after the commit and before the transition leaves the branch with the work and the launch still live, and the next reconcile completes the release.

#### Scenario: Crash after the end record
- **WHEN** the daemon dies after recording an attachment's end and before releasing its two launches, and is restarted
- **THEN** both launches are released with `keep` by the first reconcile and the attachment record is removed

#### Scenario: Crash between preserve and transition
- **WHEN** the daemon dies after committing a launch's uncommitted work and before ending the launch
- **THEN** after restart the launch is released with `keep`, the branch holds the work-in-progress commit once, and the task is `unstarted` with `attempts` unchanged
