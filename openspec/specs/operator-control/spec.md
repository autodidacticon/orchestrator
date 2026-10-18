# Operator Control Specification

## Purpose
The HTTP-backed operator interface, reached through both a CLI and an MCP server, and its operations: status, answers, cancellation, reopen and unblock, milestone review, pause and resume, shutdown, and logs, together with per-user run directories, daemon lifecycle and discovery, the event stream, the review bundle, graph import through the daemon, the tracker outbox routes a drainer uses to list, acknowledge, and reject tracker-bound effects, the health operations (`nudge` to reach a running agent through its inbox, the health facts `status` reports such as stuck tasks, cost, and budgets, and the cost-budget pause that `resume` lifts only with an override), the `cascade` flag on `reopen` that resets the started closure downstream of the target and returns its plan, the proposal operations (`proposals`, `accept_proposal`, and `reject_proposal`) through which a human decides the follow-up work agents propose, and the pull-runner operations (`claim` and `release`, through which a worker takes a prepared launch and hands it back, and the `mode` override that `start` and the `runner` route apply to a run) together with the `runner`, `claimable`, and `workers` facts `status` reports, where every human action is recorded as an event.

## Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode and configuration arguments, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, `mode`, and `config` to show and set the configuration. Humans and host sessions SHALL act only through this interface.

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
`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number, and `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list. The event digest SHALL carry `claimableByKind` beside its `claimable` count.

#### Scenario: Stalled run names its roots
- **WHEN** the run is stalled on a failed T1
- **THEN** `status` shows `stalled` true and `stallRoots` containing T1 with its reason

#### Scenario: Rejected reload is visible
- **WHEN** the last reload was incompatible
- **THEN** `status` shows `graphRejected` with the reasons and the revision still in force

#### Scenario: Run facts are reported
- **WHEN** `status` is requested
- **THEN** it includes the run directory, graph path, daemon pid and URL, and the latest event sequence number

#### Scenario: Claimable launches counted per kind
- **WHEN** one launch is parked for `claude-code` and one for `codex`
- **THEN** `status.claimable` lists both tasks and `status.claimableByKind` is `{ "claude-code": 1, "codex": 1 }`, and the digest shows `claimable: 2` with the same `claimableByKind`

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
Graceful shutdown SHALL stop admission, flush pending transactions, and exit while leaving agent processes running for adoption on the next start. A reaping shutdown SHALL additionally terminate every live agent process. Both SHALL be reachable by signal and by the `shutdown` route with a `reap` flag. The `shutdown` route SHALL record its caller before stopping: the `x-orch-attachment` header when present, the remote address, and the user agent, as `by` in an `operator.shutdown` event carrying `reap`, and the same `by` SHALL reach the exit record.

#### Scenario: Graceful shutdown keeps agents
- **WHEN** the daemon is stopped gracefully with agents running
- **THEN** the agents keep running and are adopted when the daemon restarts

#### Scenario: Reap shutdown stops agents
- **WHEN** the daemon is stopped with reap, by flag or by route
- **THEN** every live agent process is terminated and their tasks are `failed` with reason `reaped`

#### Scenario: Shutdown names its caller
- **WHEN** `POST /v1/shutdown` arrives with `x-orch-attachment: a1` from 127.0.0.1
- **THEN** the event log holds `operator.shutdown` with `reap` and `by: { attachment: "a1", remote: "127.0.0.1", userAgent }`, and the exit record carries the same `by`

### Requirement: Logs
`logs` SHALL print the captured stdout and stderr of a given task's launch, defaulting to the most recent launch.

#### Scenario: Logs for a specific launch
- **WHEN** `logs T2 --launch 2` is run
- **THEN** the output is the log file of T2's second launch

### Requirement: Run directory
Run data SHALL live outside the repository in `$ORCH_HOME/runs/<id>/`, where `ORCH_HOME` defaults to `~/.orchestrator` and `<id>` is the first sixteen hex digits of the SHA-256 of the repository's real path. The run directory SHALL contain a `repo` file with that path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, `daemon.pid`, and `daemon.json` with the daemon's pid, URL, port, start time, repository, and, after a graceful exit, the exit record. The CLI and MCP server SHALL resolve the run directory from an explicit repository argument or from the git top level of the working directory. A `runs` operation SHALL list every run with its repository path, whether its daemon is alive, a status digest when it is, and otherwise the exit record or its absence.

