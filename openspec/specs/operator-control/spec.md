# Operator Control Specification

## Purpose
The HTTP-backed operator interface, reached through both a CLI and an MCP server, and its operations: status, answers, cancellation, reopen and unblock, milestone review, pause and resume, shutdown, and logs, together with per-user run directories, daemon lifecycle and discovery, the event stream, the review bundle, graph import through the daemon, the tracker outbox routes a drainer uses to list, acknowledge, and reject tracker-bound effects, the health operations (`nudge` to reach a running agent through its inbox, the health facts `status` reports such as stuck tasks, cost, and budgets, and the cost-budget pause that `resume` lifts only with an override), the `cascade` flag on `reopen` that resets the started closure downstream of the target and returns its plan, the proposal operations (`proposals`, `accept_proposal`, and `reject_proposal`) through which a human decides the follow-up work agents propose, and the pull-runner operations (`claim` and `release`, through which a worker takes a prepared launch and hands it back, and the `mode` override that `start` and the `runner` route apply to a run) together with the `runner`, `claimable`, and `workers` facts `status` reports, where every human action is recorded as an event.

## Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, and `mode`. Humans and host sessions SHALL act only through this interface.

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

### Requirement: Tracker outbox
The daemon SHALL expose `outbox`, returning pending effects with `id` greater than `after` in `id` order, limited in count, together with the tracker policy; `ack`, marking an effect `applied` with the drainer's result; and `nack`, recording the error and either keeping the effect `pending` with `attempts` increased or marking it `failed` at `tracker.maxAttempts`. An unknown effect id SHALL be answered 404. Both the CLI and the MCP server SHALL expose `outbox` and `ack`, the latter taking a result or an error. `status` SHALL additionally report `tracker` (the recorded kind and workspace, or none), `outboxPending` (the count of pending effects), and `trackerErrors` (every `failed` effect with its id, issue, kind, attempts, and error); the event stream digest SHALL carry `outboxPending` and `trackerErrors`.

#### Scenario: List then acknowledge
- **WHEN** two effects are pending and `ack` is posted for the first with result `{ commentId: "c1" }`
- **THEN** `outbox` returns only the second and `status` shows `outboxPending` 1

#### Scenario: Rejected effect retried then surfaced
- **WHEN** `nack` is posted for an effect three times with `maxAttempts` 3
- **THEN** the effect is returned by `outbox` after the first two, and after the third it is absent from `outbox` and present in `trackerErrors` with its last error

#### Scenario: Status reports the tracker
- **WHEN** a tracker of kind `linear` was recorded at import
- **THEN** `status` includes `tracker.kind` `linear`

### Requirement: Nudge
`nudge` SHALL take a task id and a message, SHALL record an operator event, and SHALL queue an inbox notice `{ kind: 'nudge', message }` on the task's live launch. It SHALL be reachable as `POST /v1/tasks/:id/nudge`, as the CLI command `nudge <task> <message>`, and as the MCP tool `nudge`. A task with no live launch SHALL be answered with 409 naming its status.

#### Scenario: Nudge a running task
- **WHEN** an operator nudges running task T2 with a message
- **THEN** the event log contains an operator nudge event for T2 with the message and T2's live launch holds the notice

#### Scenario: Nudge without a live launch
- **WHEN** an operator nudges a task that is `unstarted`
- **THEN** the response is 409 naming `unstarted` and no notice is queued

