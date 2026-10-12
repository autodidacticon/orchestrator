## ADDED Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and a CLI SHALL speak to them. The commands SHALL be `status`, `answer`, `cancel` with optional `--release`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, and `logs`. Humans SHALL act only through this interface.

#### Scenario: CLI reaches the daemon
- **WHEN** `status` is run while the daemon is up
- **THEN** it prints the current report from the daemon

### Requirement: Every human action is an event
Each operator command SHALL be appended to the event log before the orchestrator applies its effect, and the event SHALL carry the command, its arguments, and a timestamp.

#### Scenario: Cancel is auditable
- **WHEN** a human cancels T2 with a reason
- **THEN** the event log contains an operator cancel event for T2 with that reason, followed by the transition

### Requirement: Status report
`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, and `blocked` sets, `stallRoots`, `awaitingReview`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, and any foreign commits.

#### Scenario: Stalled run names its roots
- **WHEN** the run is stalled on a failed T1
- **THEN** `status` shows `stalled` true and `stallRoots` containing T1 with its reason

#### Scenario: Rejected reload is visible
- **WHEN** the last reload was incompatible
- **THEN** `status` shows `graphRejected` with the reasons and the revision still in force

### Requirement: Answer
`answer` SHALL apply to a task that is `waiting` or `blocked` with a question. For a `waiting` task the answer SHALL be persisted before resume is attempted. For a `blocked` task it SHALL act as unblock with the answer attached to the next brief.

#### Scenario: Answer a waiting task
- **WHEN** a human answers a waiting task
- **THEN** the answer is stored and the task resumes once admitted

#### Scenario: Answer a blocked task
- **WHEN** a human answers a task blocked with kind `needsDecision`
- **THEN** the task is `unstarted` and its next brief carries the answer

### Requirement: Reopen and unblock honour the guard
`reopen` SHALL succeed only when the node is revocable, and otherwise SHALL be rejected with the dependents that prevent it. `unblock` SHALL return a `blocked` node to `unstarted` with budgets reset.

#### Scenario: Reopen rejected
- **WHEN** a human reopens a done task whose dependent is running
- **THEN** the command fails and names the running dependent

### Requirement: Milestone review commands
`accept` SHALL require the milestone's current `integrationSha` and `reviewVersion` and SHALL fail if they do not match. `reject` SHALL require a note.

#### Scenario: Stale accept rejected
- **WHEN** a human accepts MVP citing review version 1 while MVP is at version 2
- **THEN** the command fails without changing MVP

### Requirement: Pause and resume
`pause` SHALL stop admission of new launches and resumes while letting running work continue and verification proceed. `resume` SHALL lift it. The flag SHALL be stored durably.

#### Scenario: Paused run finishes in-flight work
- **WHEN** the run is paused with two tasks running and three ready
- **THEN** the two complete and are verified, and no new launch starts until `resume`

### Requirement: Shutdown
Graceful shutdown SHALL stop admission, flush pending transactions, and exit while leaving agent processes running for adoption on the next start. A `--reap` shutdown SHALL additionally terminate every live agent process.

#### Scenario: Graceful shutdown keeps agents
- **WHEN** the daemon is stopped gracefully with agents running
- **THEN** the agents keep running and are adopted when the daemon restarts

#### Scenario: Reap shutdown stops agents
- **WHEN** the daemon is stopped with `--reap`
- **THEN** every live agent process is terminated and their tasks are `failed` with reason `reaped`

### Requirement: Logs
`logs` SHALL print the captured stdout and stderr of a given task's launch, defaulting to the most recent launch.

#### Scenario: Logs for a specific launch
- **WHEN** `logs T2 --launch 2` is run
- **THEN** the output is the log file of T2's second launch