#### Scenario: Same repository, same run
- **WHEN** a run directory is resolved from two different working directories inside the same repository, or via a symlinked path to it
- **THEN** both resolve to the same directory

#### Scenario: Repository untouched
- **WHEN** a run completes
- **THEN** the repository contains no orchestrator files other than an optional `orchestrator.yaml`

#### Scenario: Runs listing
- **WHEN** `runs` is invoked with two run directories present and one daemon alive
- **THEN** both runs are listed with their repository paths and only one is marked alive

#### Scenario: Runs listing shows why a daemon is gone
- **WHEN** `runs` is invoked after one run's daemon exited idle and another's was killed
- **THEN** the first is listed with `exit.reason` `idle` and its last digest, and the second with no exit record

### Requirement: Daemon lifecycle and discovery
`start` SHALL be idempotent: if `daemon.pid` names a live process and the recorded URL answers `status`, it SHALL return that URL; otherwise it SHALL spawn the daemon detached with output to `daemon.log`, write `daemon.pid`, wait for the URL to answer within a bounded time, and return it. A stale pid file SHALL be ignored. `stop` SHALL invoke the `shutdown` route and fall back to a signal. The daemon SHALL record its chosen port and SHALL reuse it on the next start when it is free, so that agents launched before a restart reach the daemon after it. The daemon SHALL accept `--default-mode <spawn|pull|mixed>`, which SHALL become the run's durable mode override only when the store holds none and the repository's `orchestrator.yaml` does not set `runner.mode`; `--mode` SHALL keep setting the override unconditionally. A daemon started after an idle exit SHALL run recovery as after any stop and SHALL find nothing to adopt.

#### Scenario: Start twice
- **WHEN** `start` is invoked while the daemon is already running
- **THEN** no second process is spawned and the existing URL is returned

#### Scenario: Port reuse across restart
- **WHEN** the daemon is stopped gracefully while an agent is mid-task and then started again
- **THEN** it listens on the same port and the agent's next API call succeeds without using the fallback file

#### Scenario: Stale pid file
- **WHEN** `daemon.pid` names a dead process
- **THEN** `start` spawns a new daemon and overwrites the file

#### Scenario: Default mode yields to an existing choice
- **WHEN** the daemon is started with `--default-mode pull` for a run whose store already holds the override `spawn`, or whose `orchestrator.yaml` sets `runner.mode: spawn`
- **THEN** the mode in force is `spawn`

#### Scenario: Default mode applies to a fresh run
- **WHEN** the daemon is started with `--default-mode pull` for a run with no override and no `runner.mode` in its config
- **THEN** the mode in force is `pull` and it survives a restart without the flag

