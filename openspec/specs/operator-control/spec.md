# Operator Control Specification

## Purpose
The HTTP-backed operator interface, reached through both a CLI and an MCP server, and its operations: status, answers, cancellation, reopen and unblock, milestone review, pause and resume, shutdown, and logs, together with per-user run directories, daemon lifecycle and discovery, the event stream, the review bundle, and graph import through the daemon, where every human action is recorded as an event.

## Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, `logs`, `events`, `review`, `import`, `shutdown`, `start`, `stop`, and `runs`. Humans and host sessions SHALL act only through this interface.

#### Scenario: CLI reaches the daemon
- **WHEN** `status` is run while the daemon is up
- **THEN** it prints the current report from the daemon

#### Scenario: MCP and CLI share one implementation
- **WHEN** the same operation is invoked through the CLI and through the MCP server
- **THEN** both produce the same event and the same effect

### Requirement: Every human action is an event
Each operator command SHALL be appended to the event log before the orchestrator applies its effect, and the event SHALL carry the command, its arguments, and a timestamp.

#### Scenario: Cancel is auditable
- **WHEN** a human cancels T2 with a reason
- **THEN** the event log contains an operator cancel event for T2 with that reason, followed by the transition

### Requirement: Status report
`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, and the latest event sequence number.

#### Scenario: Stalled run names its roots
- **WHEN** the run is stalled on a failed T1
- **THEN** `status` shows `stalled` true and `stallRoots` containing T1 with its reason

#### Scenario: Rejected reload is visible
- **WHEN** the last reload was incompatible
- **THEN** `status` shows `graphRejected` with the reasons and the revision still in force

#### Scenario: Run facts are reported
- **WHEN** `status` is requested
- **THEN** it includes the run directory, graph path, daemon pid and URL, and the latest event sequence number

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
Graceful shutdown SHALL stop admission, flush pending transactions, and exit while leaving agent processes running for adoption on the next start. A reaping shutdown SHALL additionally terminate every live agent process. Both SHALL be reachable by signal and by the `shutdown` route with a `reap` flag.

#### Scenario: Graceful shutdown keeps agents
- **WHEN** the daemon is stopped gracefully with agents running
- **THEN** the agents keep running and are adopted when the daemon restarts

#### Scenario: Reap shutdown stops agents
- **WHEN** the daemon is stopped with reap, by flag or by route
- **THEN** every live agent process is terminated and their tasks are `failed` with reason `reaped`

### Requirement: Logs
`logs` SHALL print the captured stdout and stderr of a given task's launch, defaulting to the most recent launch.

#### Scenario: Logs for a specific launch
- **WHEN** `logs T2 --launch 2` is run
- **THEN** the output is the log file of T2's second launch

### Requirement: Run directory
Run data SHALL live outside the repository in `$ORCH_HOME/runs/<id>/`, where `ORCH_HOME` defaults to `~/.orchestrator` and `<id>` is the first sixteen hex digits of the SHA-256 of the repository's real path. The run directory SHALL contain a `repo` file with that path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, and `daemon.pid`. The CLI and MCP server SHALL resolve the run directory from an explicit repository argument or from the git top level of the working directory. A `runs` operation SHALL list every run with its repository path, whether its daemon is alive, and a status digest.

#### Scenario: Same repository, same run
- **WHEN** a run directory is resolved from two different working directories inside the same repository, or via a symlinked path to it
- **THEN** both resolve to the same directory

#### Scenario: Repository untouched
- **WHEN** a run completes
- **THEN** the repository contains no orchestrator files other than an optional `orchestrator.yaml`

#### Scenario: Runs listing
- **WHEN** `runs` is invoked with two run directories present and one daemon alive
- **THEN** both runs are listed with their repository paths and only one is marked alive

### Requirement: Daemon lifecycle and discovery
`start` SHALL be idempotent: if `daemon.pid` names a live process and the recorded URL answers `status`, it SHALL return that URL; otherwise it SHALL spawn the daemon detached with output to `daemon.log`, write `daemon.pid`, wait for the URL to answer within a bounded time, and return it. A stale pid file SHALL be ignored. `stop` SHALL invoke the `shutdown` route and fall back to a signal. The daemon SHALL record its chosen port and SHALL reuse it on the next start when it is free, so that agents launched before a restart reach the daemon after it.

#### Scenario: Start twice
- **WHEN** `start` is invoked while the daemon is already running
- **THEN** no second process is spawned and the existing URL is returned

#### Scenario: Port reuse across restart
- **WHEN** the daemon is stopped gracefully while an agent is mid-task and then started again
- **THEN** it listens on the same port and the agent's next API call succeeds without using the fallback file

#### Scenario: Stale pid file
- **WHEN** `daemon.pid` names a dead process
- **THEN** `start` spawns a new daemon and overwrites the file

### Requirement: Event stream
The daemon SHALL expose `events` returning events after a given sequence number, optionally filtered by kind and limited in count, with an optional `wait` that holds the request until at least one new event exists or the wait elapses, capped by the daemon at two minutes. The response SHALL include the events, the latest sequence number, and a digest with `openQuestions`, `awaitingReview`, `finished`, `stalled`, `running`, and `blocked`.

#### Scenario: Long-poll returns on the next event
- **WHEN** `events` is requested with `after` equal to the latest sequence and a wait of thirty seconds, and a task submits two seconds later
- **THEN** the request returns within three seconds with that event and the updated digest

#### Scenario: Wait elapses
- **WHEN** no event occurs within the wait
- **THEN** the request returns an empty list with the unchanged sequence and the current digest

### Requirement: Review bundle
`review` for a gated milestone in `submitted` SHALL return its pinned `integrationSha`, `reviewVersion`, tag name, the baseline sha, a diff stat between baseline and pinned sha, and for every task in the milestone's closure its id, published sha, and completion report summary. For a milestone not in `submitted` it SHALL return an error naming the current status.

#### Scenario: Bundle for a submitted milestone
- **WHEN** MVP is submitted at version 2 over tasks T3 and T4
- **THEN** `review` returns the sha, version 2, tag `milestone/MVP/v2`, a diff stat, and two closure entries with summaries

### Requirement: Graph import through the daemon
`import` SHALL accept graph content or a node list, validate it with the graph loader, write the run's graph file atomically on success, trigger a reload, and return the new revision together with the reload classification and reasons. On validation failure nothing SHALL be written and the errors SHALL be returned.

#### Scenario: Valid import is adopted
- **WHEN** a valid graph is imported while no graph is active
- **THEN** the file is written, the daemon reports the new revision as active, and the response says accepted

#### Scenario: Incompatible import is rejected
- **WHEN** an import removes a running task
- **THEN** the file is written, the reload is rejected, the previous revision stays active, and the response says rejected with the reasons

#### Scenario: Invalid graph is not written
- **WHEN** the imported content has a dependency cycle
- **THEN** nothing is written and the response lists the cycle path