### Requirement: Status report: health facts
`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, and `overrides`, `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` when known.

#### Scenario: Stuck task is visible
- **WHEN** T3's launch has been flagged stuck for two minutes
- **THEN** `status` lists T3 under `stuck` and its launch entry shows `stuck` true with `idleMs` and `lastSignal`

#### Scenario: Cost is reported
- **WHEN** two launches recorded 1.25 and 0.75 USD
- **THEN** `status` shows `cost.runUsd` 2 and `cost.byTask` with both tasks

### Requirement: Budget pause and override
When the run cost budget is reached, the run SHALL be paused with `pausedReason: 'costBudget'`, stored as durably as an operator pause, while running work and verification continue. `resume` SHALL accept `overrideBudget`. Without it, `resume` while the run cost is at or above the ceiling SHALL be refused with 409 naming `costBudget`, the run cost, and the ceiling. With it, the override SHALL be recorded as an operator event and the pause lifted. The CLI flag SHALL be `--override-budget`.

#### Scenario: Resume refused over budget
- **WHEN** the run is paused for `costBudget` and `resume` is called without `overrideBudget`
- **THEN** the response is 409 with `costBudget`, the run cost, and the ceiling, and the run stays paused

#### Scenario: Resume with override
- **WHEN** `resume` is called with `overrideBudget` true
- **THEN** an operator resume event with the override is recorded, the pause is lifted, and admission continues

### Requirement: Reopen with cascade
`reopen` SHALL accept an optional `cascade` flag: a `cascade` field in the route body, `--cascade` on the CLI, and a parameter on the MCP tool. Without it, a reopen whose target has started non-milestone dependents reachable through milestones SHALL be refused with 409 and `blockers`. With it, the daemon SHALL compute the cascade plan, refuse with 409 naming the task when any job in the plan is `publishing`, and otherwise record the `operator.reopen` event with the plan, return `reset: [{ id, from }]`, and apply the plan in the next tick. A plain reopen SHALL return `reset` listing the milestones it resets.

#### Scenario: Plain reopen names the blockers
- **WHEN** a human reopens T1 without cascade while T2 is running
- **THEN** the response is 409 with `blockers` containing T2 and nothing changes

#### Scenario: Cascade returns the plan
- **WHEN** a human reopens T1 with cascade while T2 is running and MVP is submitted
- **THEN** the response lists T1 from `done`, T2 from `running`, and MVP from `submitted`, the `operator.reopen` event carries the same plan, and after the next tick all three are `unstarted`

#### Scenario: Cascade refused during publication
- **WHEN** a human reopens T1 with cascade while T2's job is `publishing`
- **THEN** the response is 409 naming T2 and no event other than the refusal is recorded

### Requirement: Proposals
The operator interface SHALL gain `proposals`, which lists proposals filtered by status with pending as the default, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and a required `note`. Each SHALL be recorded as an operator event. Accepting SHALL append a task node to the run's graph file whose id is `nodeId` when given and the proposal id otherwise, whose `deps` are the proposal's deps plus the proposing task, and whose payload is the proposal's title, description, acceptance criteria, labels, and scope merged with `payload`, plus `proposal` and `proposedBy`. When `proposals.joinMilestone` is true (the default) the node SHALL also be added to the `deps` of every gated milestone whose closure contains the proposing task. The file SHALL be validated and written atomically, reloaded, and the proposal marked `accepted` with the node id; on validation failure nothing SHALL be written and the proposal SHALL stay pending. Accepting a proposal whose node is already in the file SHALL mark it accepted without writing. Rejecting SHALL mark the proposal `rejected` with the note.

#### Scenario: Accept with a tracker id
- **WHEN** `T2-p1` with deps [T3] is accepted with `nodeId` ENG-77
- **THEN** the graph file gains task ENG-77 with deps [T3, T2] and the proposal's payload, the reload is compatible, and `T2-p1` is `accepted` with node ENG-77

#### Scenario: Accept without a node id
- **WHEN** `T2-p1` is accepted with no `nodeId`
- **THEN** the new node's id is `T2-p1`, it becomes ready only after T2 is done, and it runs after T2

#### Scenario: Join the proposer's milestone
- **WHEN** T2 is in the closure of the gated milestone MVP, MVP is submitted, and `T2-p1` is accepted with `joinMilestone` at its default
- **THEN** MVP's deps include the new node, the reload is compatible, and MVP is reset to `unstarted` until the node is done

#### Scenario: Reject
- **WHEN** `T2-p2` is rejected with a note
- **THEN** it is `rejected` with the note, the graph is unchanged, and it no longer appears under pending

#### Scenario: Accept is idempotent
- **WHEN** `T2-p1` is accepted twice
- **THEN** the second call reports it accepted with the same node and the graph file is not rewritten

### Requirement: Status report: proposals
`status` and the event-stream digest SHALL list `proposals`, every pending proposal with its id, proposing task, and title.

#### Scenario: Pending proposals visible
- **WHEN** T2 submitted with one proposal and nothing has decided it
- **THEN** `status` and the digest list `T2-p1` with task T2 and its title, and an accepted or rejected proposal is not listed

### Requirement: Claims and releases
The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification. Each SHALL be recorded as an event with its arguments before its effect. The CLI and the MCP server SHALL expose `claim`, `release`, and the mode override through these routes. A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them.

#### Scenario: Claim is auditable
- **WHEN** a worker claims T1
- **THEN** the event log contains a `launch.claimed` event for T1 with the worker id, followed by the launch becoming live

#### Scenario: Mode override is durable
- **WHEN** `PUT /v1/runner` sets mode `pull` and the daemon restarts
- **THEN** the mode is still `pull`

#### Scenario: Reap leaves workers alone
- **WHEN** the daemon is stopped with reap while a worker holds a launch
- **THEN** the launch stays live, its task stays `running`, and the worker's next call succeeds after the daemon restarts

### Requirement: Status report: workers
`status` SHALL additionally report `runner` with the effective `mode` and `claimWindowMs`, `claimable` as the ids of tasks whose launch is claimable in claim order, and `workers` as `[{ id, launchId, taskId, claimedAt }]` for every live launch held by a worker. The `events` digest SHALL additionally include `claimable`, the number of claimable launches.

#### Scenario: Parked and claimed launches are visible
- **WHEN** T1 is parked and T2 is held by worker `w1`
- **THEN** `status` shows `claimable: [T1]` and `workers` containing `w1` with T2's launch, and the digest shows `claimable: 1`