#### Scenario: Revived daemon has nothing to adopt
- **WHEN** the daemon exited idle with a milestone awaiting review and a blocked question and is started again
- **THEN** recovery ends no launch, the milestone is still `submitted` at the same version, the question is still open, and the pending outbox rows are untouched

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
`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`), `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known.

#### Scenario: Stuck task is visible
- **WHEN** T3's launch has been flagged stuck for two minutes
- **THEN** `status` lists T3 under `stuck` and its launch entry shows `stuck` true with `idleMs` and `lastSignal`

#### Scenario: Cost is reported
- **WHEN** two launches recorded 1.25 and 0.75 USD
- **THEN** `status` shows `cost.runUsd` 2 and `cost.byTask` with both tasks, and `cost.unpricedLaunches` 0

#### Scenario: Tokens without a price are reported
- **WHEN** T1's launch recorded 40361 input and 260 output tokens and no cost
- **THEN** `status` shows `tokens.run` and `tokens.byTask.T1` as `{ input: 40361, output: 260 }`, `cost.runUsd` 0, and `cost.unpricedLaunches` 1

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
The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification; a claim body MAY carry `attachment` and a release body MAY carry `keep`. Each SHALL be recorded as an event with its arguments before its effect. The CLI and the MCP server SHALL expose `claim`, `release` (with `--keep` on the CLI and `keep` on the tool), and the mode override through these routes. A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them.

#### Scenario: Claim is auditable
- **WHEN** a worker claims T1
- **THEN** the event log contains a `launch.claimed` event for T1 with the worker id, followed by the launch becoming live

#### Scenario: Mode override is durable
- **WHEN** `PUT /v1/runner` sets mode `pull` and the daemon restarts
- **THEN** the mode is still `pull`

#### Scenario: Reap leaves workers alone
- **WHEN** the daemon is stopped with reap while a worker holds a launch
- **THEN** the launch stays live, its task stays `running`, and the worker's next call succeeds after the daemon restarts

#### Scenario: Kept release through the CLI
- **WHEN** `orchestrator-ctl release <launchId> --keep --reason "session ending"` is run for a launch with commits
- **THEN** the `operator.release` event carries `keep` true and the task is `unstarted` with `attempts` unchanged

### Requirement: Status report: workers
`status` SHALL additionally report `runner` with the effective `mode` and `claimWindowMs`, `claimable` as the ids of tasks whose launch is claimable in claim order, and `workers` as `[{ id, launchId, taskId, claimedAt }]` for every live launch held by a worker. The `events` digest SHALL additionally include `claimable`, the number of claimable launches.

#### Scenario: Parked and claimed launches are visible
- **WHEN** T1 is parked and T2 is held by worker `w1`
- **THEN** `status` shows `claimable: [T1]` and `workers` containing `w1` with T2's launch, and the digest shows `claimable: 1`

### Requirement: Status report: deferred candidates
`status` SHALL report `deferred`: the candidates skipped by the scope filter in the most recent admission pass, each as `{ id, reason, with }` where `reason` is `scopeOverlap` and `with` lists the ids whose scopes it overlaps. The event stream digest SHALL carry `deferred` as the count of those candidates. A paused run SHALL report an empty list.

#### Scenario: Deferred candidate explained
- **WHEN** T3 is deferred because its scope overlaps running T2
- **THEN** `status` lists `{ id: T3, reason: scopeOverlap, with: [T2] }` and the digest reports `deferred` 1

#### Scenario: Nothing deferred
- **WHEN** no candidate overlaps a held scope
- **THEN** `deferred` is an empty list and the digest reports 0

### Requirement: Idle exit
The configuration SHALL accept `daemon.idleExitMs`, an integer in milliseconds defaulting to 600000 where 0 disables the exit, and `daemon.exitWhileAttached`, a boolean defaulting to false. The daemon SHALL be quiescent when the store holds no launch in `preparing`, `launching`, or `live`; no claimable launch whose claim window is finite and has not elapsed (zero in `spawn`, `runner.claimWindowMs` in `mixed`, unbounded in `pull`); no verifier job in `queued`, `checking`, `verified`, or `publishing`; no job in a terminal status not yet applied; and no pending cascade. Activity SHALL be the end of any request the API server dispatches other than a probe, a tick at which the daemon was not quiescent, and, unless `exitWhileAttached` is true, a tick at which an attachment was alive. A probe is `GET /v1/status` with `probe=1`, `GET /healthz`, or `GET /readyz` (see specs/cluster-runtime "Probes"). The daemon SHALL be idle only while quiescent, with no request in flight, and with no live attachment unless `exitWhileAttached` is true; its idle time SHALL be the time since the last activity and zero otherwise. After every tick, when `idleExitMs` is positive and the idle time reaches it, the daemon SHALL append the event `daemon.idleExit` with `idleMs` and SHALL stop gracefully, keeping agents for adoption, with the exit record reason `idle`. Pending tracker effects, an unfinished graph, blocked tasks, and a milestone awaiting review SHALL NOT count as activity. `status` SHALL report `idle: { quiescent, idleMs, exitAfterMs }`.

#### Scenario: Finished run exits after the window
- **WHEN** a run finishes, no session is attached, and no request other than probes arrives for `idleExitMs`
- **THEN** the daemon records `daemon.idleExit`, exits with code 0, and `daemon.json` carries `exit.reason` `idle`

#### Scenario: Open long-poll keeps it alive
- **WHEN** the run is quiescent and a client holds `GET /v1/events?wait=30000` open past the window
- **THEN** the daemon does not exit while the request is open, and the idle clock starts when the request ends

#### Scenario: Probes do not count
- **WHEN** `GET /v1/status?probe=1` is called every minute on a quiescent daemon with a five-minute window
- **THEN** the daemon exits after five minutes as if no request had arrived

#### Scenario: Health probes do not count either
- **WHEN** a quiescent daemon receives a long sequence of `GET /healthz` and `GET /readyz` calls
- **THEN** `idle.idleMs` keeps growing, and a plain `GET /v1/status` afterwards resets it to zero

#### Scenario: Parked launches do not keep a pull run alive
- **WHEN** the mode is `pull`, two launches are parked, and no worker claims for `idleExitMs`
- **THEN** the daemon exits and both launches are still `claimable` when it is revived

#### Scenario: Parked launch within a mixed window counts
- **WHEN** the mode is `mixed` with a two-minute claim window and a launch was parked thirty seconds ago
- **THEN** `idle.quiescent` is false until the launch is spawned

#### Scenario: Verification keeps it alive
- **WHEN** the last task has submitted and its verifier job is `checking`
- **THEN** `idle.quiescent` is false and the daemon does not exit until the job is applied

#### Scenario: Attached session keeps it alive
- **WHEN** an attachment with a live pid exists and `exitWhileAttached` is false
- **THEN** `idle.idleMs` stays zero however long no request arrives

#### Scenario: Disabled
- **WHEN** `daemon.idleExitMs` is 0
- **THEN** the daemon never exits on its own and `idle.exitAfterMs` is 0

### Requirement: Exit record
On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest, by? }` into `daemon.json` after the orchestrator has stopped and before the process ends, where `reason` is `stop`, `signal`, or `idle`, `digest` is the event-stream digest at that moment, and `by`, present for a `stop`, names the caller as recorded by the `shutdown` route. A daemon that starts SHALL write `daemon.json` without `exit`. A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash. `runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists, and the revival refusal after a `stop` SHALL name the caller when one was recorded.

#### Scenario: Stop records the reason
- **WHEN** the daemon is stopped through the `shutdown` route with `reap` false
- **THEN** `daemon.json` carries `exit` with reason `stop`, `reap` false, the digest, and `by` with the caller's remote address

#### Scenario: Crash leaves no record
- **WHEN** the daemon is killed with SIGKILL
- **THEN** `runs` lists the run as not alive with no exit record

#### Scenario: Restart clears the record
- **WHEN** a daemon that exited idle is started again
- **THEN** `daemon.json` has no `exit` while it runs

### Requirement: Revive on demand
When an operator operation other than `start`, `stop`, or `runs` finds no healthy daemon for a run directory that holds a store, the CLI and the operator MCP server SHALL start the daemon as `start` would and proceed with the operation when the last exit record is `idle` or absent, and SHALL refuse with an error naming the stop time and `start` when the last exit record is `stop` or `signal`. A repository with no run directory SHALL be refused as today.

#### Scenario: Revived after idle exit
- **WHEN** the daemon exited idle and the session calls `accept` for the milestone it was reviewing
- **THEN** a daemon is spawned, the milestone is accepted, and the response is the route's response

#### Scenario: Revived after a crash
- **WHEN** the daemon crashed while an agent was mid-task and `status` is called
- **THEN** a daemon is spawned, recovery adopts the agent, and `status` lists the task as running

#### Scenario: Not revived after stop
- **WHEN** the daemon was stopped with `stop` and `status` is called
- **THEN** the call fails naming the stop time and suggesting `start`, and no daemon is spawned

### Requirement: Container mode
The daemon SHALL run as a long-lived foreground process. On SIGTERM or SIGINT it SHALL stop the tick loop, finish the in-flight tick and verifier job, close the API server and its open connections, write the exit record with reason `signal`, and exit 0. When that takes longer than 8 seconds it SHALL write the exit record and exit 0 anyway; a check abandoned that way restarts from `queued` on the next start, as after a crash. The daemon SHALL write `daemon.pid` and `daemon.json` in its data directory itself, whether or not a client spawned it; in a container nothing reads them. When `ORCH_LOG_FORMAT` is `json`, every line the daemon logs on stderr SHALL be one JSON object with `ts`, `level`, and `msg` first, followed by the data fields; a data field named `ts`, `level`, or `msg` is dropped. Any other value SHALL keep the text format. `daemon.idleExitMs: 0` keeps the daemon running however long it is idle (see "Idle exit"). When `ORCH_URL` names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`, the client-side `start` and revival SHALL NOT spawn a local daemon: revival returns nothing to revive when the URL answers a probe and otherwise fails naming the URL as unreachable, and `start` refuses. The operator MCP server SHALL use such a URL directly, without registering an attachment, since the pids it would register are not the daemon's. The bind address, advertised URL, probes, image, and manifests a container needs are specified in specs/cluster-runtime.

#### Scenario: SIGTERM mid-check
- **WHEN** the daemon receives SIGTERM while a verifier job is `checking`
- **THEN** the job is published, the server closes, `daemon.json` carries `exit` with reason `signal`, and the process exits 0 within ten seconds

#### Scenario: Never idle when disabled
- **WHEN** `daemon.idleExitMs` is 0 and the daemon is quiescent past a short window
- **THEN** it is still alive and answering

#### Scenario: Remote URL unreachable
- **WHEN** `ORCH_URL` is `http://orchestrator.orch.svc:8080`, nothing answers there, and an operation would revive the daemon
- **THEN** the operation fails naming that URL as unreachable, and no local daemon is spawned

#### Scenario: Loopback URL still revives
- **WHEN** `ORCH_URL` is a loopback URL whose daemon exited idle and an operation needs it
- **THEN** a local daemon is spawned as before

#### Scenario: JSON logs
- **WHEN** the daemon runs with `ORCH_LOG_FORMAT=json`
- **THEN** every stderr line parses as a JSON object with `ts`, `level`, and `msg` first and the data fields after, and the text format is unchanged without the variable

### Requirement: Session attachments
The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain); `POST /v1/attachments/:id/end` with `{ reason }`, recording the end; and `POST /v1/attachments/ended` with `{ pids, reason }`, recording the end of every live attachment whose chain contains any pid in `pids`. An operator request MAY carry the header `x-orch-attachment` naming the caller's attachment; when that id is not a live attachment the daemon SHALL still perform the operation and SHALL add the response header `x-orch-attachment: unknown`. A claim MAY carry `attachment`, stored on the launch's worker record. At every reconcile the daemon SHALL end any attachment whose first pid is dead, SHALL release with `keep` and reason `sessionEnded` every live claimed launch whose worker carries an ended attachment, SHALL append `attachment.ended`, and SHALL remove the record. `status` SHALL report `attachments` as `[{ id, pids, since, launches }]` for live attachments. The end routes SHALL respond once the end is recorded, before any release.

#### Scenario: Dead attachment releases its launches
- **WHEN** a worker claimed T2 through an attachment whose first pid has since died
- **THEN** the next reconcile releases T2's launch with `keep`, T2 is `unstarted` with `attempts` unchanged, and the attachment is gone from `status`

#### Scenario: Session end by ancestry
- **WHEN** `POST /v1/attachments/ended` names a pid that is in an attachment's chain but is neither its own pid nor its parent, as the session process is above the launcher and `npx`
- **THEN** the response is immediate, the attachment is recorded as ended, and the next reconcile releases its launch with `keep`

#### Scenario: Unknown attachment flagged
- **WHEN** `status` is called with `x-orch-attachment` naming an attachment that has ended
- **THEN** the response is the current status and carries the header `x-orch-attachment: unknown`

#### Scenario: Attachment without launches
- **WHEN** an attachment that holds no launch ends
- **THEN** nothing is released and the attachment is removed

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, and `codex` (the per-kind leaves), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude` and `codex` leaves with their sources. It SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` clears one leaf). `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force. The CLI usage SHALL name both kinds' default models and efforts (`claude-opus-5-5` and `gpt-6-astra`, both at `medium`) and SHALL say that `ultra` is codex-only.

#### Scenario: Set the check command
- **WHEN** `PUT /v1/config` carries `{ checkCommand: "npm test" }` while it was unresolved
- **THEN** the response lists `checkCommand` under `applied` with source `argument`, the event log holds `operator.config` with the patch, and `needsConfig` is empty

#### Scenario: Show the configuration
- **WHEN** `orchestrator-ctl config` is run without flags
- **THEN** it prints every key with its value and source, the toolchain record, and `needsConfig`

#### Scenario: Add a tool rule from the CLI
- **WHEN** `orchestrator-ctl config --allow "Bash(docker:*)"` is run
- **THEN** the allow list's `argument` part contains the rule and the next spawned launch is given it

#### Scenario: Mixed request applies nothing
- **WHEN** `PUT /v1/config` carries a valid `capacity` and an invalid `checkCommand` of empty string
- **THEN** the response is 400 naming `checkCommand` and the capacity is unchanged

#### Scenario: Set the effort from the CLI
- **WHEN** `orchestrator-ctl config --effort high` is run
- **THEN** `config.effort` is `{ value: "high", source: "argument" }` and the next prepared launch has `effort: high`

#### Scenario: Select Codex from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind codex --sandbox danger-full-access` is run and then `orchestrator-ctl config` is run without flags
- **THEN** it prints `runnerKind` as `{ value: "codex", source: "argument" }`, `codex.sandbox` as `{ value: "danger-full-access", source: "argument" }`, and `codex.commit` as `{ value: "agent", source: "default" }`

#### Scenario: Commit policy binds to the kind in force
- **WHEN** the kind in force is `codex` and `orchestrator-ctl config --commit daemon` is run
- **THEN** `codex.commit` is `{ value: "daemon", source: "argument" }` and `claude.commit` is unchanged

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude` and `codex` leaves (among them `codex.sandbox` and each kind's `commit`); `toolchain`, the detection record; and `needsConfig`, the keys whose value is unresolved. Each entry of `liveLaunches` SHALL carry the launch's `runner`, `model`, and `effort`. The event stream digest SHALL carry `needsConfig`. The configuration facts SHALL be present when no graph is loaded.

#### Scenario: Detected values visible
- **WHEN** `status` is requested in a Node repository started without a file
- **THEN** `config.checkCommand` is `{ value: "npm test", source: "detected" }`, `config.integrationBranch` names the detected branch with its source, `config.runnerKind` is `{ value: "claude-code", source: "default" }`, `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`, and `toolchain.kinds` contains `node`

#### Scenario: Unresolved check command visible
- **WHEN** the repository has no recognised manifest and no file
- **THEN** `status.needsConfig` and the digest's `needsConfig` both equal `["checkCommand"]`

#### Scenario: Reported before a graph is loaded
- **WHEN** `status` is requested before any graph has been imported
- **THEN** the response carries `config`, `toolchain`, and `needsConfig` alongside `error: graph not loaded`

#### Scenario: Live launch selection visible
- **WHEN** T2 is live from a task that declares `effort: high`
- **THEN** `status.liveLaunches` has T2 with `runner: "claude-code"`, `effort: "high"`, and `model: "claude-opus-5-5"`

#### Scenario: Codex leaves visible
- **WHEN** `status` is requested on a run whose file sets `runner.kind: codex`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `gpt-6-astra`, and `config.codex.sandbox` and `config.codex.commit` carry their values and sources

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, and `codex` beside `mode`. When it spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy. `orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving. The daemon's usage SHALL list these keys.

#### Scenario: Model set at start
- **WHEN** `start` is called with `model: "claude-sonnet-5-5"` in a repository with no running daemon
- **THEN** the daemon is spawned with `--set model=claude-sonnet-5-5` and the result's `config.model` is `{ value: "claude-sonnet-5-5", source: "argument", applied: true }`

#### Scenario: Invalid effort refused before serving
- **WHEN** the daemon is started with `--set effort=huge`
- **THEN** it exits with a usage error naming `effort` and never serves

#### Scenario: Codex selected at start
- **WHEN** `orchestrator-ctl start --set runnerKind=codex --set codex.sandbox=read-only` is run in a repository with no running daemon
- **THEN** the result's `config.runnerKind` is `{ value: "codex", source: "argument" }` and `config.codex.sandbox` is `{ value: "read-only", source: "argument" }`
