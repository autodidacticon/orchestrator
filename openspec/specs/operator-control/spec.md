# Operator Control Specification

## Purpose
The HTTP-backed operator interface, reached through both a CLI and an MCP server, and its operations: status, answers, cancellation, reopen and unblock, milestone review, pause and resume, shutdown, and logs, together with per-user run directories, daemon lifecycle and discovery, the event stream, the review bundle, graph import through the daemon, the tracker outbox routes a drainer uses to list, acknowledge, and reject tracker-bound effects, the health operations (`nudge` to reach a running agent through its inbox, the health facts `status` reports such as stuck tasks, cost, and budgets, and the cost-budget pause that `resume` lifts only with an override), the `cascade` flag on `reopen` that resets the started closure downstream of the target and returns its plan, the proposal operations (`proposals`, `accept_proposal`, and `reject_proposal`) through which a human decides the follow-up work agents propose, and the pull-runner operations (`claim` and `release`, through which a worker takes a prepared launch and hands it back, and the `mode` override that `start` and the `runner` route apply to a run) together with the `runner`, `claimable`, and `workers` facts `status` reports, where every human action is recorded as an event.

## Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. Humans and host sessions SHALL act only through this interface.

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
`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `verifying`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number.

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

#### Scenario: Verifying tasks are told apart from reviews
- **WHEN** task T1 is submitted and awaiting its check and milestone MVP is submitted
- **THEN** `status.awaitingReview` lists T1 and MVP, `status.verifying` lists T1 only, and the digest's `awaitingReview` lists MVP and its `verifying` lists T1

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

#### Scenario: Shutdown names its caller
- **WHEN** `POST /v1/shutdown` arrives with `x-orch-attachment: a1` from 127.0.0.1
- **THEN** the event log holds `operator.shutdown` with `reap` and `by: { attachment: "a1", remote: "127.0.0.1", userAgent }`, and the exit record carries the same `by`

### Requirement: Logs
`logs` SHALL print the captured stdout and stderr of a given task's launch, defaulting to the most recent launch.

#### Scenario: Logs for a specific launch
- **WHEN** `logs T2 --launch 2` is run
- **THEN** the output is the log file of T2's second launch

### Requirement: Run directory
Run data SHALL live outside the repository in `$ORCH_HOME/runs/<id>/`, where `ORCH_HOME` defaults to `~/.orchestrator` and `<id>` is the run id. For a SQLite run the id is the first sixteen hex digits of the SHA-256 of the repository's real path. For a Postgres run it is chosen as specs/state-backend "Run id per deployment" says.

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

#### Scenario: Run directory follows the run id
- **WHEN** a repository's `orchestrator.yaml` selects `store.kind: postgres` with `store.runId: team-a`
- **THEN** the run directory is `$ORCH_HOME/runs/team-a`, and with `store.kind: sqlite` it is the path hash whatever `store.runId` says

### Requirement: Daemon lifecycle and discovery
`start` SHALL be idempotent: if `daemon.pid` names a live process and the recorded URL answers `status`, it SHALL return that URL; otherwise it SHALL spawn the daemon detached with output to `daemon.log`, write `daemon.pid`, wait for the URL to answer within a bounded time, and return it. A stale pid file SHALL be ignored. `stop` SHALL invoke the `shutdown` route and fall back to a signal.

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
`review` for a gated milestone in `submitted` SHALL answer in one of three views, named by the answer's field `view`, and every answer SHALL carry `milestone`, the pinned `integrationSha`, `reviewVersion` and the tag name, so that a caller making several calls can see a resubmission between them. In every answer `view` and `omitted` SHALL be serialised before `diffStat` and `closure`.

#### Scenario: Bundle for a submitted milestone
- **WHEN** MVP is submitted at version 2 over tasks T3 and T4, T3's summary is 1,000 characters, both have evidence, and the diff stat has 45 file lines
- **THEN** `review` returns `view: "index"`, the sha, version 2, tag `milestone/MVP/v2`, a diff stat of 40 file lines, ` ... 5 more files` and the totals line, two closure entries with a title, a summary of at most 400 characters with its `summaryLength` and an `acceptanceCount`, and `omitted` naming `closure.acceptance` 2, `closure.summary` 1 and `diffStat` 5

#### Scenario: One task
- **WHEN** `review` is called for MVP with `task=T3`
- **THEN** it returns `view: "task"`, the same sha, version and tag, `omitted: []`, no diff stat, and one entry with T3's own acceptance criteria and every field of its latest submit report but its proposals

#### Scenario: A task with no report
- **WHEN** T4 was cancelled with release, MVP is submitted, and `review` is called with `task=T4`
- **THEN** it answers 200 with an entry holding `taskId`, `title`, `status` and `acceptanceCriteria` and none of a report's fields

#### Scenario: Whole bundle
- **WHEN** `review` is called for MVP with `full=true`
- **THEN** it returns every key of the whole bundle with its values, `view: "full"` and `omitted: []`

#### Scenario: A task outside the closure
- **WHEN** `review` is called for MVP with `task=NOPE`
- **THEN** it answers 404 with a reason naming NOPE and `closure` listing T3 and T4

#### Scenario: A refused parameter
- **WHEN** `review` is called with `statLines=-1`, or with `task=T3&full=true`
- **THEN** it answers 400 naming `statLines`, or `full`

#### Scenario: A milestone that is not submitted
- **WHEN** `review` is called for a milestone that is running, with or without `task`
- **THEN** it answers 409 with an error naming the current status

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
The daemon SHALL expose `outbox`, returning pending effects with `id` greater than `after` in `id` order, limited in count, together with the tracker policy; `ack`, marking an effect `applied` with the drainer's result; and `nack`, recording the error and either keeping the effect `pending` with `attempts` increased or marking it `failed` at `tracker.maxAttempts`. An unknown effect id SHALL be answered 404.

#### Scenario: List then acknowledge
- **WHEN** two effects are pending and `ack` is posted for the first with result `{ commentId: "c1" }`
- **THEN** `outbox` returns only the second and `status` shows `outboxPending` 1

#### Scenario: Acknowledgement answer omits the payload
- **WHEN** `ack` is posted for a pending `comment` effect with result `{ commentId: "c1" }`
- **THEN** the answer's `effect` has the effect's `id`, `taskId`, `kind` `comment`, `status` `applied`, `attempts` and `result` `{ commentId: "c1" }`, and no `payload`, so the comment body is not returned

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
`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`).

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
`reopen` SHALL accept an optional `cascade` flag: a `cascade` field in the route body, `--cascade` on the CLI, and a parameter on the MCP tool. Without it, a reopen whose target has started non-milestone dependents reachable through milestones SHALL be refused with 409 and `blockers`. A plain reopen SHALL return `reset` listing the milestones it resets.

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
The operator interface SHALL gain `proposals`, which lists proposals filtered by status with pending as the default, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and a required `note`. Each SHALL be recorded as an operator event.

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
The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, `POST /v1/launches/:id/usage`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification; a claim body MAY carry `attachment` and a release body MAY carry `keep`. Each SHALL be recorded as an event with its arguments before its effect; a usage post SHALL be recorded as `operator.usage`.

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

#### Scenario: Usage post is auditable
- **WHEN** a worker posts usage for its ended claimed launch
- **THEN** the event log contains `operator.usage` with the body, followed by `launch.usage` with `source: 'worker'`

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
The configuration SHALL accept `daemon.idleExitMs`, an integer in milliseconds defaulting to 600000 where 0 disables the exit, and `daemon.exitWhileAttached`, a boolean defaulting to false.

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
On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest, by?, unflushedBatches?, storeClosed?, rejected? }` into `daemon.json` after the orchestrator has stopped and before the process ends. `reason` is `stop`, `signal`, or `idle`. `digest` is the event-stream digest taken before the store closes. `by`, present for a `stop`, names the caller as recorded by the `shutdown` route.

#### Scenario: Stop records the reason
- **WHEN** the daemon is stopped through the `shutdown` route with `reap` false
- **THEN** `daemon.json` carries `exit` with reason `stop`, `reap` false, the digest, and `by` with the caller's remote address, and no `unflushedBatches` or `storeClosed`

#### Scenario: Crash leaves no record
- **WHEN** the daemon is killed with SIGKILL
- **THEN** `runs` lists the run as not alive with no exit record

#### Scenario: Restart clears the record
- **WHEN** a daemon that exited idle is started again
- **THEN** `daemon.json` has no `exit` while it runs

#### Scenario: Exit that lost batches
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM
- **THEN** the daemon exits 1, and `exit` carries reason `signal` and `unflushedBatches` equal to the count the daemon logged

#### Scenario: Revival refusal names the loss
- **WHEN** the exit record is a `stop` with `unflushedBatches: 3` and an operation asks for revival
- **THEN** the refusal reads `stop, losing 3 unflushed batches`

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
The daemon SHALL run as a long-lived foreground process. On SIGTERM or SIGINT it SHALL stop the tick loop, finish the in-flight tick and verifier job, close the API server and its open connections, write the exit record with reason `signal`, and exit 0. `daemon.idleExitMs: 0` keeps the daemon running however long it is idle (see "Idle exit").

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
The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, stopping before pid 1, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain).

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

#### Scenario: OpenCode session end by stdio close
- **WHEN** an OpenCode session ends whose operator server holds an attachment with a claimed launch; OpenCode has no session end event, so no hook posts to `POST /v1/attachments/ended`
- **THEN** OpenCode closes the server's stdio, the server posts the end of its own attachment with reason `sessionEnded`, and the next reconcile releases the launch with `keep` and `attempts` unchanged; were the server killed instead, its dead first pid ends the attachment at the next reconcile

#### Scenario: Codex session end by ancestry
- **WHEN** a Codex SessionEnd hook posts `{ pids, reason: "other" }`, where its second pid is the codex process and an attachment's chain is the operator server, its launcher, and that codex process
- **THEN** the attachment is recorded as ended with reason `other`, and the next reconcile releases its launch with `keep` and `attempts` unchanged

#### Scenario: Nested session end leaves the outer session attached
- **WHEN** an attachment's chain is `[S, L, C, T, 1]` (operator server, launcher, session, terminal) and it holds a claimed launch, and a session nested under a shell inside C ends, so its hook posts `[H, N, B, C, T]` (hook, nested session, shell, C, T)
- **THEN** the attachment stays live and the launch stays claimed; a post of `[H, C, T]` or `[H, P, C, T]` ends it and the next reconcile releases the launch with `keep` and `attempts` unchanged

#### Scenario: Far or init pids end nothing
- **WHEN** `POST /v1/attachments/ended` posts a chain whose only pid shared with an attachment's chain is further up than its third position, or is pid 1
- **THEN** the response lists no ended attachment and the attachment stays live

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude`, `codex`, and `opencode` leaves with their sources.

#### Scenario: Select OpenCode from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind opencode --permission allow --data-dir launch` is run, then `orchestrator-ctl config --clear opencode.permission`, then `orchestrator-ctl config --commit daemon --runner-kind opencode`
- **THEN** the bodies sent are `{ runnerKind: "opencode", opencode: { permission: "allow", dataDir: "launch" } }`, `{ opencode: { permission: null } }`, and `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`

#### Scenario: Mistyped data-dir leaf with a daemon URL
- **WHEN** `orchestrator-ctl --url X config --data-dir lanch` is run, or `orchestrator-ctl config --data-dir lanch` with `ORCH_URL` set
- **THEN** the CLI exits non-zero with a message naming `opencode.dataDir`, the values `shared` and `launch`, and the store location, and no request is sent

#### Scenario: Data-dir names the store without a daemon URL
- **WHEN** `orchestrator-ctl config --data-dir <path>` is run with neither `--url` nor `ORCH_URL`
- **THEN** the daemon URL is read from the store under `<path>` and the configuration block is printed

#### Scenario: OpenCode leaves on the configure tool
- **WHEN** the `configure` tool is called with `opencode: { model: "opencode/big-pickle" }`, and then with `runnerKind: "opencode"` and `effort: "ultra"`
- **THEN** the first sets `opencode.model` with source `argument`, and the second is refused with 400 naming `effort` and `opencode`

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

#### Scenario: Clear and set in one call refused
- **WHEN** `orchestrator-ctl config --clear codex --sandbox read-only` is run
- **THEN** the CLI exits non-zero naming `codex` and `codex.sandbox`, and no `PUT /v1/config` is made

#### Scenario: OpenCode leaves fold under their namespace
- **WHEN** `--set opencode.model=opencode/big-pickle --set opencode.dataDir=launch` is given, and the fold receives `{ commit: "daemon", runnerKind: "opencode" }`, and separately `{ opencode: null, dataDir: "launch" }`
- **THEN** the first is `{ opencode: { model: "opencode/big-pickle", dataDir: "launch" } }`, the second `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`, and the third is refused naming `opencode` and `opencode.dataDir`

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude`, `codex`, and `opencode` leaves (among them `codex.sandbox`, `opencode.permission`, `opencode.dataDir`, and each kind's `commit`).

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

#### Scenario: OpenCode leaves visible
- **WHEN** `status` is requested on a run started with `--set runnerKind=opencode`
- **THEN** `config.runnerKind` is `{ value: "opencode", source: "argument" }` and `config.opencode.model` is `{ value: "anthropic/claude-opus-5-5", source: "default" }`, with `opencode.effort`, `opencode.commit`, `opencode.permission`, and `opencode.dataDir` carrying their values and sources

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` beside `mode`. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy.

#### Scenario: OpenCode run defaults to spawn
- **WHEN** the `start` tool is called with `runnerKind: "opencode"` on a run with no configured mode
- **THEN** the result has `mode: "spawn"` and a `modeNote` naming `orchestrator-work --runner opencode`

#### Scenario: Model set at start
- **WHEN** `start` is called with `model: "claude-sonnet-5-5"` in a repository with no running daemon
- **THEN** the daemon is spawned with `--set model=claude-sonnet-5-5` and the result's `config.model` is `{ value: "claude-sonnet-5-5", source: "argument", applied: true }`

#### Scenario: Invalid effort refused before serving
- **WHEN** the daemon is started with `--set effort=huge`
- **THEN** it exits with a usage error naming `effort` and never serves

#### Scenario: Codex selected at start
- **WHEN** `orchestrator-ctl start --set runnerKind=codex --set codex.sandbox=read-only` is run in a repository with no running daemon
- **THEN** the result's `config.runnerKind` is `{ value: "codex", source: "argument" }` and `config.codex.sandbox` is `{ value: "read-only", source: "argument" }`

#### Scenario: Codex run names its work loop
- **WHEN** the `start` tool is called with `runnerKind: "codex"` on a run with no configured mode, and later with `mode: "pull"`
- **THEN** both results carry a `modeNote` naming `orchestrator-work --runner codex`

### Requirement: Revive a local Postgres run
A Postgres run keeps no store file locally. Revival SHALL treat a Postgres run whose run directory holds `daemon.json` (a daemon was started from it) as a local run: refused after an explicit stop or signal, started again after an idle exit or a crash. Only a Postgres run whose run directory has no `daemon.json` SHALL be answered as remote ("pass --url or set ORCH_URL").

#### Scenario: Never started here
- **WHEN** revival is asked for a Postgres run whose run directory has no `daemon.json`
- **THEN** it fails naming the run as remote

#### Scenario: Stopped locally
- **WHEN** revival is asked for a Postgres run whose local daemon was stopped
- **THEN** it fails saying the daemon was stopped and to call start, not that the run is remote

#### Scenario: Idle exit locally
- **WHEN** revival is asked for a Postgres run whose local daemon exited idle
- **THEN** the daemon is started again

### Requirement: Cut submitted events on request
`GET /v1/events` SHALL take `cutSubmitted`. With `true` it SHALL serve each `transition` event whose payload has `to: "submitted"` and a `diffStat` or a `closure` with the review index's cuts from the daemon's configuration and an `omitted` list, on a copy. No other event SHALL change, whatever its size, nor the cursor. Absent or `false` SHALL serve every event whole. Any other value SHALL be answered 400 naming `cutSubmitted`.

#### Scenario: Parameter set
- **WHEN** a gated milestone E was submitted under `review: { summaryChars: 5, statLines: 0 }` with a stat of more than one line and `GET /v1/events?kinds=transition&cutSubmitted=true` is called
- **THEN** E's submitted event keeps `from`, `to`, `actor`, `trigger` and `integrationSha`; its `diffStat` holds git's totals line and no file line of the stored stat; each closure entry keeps `taskId` and `publishedSha`, has a `summary` of at most 5 characters and a `summaryLength` equal to the stored summary's length; and `omitted` lists `{ field, count, fetch }` for `closure.summary` (summaries cut) and `diffStat` (file lines left out), each only when its count is above 0, with a `fetch` naming the `review` tool and E

#### Scenario: Nothing to cut
- **WHEN** no summary is longer than `review.summaryChars` and the stat has no more file lines than `review.statLines`
- **THEN** the submitted event's `omitted` is `[]`

#### Scenario: Other events and the store stay whole
- **WHEN** the same request is served
- **THEN** every other event, including a task's transition and events of other kinds, equals its stored form, the cursor is the one served without the parameter, and the stored event still holds the whole stat and summaries

#### Scenario: Parameter absent
- **WHEN** the same request is made without `cutSubmitted`, or with `cutSubmitted=false`
- **THEN** E's submitted event is served with a payload equal to the stored one

#### Scenario: Parameter refused
- **WHEN** the request is made with `cutSubmitted=yes`
- **THEN** it is answered 400 with `{ ok: false, reason, parameter: "cutSubmitted" }`

### Requirement: Requests from another origin are refused
The API server SHALL answer 403 to any request that carries an `Origin` header, whatever its value (`null` and an empty value included), on every bind, for every method and every path.

#### Scenario: Origin header on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a `POST` with `Origin: https://example.com` and `Host: 127.0.0.1:<port>`
- **THEN** it answers 403 with `code: 'originHeader'` and the route handler does not run

#### Scenario: Origin header on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and an `Origin` header
- **THEN** it answers 403 with `code: 'originHeader'`

#### Scenario: Foreign Host on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: evil.example:<port>`, `Host: localhost:<other port>`, or no `Host`
- **THEN** it answers 403 with `code: 'hostHeader'` and the route handler does not run

#### Scenario: localhost with the listening port
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: localhost:<port>` or `Host: LOCALHOST:<port>` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: The apiBaseUrl host
- **WHEN** a daemon bound to `127.0.0.1` with `apiBaseUrl: https://orch.test` receives a request with `Host: orch.test` or `Host: orch.test:443`
- **THEN** the request reaches its route, and `Host: 127.0.0.1:<port>` still does, while `Host: orch.test:80` is answered 403 with `code: 'hostHeader'`

#### Scenario: No Host check on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: A kubelet probe is answered as before
- **WHEN** a daemon bound to `0.0.0.0` receives `GET /healthz` with `Host: <pod IP>:8080` and no `Origin`
- **THEN** it answers the probe as before

#### Scenario: A refused request does not count as activity
- **WHEN** a page polls a route with an `Origin` header
- **THEN** each request is answered 403 before it is counted as activity, so it does not keep the daemon from its idle exit

### Requirement: Review answer names the previous version

At review version n above 1, the index and the full answer of `GET /v1/milestones/<id>/review` SHALL carry a block `previous`, after `omitted` and before `diffStat`, naming version n-1, the sha it was pinned at (kv `tagged:<id>:<n-1>`, never the tag), the closure tasks added or republished since, and the diff stat between the two shas. The one-task answer SHALL NOT carry it. Nothing new SHALL be stored, and every other field SHALL stay as it is.

#### Scenario: Version 1 has no previous block

- **WHEN** a milestone submitted at review version 1 is reviewed with the index or the full answer
- **THEN** the answer has no `previous` key
- **AND** the one-task answer has no `previous` key at any version

#### Scenario: A later version lists the tasks added and republished

- **WHEN** a milestone is submitted at version n above 1, and kv `tagged:<id>:<n-1>` holds sha S
- **THEN** `previous` has `version` n-1, `sha` S and `tag` `milestone/<id>/v<n-1>`
- **AND** the closure of version n-1 is read from the milestone's second-to-last `transition` event with `to: "submitted"`, only when that event's `integrationSha` equals S
- **AND** `previous.tasksSince` lists `{ taskId, change }` for each current closure task that was not in that closure (`added`) or whose `publishedSha` differs from the one recorded there (`republished`), and no other task
- **AND** when that closure cannot be read, `tasksSince` is left out and `previous.tasksSinceUnavailable` is `true`
- **AND** `previous.diffStat` is the stat from S to `integrationSha`; the index cuts it by the stat limit of `diffStat` and adds `{ field: "previous.diffStat", count, fetch }` to `omitted`, with `git diff --stat S..<integrationSha>` as `fetch`; the full answer keeps it whole
- **AND** the block carries no outcome, rejection note or last accepted version

#### Scenario: The same commit at two versions

- **WHEN** a milestone is reset from `submitted` and resubmitted at the next version with no new commit, so that both versions have the same sha
- **THEN** `previous.sameCommit` is `true` and `previous.diffStat` is empty
- **AND** `previous.tasksSince` is `[]` when the closure did not change
- **AND** no git call is made for the previous sha

#### Scenario: No sha on record for the previous version

- **WHEN** kv `tagged:<id>:<n-1>` is absent
- **THEN** `previous` is `{ version, unavailable }`, where `unavailable` is a sentence saying no sha is on record, with no other key

#### Scenario: An empty stat between two shas

- **WHEN** `previous.sha` differs from `integrationSha` and git prints nothing for the stat between them, or the git call fails
- **THEN** `previous.diffStat` is empty
- **AND** `previous.diffStatNote` names `previous.sha` and says that either no file differs or that commit is not in the daemon's clone

### Requirement: Configuration route: limit keys
`PUT /v1/config` SHALL take `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }`, each leaf a value or null and each block a value or null, applying toolchain-discovery "Runtime limit overrides". A refusal SHALL be a 400 whose `key` is the dotted key (`budgets.maxLaunchMs`, `health.stuckAfterMs`, `health.stuckFailAfterMs`, or the unknown leaf). `applied` SHALL name the block, `budgets` or `health`.

#### Scenario: The spawn path takes the limit blocks
- **WHEN** `start` on a stopped run passes `budgets: { maxLaunchMs: 10800000 }` and `health: { stuckAfterMs: 0 }`
- **THEN** the spawned daemon's `GET /v1/config` gives both leaves with source `argument`

#### Scenario: A refusal at spawn is readable
- **WHEN** `start` on a stopped run with the default limits passes `health: { stuckFailAfterMs: 600000 }`
- **THEN** the call fails, and its error text ends with the refusal line, which holds 600000 and 900000

### Requirement: Configuration command: set flags
`orchestrator-ctl config` SHALL take `--set key=value` (repeatable) for every key `start --set` takes, including `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`, parse it as `start` does, and merge it per leaf into the one `PUT /v1/config` built from the other flags. Different leaves of one block SHALL merge.

#### Scenario: A limit set and cleared from the CLI
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=10800000` runs, then `orchestrator-ctl config --clear budgets.maxLaunchMs`
- **THEN** the override document is `{ budgets: { maxLaunchMs: 10800000 } }` after the first and empty after the second

#### Scenario: A leaf named twice
- **WHEN** `config --set capacity=3 --capacity 4`, or `config --clear budgets.maxLaunchMs --set budgets.maxLaunchMs=1`, runs
- **THEN** it fails before any request and the override document is unchanged

#### Scenario: Leaves of one block merge
- **WHEN** `config --set codex.model=gpt-6-pro --sandbox read-only` runs
- **THEN** the override document holds both leaves under `codex`

### Requirement: Status report: limits in force
`status.budgets` SHALL keep its shape (`maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, `stuckFailAfterMs`) and SHALL give the values of `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` in force, overrides applied. `maxRunCostUsd` SHALL stay the start-time value.

#### Scenario: Status after an override of 0
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied
- **THEN** `status.budgets.stuckFailAfterMs` is 0 at once

#### Scenario: Status after a clear
- **WHEN** the override is cleared with a null leaf
- **THEN** `status.budgets.stuckFailAfterMs` is the file value, else the default

### Requirement: Profile hold key

The configuration SHALL have a key `runner.confirmProfile`, a boolean that is `false` by default, so that the daemon by itself never holds a profile. The profile hold in force SHALL be the stored choice when kv `runner.confirmProfile` is `on` (on) or `off` (off), and else the configuration's `runner.confirmProfile`. Any other stored value SHALL be ignored. The stored choice SHALL be read every time the hold is evaluated. See model-selection "Profile hold at admission".

#### Scenario: Off by default

- **WHEN** a run's configuration does not set `runner.confirmProfile` and no choice is stored
- **THEN** `status.runner.confirmProfile` is false and a ready task with no selector is launched on the first tick

#### Scenario: The stored choice is read first

- **WHEN** the configuration sets `runner.confirmProfile: false` and kv `runner.confirmProfile` is `on`
- **THEN** a task with no selector on built-in defaults is held and `status.runner.confirmProfile` is true
- **AND** with the configuration `true` and the kv `off`, the task is launched and the field is false

### Requirement: Status report: profiles
`status` SHALL carry `profiles`, listing every `unstarted` task node grouped into one entry per distinct `{ runner, model, effort, modelSource, effortSource }` (model-selection "Profile sources of a task"). Each entry SHALL carry `held` (a boolean), `missing` (a list holding `model`, `effort`, both or neither, in that order), `tasks` (the count) and `sample` (at most 5 task ids, in graph order).

#### Scenario: Profiles are grouped and ordered

- **WHEN** the first task of a graph has `model: claude-sonnet-5-5` and the next six have no selector, all `unstarted`
- **THEN** `profiles` has two entries: the first with `tasks: 1`, `modelSource: "task"` and `effortSource: "default"`; the second with `tasks: 6` and a `sample` of the first 5 of those ids in graph order

#### Scenario: A task that waits on a dependency is listed

- **WHEN** the profile hold is on and a task with no selector depends on a task that runs
- **THEN** `profiles` has an entry with `held: true` whose `sample` holds the waiting task

#### Scenario: Without a graph

- **WHEN** a daemon whose configuration sets `runner.confirmProfile: true` has no graph loaded
- **THEN** `GET /v1/status` answers with `runner.confirmProfile` true and `profiles` `[]`

### Requirement: Configuration route: a change that would end a live launch
`PUT /v1/config` SHALL refuse with 409 a patch that would end a live launch, unless the body holds `endLive: true` (or `"true"`). A patch would end a launch when, for a `live` launch that holds the lease of a `running` task, the limits in force after the patch end it now and the limits in force before the patch do not.

#### Scenario: A lowered time budget is refused
- **WHEN** a launch of a running task is at 9000 ms elapsed under a budget of 10000 and `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the answer is 409 with `wouldEnd: [{ taskId, launchId, limit: "budgets.maxLaunchMs", value: 5000, elapsedMs: 9000 }]` and an `error` naming the task and `endLive`, the stored document is unchanged, and the task is still `running` after a tick

#### Scenario: A lowered stuck fail limit is refused, a lowered flag limit is not
- **WHEN** a launch is idle for 2000 ms under limits 1000 and 3000 and the patch is `{ health: { stuckFailAfterMs: 1500 } }`
- **THEN** the answer is 409 with an entry `limit: "health.stuckFailAfterMs"`, `value: 1500` and `idleMs: 2000`; and the patch `{ health: { stuckAfterMs: 500 } }` for the same launch is applied

#### Scenario: The confirmed change
- **WHEN** the refused patch is sent again with `endLive: true`
- **THEN** it is answered 200 with `applied` holding `budgets`, the `operator.config` event holds `endLive: true`, the stored document holds no `endLive` key, and the next tick ends the launch with reason `timeBudget`

#### Scenario: Clearing a raise
- **WHEN** a boot budget of 10000 was raised to 0, a launch runs past 15000 ms, and the patch is `{ budgets: { maxLaunchMs: null } }` or `{ budgets: null }`
- **THEN** the answer is 409 naming that launch and the value in force stays 0; once the launch has submitted, the same clear is applied and the leaf is `{ value: 10000, source: "file" }`

#### Scenario: A limit switched on
- **WHEN** under a boot budget of 0 a launch is at 15000 ms elapsed and the patch is `{ budgets: { maxLaunchMs: 10000 } }`
- **THEN** the answer is 409 naming the launch

#### Scenario: The boundary follows the checks
- **WHEN** a launch's elapsed time equals the new `budgets.maxLaunchMs`, and its idle time equals the new `health.stuckFailAfterMs`
- **THEN** the first is listed in `wouldEnd` and the second is not

#### Scenario: Never refused
- **WHEN** the patch is `{ capacity: 3 }`, a raise, or leaves both ending limits in force unchanged, or the only launch past the new limits belongs to a `waiting` task
- **THEN** it is not refused for live launches

#### Scenario: Nothing applied on a refusal
- **WHEN** `{ capacity: 3, budgets: { maxLaunchMs: 5000 } }` is refused for a live launch
- **THEN** `capacity` keeps its value

#### Scenario: endLive alone
- **WHEN** the body is `{ endLive: true }`
- **THEN** the answer is 200 with `applied: []` and the stored document is unchanged and holds no `endLive` key

#### Scenario: The command line
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=1` is run while a launch is live
- **THEN** the 409 with `wouldEnd` is relayed; with `--end-live` the change is applied

### Requirement: Profile hold default for a spawned daemon
The daemon SHALL take `--default-confirm-profile on|off`. Any other value SHALL end the start with an error that holds `--default-confirm-profile must be on or off, not <value>`, whatever the file says and before the store is opened.

#### Scenario: The default is adopted once and kept

- **WHEN** `startDaemon({ defaultConfirmProfile: true })` starts a fresh run whose file states no `runner.confirmProfile`
- **THEN** the result has `confirmProfile: true`
- **AND** while that daemon runs, `startDaemon({ mode: "pull" })` returns `started: false`, `mode: "pull"` and `confirmProfile: true`
- **AND** after a stop, `startDaemon()` without the option returns `confirmProfile: true`

#### Scenario: A stored off is not turned on by the default

- **WHEN** a run was first started with `defaultConfirmProfile: false` and is started again with `true`
- **THEN** the result has `confirmProfile: false`

#### Scenario: The file overwrites the stored choice

- **WHEN** a run whose stored choice is `on` is started after `runner: { confirmProfile: false }` is added to `orchestrator.yaml`
- **THEN** the result has `confirmProfile: false`, with or without `defaultConfirmProfile: true`
- **AND** after the line is removed again, a start with `defaultConfirmProfile: true` still returns `confirmProfile: false`

#### Scenario: A bad flag value

- **WHEN** the daemon is started with `--default-confirm-profile maybe`
- **THEN** the start fails with `--default-confirm-profile must be on or off, not maybe` before the store is opened

### Requirement: Status report: launches being prepared
The status report SHALL always carry `preparing`, the task ids of launches being prepared (row `preparing` or `launching`), oldest first; `prepareRetry`, `[{ taskId, failures, retryAt }]` for every retry entry whose task is `unstarted`, by `retryAt`, then task id; and `preparingByKind`, per runner kind the launches being prepared plus the tasks in `prepareRetry`, every kind present. The wait digest SHALL carry `preparing`, the sum of `preparingByKind`, and `preparingByKind`.

#### Scenario: Command running
- **WHEN** a `pull` run's only task, of kind `codex`, has a launch whose prepare command is running
- **THEN** `status.preparing` lists the task, `preparingByKind.codex` is 1, `claimable` is empty, and the digest has `preparing: 1`; after the command succeeds `preparing` is empty and `claimableByKind.codex` is 1

#### Scenario: Retry entry counted until the task is launched
- **WHEN** a task's prepare command failed once and the clock has passed its `retryAt` but no tick has run
- **THEN** `prepareRetry` still lists it with its `failures` and `retryAt` and `preparingByKind` counts it; after the next tick launches it, it is in `preparing` only and counted once

#### Scenario: A task counted once
- **WHEN** a task with a retry entry runs on a launch being prepared
- **THEN** it is in `preparing` and not in `prepareRetry`, and `preparingByKind` counts it once

#### Scenario: Entry no longer counted
- **WHEN** a task with a retry entry is cancelled, blocked with `prepareFailed`, done, or no longer a task of the loaded graph
- **THEN** it is in neither list and is not counted

#### Scenario: Prepare command unset
- **WHEN** `prepareCommand` is unset
- **THEN** `prepareRetry` is empty, the retry entries are not read, and `preparing` holds only `launching` rows of an ordinary spawn

#### Scenario: Derived from the store
- **WHEN** a daemon restarts on a store with a launch left `preparing` and a retry entry of an `unstarted` task
- **THEN** before its first tick its status lists the launch's task in `preparing` and the entry in `prepareRetry` with the same `failures` and `retryAt`

#### Scenario: Launching row in mixed mode
- **WHEN** in `mixed` mode the daemon takes back a parked launch after the claim window and its prepare command runs again with the row `launching`
- **THEN** the task is in `preparing` and counted under its kind, so a work loop of that kind can stay up for the length of that install though nothing becomes claimable from it

#### Scenario: Bodies without a graph
- **WHEN** no graph is loaded
- **THEN** the status body carries `preparing: []`, `prepareRetry: []` and `preparingByKind` all zero, and the digest carries `preparing: 0` and `preparingByKind` all zero

### Requirement: Exit record: written after the store closes
The record SHALL be written after the store's close returns. When the close reports lost batches, the record SHALL carry their count as `unflushedBatches`. When the sink rejected a batch, the record SHALL carry its cause as `rejected`.

#### Scenario: A batch rejected at shutdown
- **WHEN** the store's close at shutdown returns one lost batch and the batch the sink rejected
- **THEN** the exit record carries `unflushedBatches: 1` and `rejected` with the sink's error, and the record's description contains `a batch rejected: batch rejected by the sink`

### Requirement: Exit record: shutdown grace elapsed
When the shutdown grace period elapses before the close returns, the record SHALL carry `storeClosed: false` and `unflushedBatches` set to the pending count read before the record is written, even when that count is 0.

#### Scenario: Grace elapsed with nothing pending
- **WHEN** the shutdown grace period elapses before the store's close returns and no batch is pending
- **THEN** the exit record carries `storeClosed: false` and `unflushedBatches: 0`, and it is not clean

### Requirement: Exit record: journal fatal during a shutdown
When the journal turns fatal after a shutdown began and before the close returns, the record SHALL carry `storeClosed: false` and the fatal condition's `unflushedBatches` before the daemon exits 1. A fatal condition with no shutdown under way leaves no record and reads as a crash.

#### Scenario: Fatal journal after SIGTERM
- **WHEN** the daemon has begun a shutdown on SIGTERM and the journal turns fatal with 2 unflushed batches before the store's close returns
- **THEN** `daemon.json` carries `exit` with `storeClosed: false` and `unflushedBatches: 2`, and the daemon exits 1

#### Scenario: Fatal journal with no shutdown
- **WHEN** the journal turns fatal while no shutdown is under way
- **THEN** the daemon exits 1 without writing `exit`, and the run reads as a crash

### Requirement: Exit record: clean record
A record without `unflushedBatches`, `storeClosed`, and `rejected` is clean. A clean record SHALL be written only after the store closed with nothing unflushed.

#### Scenario: Clean stop
- **WHEN** the daemon is stopped through the `shutdown` route and the store closes with nothing unflushed
- **THEN** the exit record has no `unflushedBatches`, `storeClosed`, or `rejected`, and it is clean

### Requirement: Exit record: start and crash
A daemon that starts SHALL write `daemon.json` without `exit`. A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash. `runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists.

#### Scenario: Idle exit listed, then cleared by a revival
- **WHEN** the daemon exits idle, `runs` is called, and the run is then revived
- **THEN** `runs` lists the run as not alive with `exit.reason` `idle`, and the revived daemon's `daemon.json` has no `exit`

### Requirement: Exit record: revival refusal
The revival refusal after a `stop` SHALL name the caller when one was recorded, and SHALL name the lost batches when the record is not clean.

#### Scenario: Refusal names the caller
- **WHEN** the daemon was stopped through the `shutdown` route with `x-orch-attachment: a1`, and a revival is asked for
- **THEN** the revival is refused with a message containing `stop by attachment a1`

### Requirement: Container mode: shutdown deadline
When stopping on SIGTERM or SIGINT takes longer than 8 seconds the daemon SHALL write the exit record and exit 0 anyway; a check abandoned that way restarts from `queued` on the next start, as after a crash.

#### Scenario: Stop that overruns the deadline
- **WHEN** the daemon receives SIGTERM and its stop has not returned 8 seconds later
- **THEN** the daemon writes the exit record with reason `signal` and exits

### Requirement: Container mode: daemon files
The daemon SHALL write `daemon.pid` and `daemon.json` in its data directory itself, whether or not a client spawned it; in a container nothing reads them. The bind address, advertised URL, probes, image, and manifests a container needs are specified in specs/cluster-runtime.

#### Scenario: Files written without a spawning client
- **WHEN** the daemon is started in the foreground with no client spawning it
- **THEN** its data directory holds `daemon.pid` with the process's own pid, and `daemon.json`

### Requirement: Container mode: JSON log format
When `ORCH_LOG_FORMAT` is `json`, every line the daemon logs on stderr SHALL be one JSON object with `ts`, `level`, and `msg` first, followed by the data fields; a data field named `ts`, `level`, or `msg` is dropped. Any other value SHALL keep the text format.

#### Scenario: Data fields cannot replace the record keys
- **WHEN** the daemon logs `real` at level `warn` with data `{ msg: "fake", level: "x", other: 1 }` under `ORCH_LOG_FORMAT=json`
- **THEN** the line parses as `{ ts, level: "warn", msg: "real", other: 1 }`

#### Scenario: Text format for another value
- **WHEN** `ORCH_LOG_FORMAT` is `text` or unset
- **THEN** each stderr line is the text format: the timestamp, the level in capitals, the message, and the data as JSON

### Requirement: Container mode: remote daemon URL
When `ORCH_URL` names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`, the client-side `start` and revival SHALL NOT spawn a local daemon: revival returns nothing to revive when the URL answers a probe and otherwise fails naming the URL as unreachable, and `start` refuses.

#### Scenario: Start refused for an unreachable remote URL
- **WHEN** `ORCH_URL` is `http://orchestrator.orch.invalid:8080` and nothing answers there, and `start` is called
- **THEN** `start` fails naming the URL as unreachable, and no `daemon.pid` or `daemon.json` is written in the run directory

### Requirement: Container mode: operator server on a remote daemon URL
The operator MCP server SHALL use an `ORCH_URL` that names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1` directly, without registering an attachment, since the pids it would register are not the daemon's.

#### Scenario: Remote daemon used as is
- **WHEN** `ORCH_URL` names `http://orchestrator.orch.svc:8080`, which answers a probe, and an operator tool is called
- **THEN** the call is sent to that URL without first registering an attachment there, and no local daemon is spawned

### Requirement: Session attachments: end by id
The daemon SHALL expose `POST /v1/attachments/:id/end` with `{ reason }`, recording the end. The end routes SHALL respond once the end is recorded, before any release.

#### Scenario: End an idle attachment by id
- **WHEN** an attachment `idle` that holds no launch is ended with `POST /v1/attachments/idle/end` and `{ reason: "bye" }`
- **THEN** the response is `{ ended: true }`, and after the next reconcile `status.attachments` is empty

### Requirement: Session attachments: end by ancestry
The daemon SHALL expose `POST /v1/attachments/ended` with `{ pids, reason }`, where `pids` is the posting hook's own pid followed by its ancestors, recording the end of every live attachment for which the nearest pid in `pids` that is also in the attachment's chain is the hook's parent or grandparent (`pids[1]` or `pids[2]`). pid 1 SHALL never match.

#### Scenario: End by the hook's parent
- **WHEN** an attachment's chain ends with pid 424242 and a hook posts `{ pids: [777777, 424242], reason: "clear" }`
- **THEN** the response lists the attachment under `ended`, and a post of `{ pids: [555555] }` before it ended nothing

#### Scenario: pid 1 shared
- **WHEN** a hook posts `[H, 1]`, where pid 1 is the only pid after the hook's own
- **THEN** no attachment is ended

### Requirement: Session attachments: a nested session stays attached
An attachment whose nearest shared pid is further up the posted chain, as for a session nested under a shell or another process inside the attachment's session, SHALL stay live.

#### Scenario: Shared pid in the fourth position
- **WHEN** an attachment's chain is `[S, L, C, T]` and a hook posts `[H, X, Y, T]`, whose only pid shared with the chain is T
- **THEN** the attachment stays live

### Requirement: Session attachments: attachment header
An operator request MAY carry the header `x-orch-attachment` naming the caller's attachment; when that id is not a live attachment the daemon SHALL still perform the operation and SHALL add the response header `x-orch-attachment: unknown`.

#### Scenario: Live attachment header
- **WHEN** `status` is called with `x-orch-attachment` naming a live attachment
- **THEN** the response is 200 and carries no `x-orch-attachment` header

### Requirement: Session attachments: reconcile releases
A claim MAY carry `attachment`, stored on the launch's worker record. At every reconcile the daemon SHALL end any attachment whose first pid is dead, SHALL release with `keep` and reason `sessionEnded` every live claimed launch whose worker carries an ended attachment, SHALL append `attachment.ended`, and SHALL remove the record.

#### Scenario: Claim through a dead attachment
- **WHEN** a worker claims T1 with `attachment: "dead"`, an attachment whose first pid is not alive, and a tick runs
- **THEN** the launch's worker record carries `attachment: "dead"`, the launch is ended as released, T1 has `attempts: 0` and a fresh claimable launch, and one `attachment.ended` event is appended

### Requirement: Session attachments: status
`status` SHALL report `attachments` as `[{ id, pids, since, launches }]` for live attachments.

#### Scenario: Launches listed by attachment
- **WHEN** a worker claims T1 through attachment `dead` before any reconcile
- **THEN** `status.attachments` is `[{ id: "dead", launches: [<T1's launch id>], ... }]`

### Requirement: Configuration route: PUT keys
The daemon SHALL expose `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification.

#### Scenario: Keys cleared with null
- **WHEN** `PUT /v1/config` clears `allowedTools` and `capacity` with null, where the file sets `capacity: 4`
- **THEN** `applied` lists `allowedTools` and `capacity`, `capacity` is `{ value: 4, source: "file" }`, and the argument part of `allowedTools` is empty

### Requirement: Configuration route: PUT validation and recording
`PUT /v1/config` SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`.

#### Scenario: Invalid value refused whole
- **WHEN** `PUT /v1/config` carries `{ effort: "huge" }` while the effort in force is `high`
- **THEN** the response is 400 with `key` `effort`, and the effort in force is still `high`

### Requirement: Configuration route: command key flags
`orchestrator-ctl config` SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf).

#### Scenario: Several key flags in one call
- **WHEN** `orchestrator-ctl config --allow "Bash(make:*)" --allow "Bash(docker:*)" --capacity 3 --check-command "make check"` is run
- **THEN** the response has `capacity` `{ value: 3, source: "argument" }`, `checkCommand` `{ value: "make check", source: "argument" }`, and both rules in the argument part of `allowedTools`

### Requirement: Configuration route: command data-dir value
For `--data-dir`, on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location when no daemon URL is given. For `--data-dir`, when `--url` or `ORCH_URL` addresses the daemon, any other value SHALL be refused before anything is sent, with a message naming both meanings and the two accepted values.

#### Scenario: Leaf value with ORCH_URL set
- **WHEN** `ORCH_URL` addresses a daemon and `orchestrator-ctl config --data-dir lanch` is run, then `orchestrator-ctl config --data-dir launch`
- **THEN** the first exits non-zero naming `shared or launch` with no request sent, and the second sends one `PUT /v1/config`

### Requirement: Configuration route: command runner kind and commit policy
`--runner-kind` SHALL take `claude-code`, `codex`, or `opencode`. `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force.

#### Scenario: Commit bound to the kind named in the call
- **WHEN** the kind in force is `codex` and `orchestrator-ctl config --runner-kind claude-code --commit daemon` is run
- **THEN** `runnerKind` is `{ value: "claude-code", source: "argument" }` and `claude.commit` is `{ value: "daemon", source: "argument" }`

### Requirement: Configuration route: a cleared key and its leaf in one call
A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes.

#### Scenario: Clear runnerKind with commit refused
- **WHEN** `orchestrator-ctl config --clear runnerKind --commit daemon` is run without `--runner-kind`
- **THEN** the CLI exits non-zero with a message saying to name the kind with `--runner-kind`, and no `PUT /v1/config` is made

### Requirement: Configuration route: fold of the OpenCode arguments
The operator-surface fold (`foldRunnerArgs`) SHALL put `permission` and `dataDir` arguments under `opencode` and SHALL refuse them beside a cleared `opencode` or a cleared leaf of the same name, with the same message.

#### Scenario: Permission and dataDir folded
- **WHEN** the fold receives `{ dataDir: "launch", permission: "allow" }` with `claude-code` in force, and separately `{ opencode: { permission: null }, permission: "allow" }`
- **THEN** the first is `{ opencode: { permission: "allow", dataDir: "launch" } }`, and the second is refused with `opencode.permission is both cleared and set`

### Requirement: Configuration route: command usage names the kinds
The CLI usage SHALL name the three kinds and their default models and efforts (`claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, all at `medium`) and SHALL say that `ultra` is codex-only.

#### Scenario: Kinds and defaults in the usage
- **WHEN** `orchestrator-ctl --help` is run
- **THEN** the usage contains `claude-opus-5-5 at medium`, `gpt-6-astra at medium`, `anthropic/claude-opus-5-5 at medium`, and `ultra is codex-only`

### Requirement: Configuration route: configure tool OpenCode arguments
The MCP `configure` tool SHALL take `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, folded the same way, and SHALL forward the route's refusal of an effort the kind lacks (`ultra` for opencode), whose message names the kind.

#### Scenario: Permission cleared through the configure tool
- **WHEN** the `configure` tool is called with `permission: null` on a run whose `opencode.permission` was set to `allow`
- **THEN** `config.opencode.permission` is `{ value: "derived", source: "default" }`

### Requirement: Status report: toolchain and needsConfig
`status` SHALL additionally report `toolchain`, the detection record. `status` SHALL additionally report `needsConfig`, the keys whose value is unresolved. The event stream digest SHALL carry `needsConfig`.

#### Scenario: needsConfig cleared everywhere
- **WHEN** `checkCommand` is unresolved, and then `PUT /v1/config` sets it
- **THEN** `status.needsConfig` and the digest's `needsConfig` are `["checkCommand"]` before the change and the digest's `needsConfig` is `[]` after it

### Requirement: Status report: selection of each live launch
Each entry of `liveLaunches` SHALL carry the launch's `runner`, `model`, and `effort`.

#### Scenario: Run default and task selector side by side
- **WHEN** T1 runs with the run defaults and T2 with a task selector `model: claude-sonnet-5-5`, `effort: high`
- **THEN** `status.liveLaunches` has T1 with `runner: "claude-code"`, `model: "claude-opus-5-5"`, `effort: "medium"`, and T2 with `model: "claude-sonnet-5-5"`, `effort: "high"`

### Requirement: Status report: configuration without a graph
The configuration facts SHALL be present when no graph is loaded.

#### Scenario: Unresolved command before an import
- **WHEN** `checkCommand` is unresolved and `GET /v1/status` is called before any graph is imported
- **THEN** the body carries `needsConfig: ["checkCommand"]`, `config`, and `toolchain` beside `error: graph not loaded`

### Requirement: Start arguments: passed at spawn or through the route
When the daemon lifecycle `start` spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason.

#### Scenario: Start-only key refused on a running daemon
- **WHEN** `start` passes `capacity: 4` and `integrationBranch: develop` to a daemon that is already healthy
- **THEN** the result has `started: false`, `applied: ["capacity"]`, and `rejected` holding `integrationBranch` with a reason naming `start-only`

### Requirement: Start arguments: command set flags
`orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`, `opencode.model`, `opencode.effort`, `opencode.commit`, `opencode.command`, `opencode.permission`, `opencode.dataDir`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving.

#### Scenario: Dotted keys folded under their kind
- **WHEN** `--set runnerKind=codex --set codex.model=gpt-6-pro --set codex.sandbox=read-only --set effort=ultra` is parsed
- **THEN** the overrides are `{ runnerKind: "codex", codex: { model: "gpt-6-pro", sandbox: "read-only", effort: "ultra" } }`

### Requirement: Start arguments: daemon usage
The daemon's usage SHALL list the keys `orchestrator-ctl start` takes as `--set` flags.

#### Scenario: Limit keys in the daemon usage
- **WHEN** the daemon's usage is read
- **THEN** it names `--set key=value`, `budgets.maxLaunchMs`, `health.stuckAfterMs`, and `health.stuckFailAfterMs`

### Requirement: Start arguments: start tool runner arguments
The MCP `start` tool SHALL take `runnerKind` (`claude-code`, `codex`, or `opencode`), `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, and its argument text SHALL name the opencode defaults (`anthropic/claude-opus-5-5` at `medium`, commit `agent`, permission `derived`, dataDir `shared`).

#### Scenario: OpenCode leaves at start
- **WHEN** the `start` tool is called with `runnerKind: "opencode"`, `permission: "allow"`, and `dataDir: "launch"`
- **THEN** the result's `config.opencode.permission` and `config.opencode.dataDir` are `allow` and `launch` with source `argument`, and `config.opencode.commit` is `{ value: "agent", source: "default" }`

### Requirement: Start arguments: mode note for codex and opencode
Without `mode`, and with no mode configured or chosen by the run, the MCP `start` tool SHALL start a run whose kind in force is `codex` or `opencode` in `spawn`, with a `modeNote` naming the kind and saying that pull-mode workers for it come from `orchestrator-work --runner <kind>`; a `codex` or `opencode` run in `pull` SHALL get a `modeNote` that names the kind and the same work loop. The work loop SHALL carry `--runner <kind>` for `codex` too, although `codex` is the loop's default runner.

#### Scenario: Codex run switched to pull
- **WHEN** a `codex` run started in `spawn` is started again with `mode: "pull"`
- **THEN** the result has `started: false`, `mode: "pull"`, and a `modeNote` reading `runner kind codex in pull mode` and naming `orchestrator-work --runner codex`

### Requirement: Requests from another origin: Host check on a loopback bind
When the bind is a loopback address (`localhost`, `::1`, or an IPv4 address in `127.0.0.0/8`), the server SHALL also answer 403 to a request whose `Host` header is missing or is not one of: the bound address with the listening port; `localhost` with the listening port; with `apiBind: localhost`, `127.0.0.1` and `[::1]` with the listening port; the host and port of `apiBaseUrl` when that key is set.

#### Scenario: Host without the listening port
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: localhost` and no port, or `Host: user@localhost:<port>`
- **THEN** it answers 403 with `code: 'hostHeader'` and the route handler does not run

### Requirement: Requests from another origin: no Host check on another bind
When the bind is not loopback (`0.0.0.0` and `::` included) there SHALL be no `Host` check.

#### Scenario: Binds that are not loopback
- **WHEN** the bind is `0.0.0.0`, `::`, `10.0.0.1`, or `foo.localhost`
- **THEN** the bind is not loopback, and a request with `Host: 10.1.2.3:8080` and no `Origin` on a `0.0.0.0` bind reaches its route

### Requirement: Requests from another origin: Host comparison
The `Host` comparison SHALL ignore case and one trailing dot on the name, SHALL compare an IPv6 address in its bracketed form, and SHALL take a missing port to be the default port of the entry's scheme (`http` for the bound address and `localhost`, the URL's own scheme for `apiBaseUrl`).

#### Scenario: Case, trailing dot, and default port
- **WHEN** a daemon bound to `127.0.0.1` receives `Host: LOCALHOST:<port>` or `Host: localhost.:<port>`, and one with `apiBaseUrl: https://orch.test` receives `Host: orch.test`
- **THEN** each request reaches its route

### Requirement: Requests from another origin: rules applied before the route
The `Origin` rule SHALL be tested before the `Host` rule, and both SHALL be applied before the route is matched, before the request counts as activity for the idle exit, and before the body is read, so a refused request runs no handler and writes nothing. The probes SHALL get no exemption.

#### Scenario: Refused before the handler and the activity count
- **WHEN** a daemon bound to `127.0.0.1` receives a `POST` with a JSON body, `Origin: https://example.com`, and a valid `Host`
- **THEN** it answers 403 with `code: 'originHeader'`, the handler does not run, and the request is not counted as activity

### Requirement: Requests from another origin: the refusal answer
The answer SHALL be JSON `{ error, code }` with `code` `originHeader` or `hostHeader`; the `error` text SHALL name the header, and for `hostHeader` the value received and that `apiBaseUrl` adds a host. No CORS header SHALL be sent and no configuration key SHALL switch the rules off.

#### Scenario: Host refusal text
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: evil.example:<port>`
- **THEN** the answer is JSON with `code: 'hostHeader'` and an `error` that holds `evil.example:<port>` and names `apiBaseUrl`

### Requirement: Configuration route: limit blocks passed by start
`start` SHALL pass the `budgets` and `health` blocks to a daemon it spawns as `--set budgets=<json>` and `--set health=<json>`, and through the route to one already running.

#### Scenario: Blocks stored as overrides
- **WHEN** `start` spawns a daemon with `budgets: { maxLaunchMs: 10800000 }` and `health: { stuckAfterMs: 0 }`
- **THEN** the start result's `applied` is `budgets` and `health`, and the daemon's override document is `{ budgets: { maxLaunchMs: 10800000 }, health: { stuckAfterMs: 0 } }`

### Requirement: Configuration route: limit refusal readable at spawn
A refusal by a daemon that `start` spawns SHALL be readable from the error `start` returns: the daemon SHALL write its usage text before the refusal line, so the tail of its log ends with the refusal.

#### Scenario: Refusal line last in the log
- **WHEN** `start` spawns a daemon for a run with the default limits with `health: { stuckFailAfterMs: 600000 }`
- **THEN** the last line of the daemon log starts `--set health.stuckFailAfterMs:` and holds 600000 and 900000

### Requirement: Configuration command: each leaf named once
A call SHALL name each leaf once: the same leaf (a key, or `block.leaf`), or a block and a leaf under it, named by two of `--set`, `--clear`, `--allow` (the key `allowedTools`) and the per-key flags SHALL be refused before anything is sent. A repeated `--set allowedTools` appends rules and names the key once.

#### Scenario: A block and a leaf under it
- **WHEN** `config --clear health --set health.stuckAfterMs=1` or `config --set capacity=3 --set capacity=4` runs
- **THEN** it fails before any request with a message that the two flags both name the leaf, and the override document is unchanged

#### Scenario: Repeated allowedTools
- **WHEN** `config --set allowedTools=Bash(make:*) --set allowedTools=Bash(docker:*)` runs
- **THEN** the override document's `allowedTools` is `["Bash(make:*)", "Bash(docker:*)"]`

### Requirement: Configuration command: a bad set refused
A `--set` with an unknown key or a bad value SHALL be refused before anything is sent, naming the key.

#### Scenario: Unknown key and bad value
- **WHEN** `config --set nope=1` or `config --set budgets.maxLaunchMs=` runs
- **THEN** it fails naming `nope` as an unknown key, or saying that `budgets.maxLaunchMs` expects milliseconds, and no `operator.config` event is appended

### Requirement: Configuration command: usage names set
The CLI usage SHALL name `--set` on `config` and the three limit keys.

#### Scenario: Limit keys in the CLI usage
- **WHEN** `orchestrator-ctl --help` is run
- **THEN** the usage contains `--set key=value`, `budgets.maxLaunchMs`, `health.stuckAfterMs`, and `health.stuckFailAfterMs`

### Requirement: Status report: profile order and launched tasks
Entries SHALL be ordered by their first task in graph order. A task that has a launch SHALL be in no entry.

#### Scenario: A launched task leaves the list
- **WHEN** the profile hold is on, T1 is held in pull mode, and `PUT /v1/config` sets `model` and `effort`, after which a tick parks a launch for T1
- **THEN** `status.claimable` is `["T1"]` and `status.profiles` is `[]`

### Requirement: Status report: profiles with the hold off
The `profiles` list SHALL be present with the profile hold on or off; with it off every entry SHALL have `held: false` and an empty `missing`.

#### Scenario: Listed with no key set
- **WHEN** no configuration sets `runner.confirmProfile` and the graph holds one task A with no selector
- **THEN** `status.profiles` is one entry with the default profile, `held: false`, `missing: []`, `tasks: 1` and `sample: ["A"]`, and the first tick launches A

### Requirement: Status report: profile hold in force
`status.runner` SHALL carry `confirmProfile`, the profile hold in force. The body of `GET /v1/status` without a graph SHALL carry `runner.confirmProfile` and `profiles: []`.

#### Scenario: Hold reported on the runner block
- **WHEN** a pull-mode run whose configuration sets `runner.confirmProfile: true` has a graph loaded
- **THEN** `GET /v1/status` has `runner` with `mode: "pull"` and `confirmProfile: true`

### Requirement: Live launch guard: the two ending limits
Two limits end a launch: `budgets.maxLaunchMs`, which ends it when its elapsed time is at or above the limit, and `health.stuckFailAfterMs`, which ends it when its idle time is above the limit; a limit of 0 ends nothing. The route SHALL take the elapsed and idle times, and SHALL compare them, through the same functions the time budget and stuck checks use, so time the daemon did not run is left out in both places.

#### Scenario: An entry for the time budget
- **WHEN** a launch is at 9000 ms elapsed under a budget of 10000 and the patch is `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the one `wouldEnd` entry carries `elapsedMs: 9000` and no `idleMs`

#### Scenario: Idle equal to the fail limit
- **WHEN** a launch has been idle 4000 ms and the patch is `{ health: { stuckFailAfterMs: 4000 } }`
- **THEN** it is applied, while `{ health: { stuckFailAfterMs: 3999 } }` is refused with `idleMs: 4000`

### Requirement: Live launch guard: the stuck flag limit is never refused
A changed `health.stuckAfterMs` only flags a launch and SHALL never be refused.

#### Scenario: Flag limit lowered below the idle time
- **WHEN** a launch is idle 2000 ms under limits 1000 and 3000 and the patch is `{ health: { stuckAfterMs: 500 } }`
- **THEN** it is applied with `applied: ["health"]`

### Requirement: Live launch guard: every shape of patch
The rule SHALL cover every shape of patch: a lower value, a null leaf that clears a raise, a null `budgets` or `health` block, and a limit that was 0 and is switched on.

#### Scenario: A null health block
- **WHEN** `health.stuckFailAfterMs` 3000 from the file was raised to 10000, a running launch is idle 5000 ms, and the patch is `{ health: null }`
- **THEN** the answer is 409 with an entry `limit: "health.stuckFailAfterMs"`, `value: 3000`, `idleMs: 5000`

### Requirement: Live launch guard: read from the store
The route SHALL read the store only: it SHALL NOT ask the runner for liveness, so it can name a launch the next tick would not end. A `waiting` task's launch SHALL NOT be named.

#### Scenario: A waiting launch left out
- **WHEN** one task is `waiting` on a question and other tasks are running, all idle 2000 ms, and the patch is `{ health: { stuckFailAfterMs: 1500 } }`
- **THEN** the refusal lists the running tasks' launches and not the waiting task's launch

### Requirement: Live launch guard: only launches ended now
The route SHALL name only launches the new limits end now; a value below the age a young launch will reach SHALL be accepted.

#### Scenario: A young launch below the new budget
- **WHEN** a launch is at 4000 ms elapsed under a budget of 100000 and the patch is `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the patch is applied: no launch is past 5000 ms now

### Requirement: Live launch guard: the refusal body
The refusal body SHALL be `{ ok: false, error, wouldEnd }`, where each `wouldEnd` entry is `{ taskId, launchId, limit, value, elapsedMs }` for `budgets.maxLaunchMs` or `{ taskId, launchId, limit, value, idleMs }` for `health.stuckFailAfterMs`, `value` being the limit the patch would put in force, with one entry per launch and limit. `error` SHALL be one sentence that names each task and the `endLive` option.

#### Scenario: Refusal through the route
- **WHEN** T1's launch is live and `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 1 } }`
- **THEN** the answer is 409 with `ok: false` and `wouldEnd: [{ taskId: "T1", launchId, limit: "budgets.maxLaunchMs", value: 1 }]`, no `startOnly`, and an `error` holding `T1` and `endLive`

### Requirement: Live launch guard: nothing applied on a refusal
Nothing of a refused patch SHALL be applied, other keys included, and no `operator.config` event SHALL be appended.

#### Scenario: Store and events unchanged
- **WHEN** a lowered budget is refused for a live launch
- **THEN** the stored override document is as before, no `operator.config` event is appended, and after a tick the task is still `running` with its launch `live`

### Requirement: Live launch guard: invalid and start-only patches answered first
A patch that is invalid (the stuck pair rule included) SHALL be answered 400 first, and a start-only key SHALL be answered with its 409 and `startOnly` body before the check for a change that would end a live launch.

#### Scenario: Start-only key before the guard
- **WHEN** a launch is past a lowered budget and the patch is `{ integrationBranch: "x", budgets: { maxLaunchMs: 5000 } }`
- **THEN** the answer is 409 with `startOnly: ["integrationBranch"]` and no `wouldEnd`

### Requirement: Live launch guard: endLive is not a configuration key
`endLive` SHALL NOT be a configuration key: it SHALL NOT be stored, validated as part of the patch, or listed under `applied`.

#### Scenario: endLive with a limit
- **WHEN** `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 1 }, endLive: true }`
- **THEN** the answer has `applied: ["budgets"]`, and the stored override document is `{ budgets: { maxLaunchMs: 1 } }` with no `endLive` key

### Requirement: Live launch guard: a change confirmed with endLive
With `endLive: true` the patch SHALL be applied as without the guard, the `operator.config` event SHALL record `endLive: true`, and the next tick ends the named launches.

#### Scenario: Launch ended by the next tick
- **WHEN** a launch at 9000 ms elapsed and a budget lowered to 5000 with `endLive: true`
- **THEN** the one `operator.config` event holds `endLive: true`, and the next tick ends the launch with reason `timeBudget`

### Requirement: Live launch guard: endLive alone
A body of `endLive` alone SHALL be answered 200 with `applied: []` and SHALL store nothing.

#### Scenario: Nothing recorded
- **WHEN** the body is `{ endLive: true }` while a launch is live
- **THEN** the answer is 200 with `applied: []`, no override document is stored, and no `operator.config` event is appended

### Requirement: Live launch guard: command option --end-live
`orchestrator-ctl config --end-live` SHALL add `endLive: true` to the PUT, and with no key SHALL send the PUT, not the GET; its usage SHALL name `--end-live`.

#### Scenario: --end-live with no key
- **WHEN** `orchestrator-ctl config --end-live` is run with no key
- **THEN** a `PUT /v1/config` is sent and answered 200 with `applied: []`, the stored document is unchanged, and the usage names `--end-live`

### Requirement: Live launch guard: the route only
The guard SHALL cover the route only: a daemon spawned with `--set`, and a changed file, apply their limits on the first tick. The `start` tool SHALL NOT take `endLive`; on a running daemon a refused limit lands under `rejected` with the route's `error` text.

#### Scenario: Limit refused through start
- **WHEN** `start` passes `budgets: { maxLaunchMs: 1 }` to a running daemon whose live launch is past it
- **THEN** the result lists `budgets` under `rejected` with the route's `error` text, which names the task and `endLive`, and the limit in force is unchanged

### Requirement: Profile hold default: stored choice written at start
After the store is open, at every start: when `orchestrator.yaml` states `runner.confirmProfile` as a boolean, the daemon SHALL write the stored choice (kv `runner.confirmProfile`) as `on` or `off` to match the file; else, when the flag is given and the store holds no choice, it SHALL write the flag's value; else it SHALL write nothing. So the file's value SHALL overwrite the stored choice at every start, and a file line that is later removed SHALL leave the last stored choice in force.

#### Scenario: The file turns the hold on
- **WHEN** a fresh run whose `orchestrator.yaml` has `runner: { confirmProfile: true }` is started without `defaultConfirmProfile`
- **THEN** the result has `confirmProfile: true`

### Requirement: Profile hold default: the stored choice belongs to the run
The stored choice SHALL belong to the run: a start without the flag (by `orchestrator-ctl`, by hand or by a revival) SHALL keep it. `orchestrator-ctl`, a daemon started by hand and a cluster daemon SHALL never pass the flag `--default-confirm-profile` by themselves.

#### Scenario: A start without the flag keeps the choice
- **WHEN** a run adopted the hold through `defaultConfirmProfile: true`, was stopped, and is started again without the option
- **THEN** the result has `started: true` and `confirmProfile: true`

### Requirement: Profile hold default: startDaemon option
`startDaemon` SHALL take `defaultConfirmProfile?: boolean` and pass the flag only to a daemon it spawns, independent of `--mode` and `--default-mode`. A running daemon SHALL keep the choice it has.

#### Scenario: No option, no hold
- **WHEN** a fresh run whose file states no `runner.confirmProfile` is started with `startDaemon` and no `defaultConfirmProfile`
- **THEN** the result has `confirmProfile: false`

### Requirement: Profile hold default: confirmProfile in the start result
The start result SHALL carry `confirmProfile`, the hold in force read from the status probe's `runner.confirmProfile`, in every path, also when the daemon is already running and a `mode` is passed (where the result's `mode` stays the passed `mode`). The field SHALL be absent only when the probe fails.

#### Scenario: Running daemon without a mode
- **WHEN** `startDaemon()` is called with no option while the run's daemon runs in `pull` mode with the hold on
- **THEN** the result is `started: false` with `mode: "pull"` and `confirmProfile: true`

### Requirement: Profile hold default: a run from before the hold
A run that existed before "Profile hold default for a spawned daemon" has no stored choice. A run that existed before "Profile hold default for a spawned daemon" SHALL adopt the hold the next time a daemon is spawned for it with the flag `on`, by a start or by a revival, and its `unstarted` tasks are then held.

#### Scenario: Revival adopts the hold
- **WHEN** a run started without the option, with `confirmProfile: false` and tasks T1 and T2 (T2 depending on T1), exits idle and an operator tool revives it
- **THEN** `status` has `runner.confirmProfile: true` and the profile entry holding T2 has `held: true`

### Requirement: Operator interface: operations
The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode and configuration arguments, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, `mode`, and `config` to show and set the configuration.

#### Scenario: The operator MCP server lists the operations
- **WHEN** the operator MCP server is listed over stdio
- **THEN** its tools include `status`, `answer`, `cancel`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, `logs`, `review`, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release` and `configure`

#### Scenario: The CLI reaches the operation routes
- **WHEN** `orchestrator-ctl` runs `pause`, `resume --override-budget`, `nudge`, `answer`, `reject --note`, `unblock`, `cancel --release` and `logs` against the daemon URL
- **THEN** each command is answered by its route and the event log holds `operator.pause`, `operator.resume`, `operator.nudge`, `operator.answer`, `operator.reject`, `operator.unblock` and `operator.cancel`
- **AND** an unknown command is refused with "unknown command"

### Requirement: Status report: claimable launches per kind
`status` SHALL report `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list. The event digest SHALL carry `claimableByKind` beside its `claimable` count.

#### Scenario: Claimable launches counted per kind
- **WHEN** one `claude-code` launch and one `codex` launch are parked as claimable
- **THEN** `status` reports `claimable: [T1, T2]` and `claimableByKind` with `claude-code` 1 and `codex` 1, and the event digest reports `claimable` 2 with the same `claimableByKind`

#### Scenario: Every kind present
- **WHEN** the `claude-code` launch has been claimed and only the `codex` launch is parked
- **THEN** `claimableByKind` is `{ claude-code: 0, codex: 1, opencode: 0 }`

### Requirement: Status report: awaiting review and verifying
`awaitingReview` SHALL list every submitted node; `verifying` SHALL list the tasks among them, which await the verifier and not a human, as the event digest's `verifying` does.

#### Scenario: A submitted task awaits the verifier
- **WHEN** task T1 has submitted and its job has not been published
- **THEN** `awaitingReview` lists T1 and `verifying` lists T1

#### Scenario: A submitted milestone awaits a human
- **WHEN** every task of gated milestone MVP is published and MVP is `submitted`
- **THEN** `awaitingReview` lists MVP and `verifying` is empty

### Requirement: Shutdown: caller recorded
The `shutdown` route SHALL record its caller before stopping: the `x-orch-attachment` header when present, the remote address, and the user agent, as `by` in an `operator.shutdown` event carrying `reap`, and the same `by` SHALL reach the exit record.

#### Scenario: Shutdown route names its caller
- **WHEN** `POST /v1/shutdown` arrives with `reap: false`, header `x-orch-attachment: a1` and user agent `lifecycle-test`
- **THEN** the answer carries `by` with attachment `a1` and that user agent, the event log holds one `operator.shutdown` event with `reap: false` and that `by`, and the exit record in `daemon.json` has reason `stop` and the same `by` with the loopback remote address

### Requirement: Run directory: contents
The run directory SHALL contain a `repo` file with the repository's real path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, `daemon.pid`, and `daemon.json` with the daemon's pid, URL, port, start time, repository, and, after a graceful exit, the exit record.

#### Scenario: Started daemon writes its files
- **WHEN** `start` spawns a daemon for a repository
- **THEN** the run directory holds `daemon.pid` with the daemon's pid and `daemon.json` whose `repo` is the repository's real path, and a run directory whose `repo` file names a repository is listed with that path

### Requirement: Run directory: resolution
The CLI and MCP server SHALL resolve the run directory from an explicit repository argument or from the git top level of the working directory, with the same id the daemon chooses.

#### Scenario: Subdirectory and symlink resolve to one run
- **WHEN** the repository is named once by the working directory `sub/dir` inside it and once by a symlink to it
- **THEN** both resolve to the same repository path and the same run directory under `$ORCH_HOME/runs`
- **AND** a working directory outside any git repository is refused as not inside a git repository

### Requirement: Run directory: runs listing
A `runs` operation SHALL list every run with its repository path, whether its daemon is alive, a status digest when it is, and otherwise the exit record or its absence.

#### Scenario: Live and dead runs listed
- **WHEN** repository A has a running daemon and repository B has a run directory with no daemon
- **THEN** `runs` lists both: A alive with its URL, pid and a digest, B not alive

#### Scenario: Exit record listed
- **WHEN** a daemon exited when idle
- **THEN** `runs` lists its run as not alive with the exit record whose reason is `idle`

### Requirement: Daemon lifecycle: port reuse
The daemon SHALL record its chosen port and SHALL reuse it on the next start when it is free, so that agents launched before a restart reach the daemon after it.

#### Scenario: Port kept across a graceful restart
- **WHEN** the daemon is stopped while T1's agent is still working and started again
- **THEN** the new daemon listens on the same port and URL, the agent reports to it, and the store records that port as `apiPort`

### Requirement: Daemon lifecycle: default mode
The daemon SHALL accept `--default-mode <spawn|pull|mixed>`, which SHALL become the run's durable mode override only when the store holds none and the repository's `orchestrator.yaml` does not set `runner.mode`; `--mode` SHALL keep setting the override unconditionally.

#### Scenario: Default mode adopted when nothing chose one
- **WHEN** a daemon is started with `--default-mode pull` for a run whose store and `orchestrator.yaml` set no mode, then stopped and started without it
- **THEN** both starts run in `pull`

#### Scenario: Default mode yields to a choice
- **WHEN** a run was started with `--mode spawn`, or its `orchestrator.yaml` sets `runner.mode: spawn`, and a daemon is started with `--default-mode pull`
- **THEN** the daemon runs in `spawn`

### Requirement: Daemon lifecycle: start after an idle exit
A daemon started after an idle exit SHALL run recovery as after any stop and SHALL find nothing to adopt.

#### Scenario: Revived run keeps its state
- **WHEN** a daemon exited idle after its only task T1 was done and the run is revived
- **THEN** the new daemon answers on the same port, `daemon.json` holds no exit record, the run is finished and T1 is still `done`

### Requirement: Review bundle: index view
`review` SHALL answer in this view: **Index** (`view: "index"`, the default): `baseline` and the milestone's `acceptanceCriteria` as in the whole bundle; `diffStat`, the first `statLines` file lines of `git diff --stat <baseline>..<integrationSha>` as git printed them, then one line ` ... <k> more files` when k file lines were left out, then git's totals line, which is always kept (an empty stat stays empty).

#### Scenario: Stat cut to its first lines
- **WHEN** the index is asked with `statLines` 40 for a stat of 45 file lines
- **THEN** `diffStat` holds the first 40 file lines as git printed them, then ` ... 5 more files`, then git's totals line, and `baseline` and `acceptanceCriteria` equal the whole bundle's

#### Scenario: Empty stat stays empty
- **WHEN** the stat is empty
- **THEN** the index `diffStat` is empty and `omitted` has no `diffStat` element

### Requirement: Review bundle: index entries
`review` SHALL answer in the index view: for every task in the milestone's closure an entry with `taskId`, `title` (the payload's title, else the task id), `status`, `publishedSha`, `summary` cut to `summaryChars` UTF-16 units (one fewer when the cut would split a surrogate pair), `summaryLength` (the whole summary's length), `acceptanceCount` (the evidence items of its report) and `changedFileCount` (the published job's changed files, absent when the job records none).

#### Scenario: Index entry fields
- **WHEN** the index is asked with `summaryChars` 400 for a task whose summary is 1000 units long, with one evidence item and three changed files
- **THEN** its entry is `taskId`, `title`, `status`, `publishedSha`, the first 400 units of `summary`, `summaryLength` 1000, `acceptanceCount` 1 and `changedFileCount` 3

#### Scenario: Cut never splits a surrogate pair
- **WHEN** the 400th unit of a summary is the high half of a surrogate pair and `summaryChars` is 400
- **THEN** the entry's `summary` is the first 399 units

### Requirement: Review bundle: index entry omissions
An index entry SHALL NOT carry `acceptance`. A task with no submit report has an empty `summary`, `summaryLength` 0 and `acceptanceCount` 0.

#### Scenario: No evidence and no report in the index
- **WHEN** the index lists a task with evidence and a task cancelled with release that has no submit report
- **THEN** no entry carries `acceptance`, and the cancelled task's entry has `summary` "", `summaryLength` 0 and `acceptanceCount` 0

### Requirement: Review bundle: omitted list
`omitted` SHALL list `{ field, count, fetch }` for each cut with a count above 0: `closure.acceptance` with the number of tasks that have evidence, `closure.summary` with the number of summaries cut, and `diffStat` with the number of file lines left out.

#### Scenario: Each cut named with its count
- **WHEN** an index cuts one summary, leaves out five stat file lines, and two tasks have evidence
- **THEN** `omitted` is `closure.acceptance` 2, `closure.summary` 1 and `diffStat` 5, in that order

#### Scenario: Nothing cut
- **WHEN** no summary is cut, the stat is whole and no task has evidence
- **THEN** `omitted` is empty

### Requirement: Review bundle: fetch text
The `fetch` text of the closure elements SHALL name the tool argument `task`, the HTTP form `GET /v1/milestones/<id>/review?task=<taskId>` and `full=true`; that of `diffStat` SHALL be the command `git diff --stat <baseline>..<integrationSha>` with both shas.

#### Scenario: Fetch text names the way back
- **WHEN** an index has `closure.acceptance`, `closure.summary` and `diffStat` elements in `omitted` for milestone MVP
- **THEN** the fetch text of both closure elements contains `task=`, `GET /v1/milestones/MVP/review?task=` and `full=true`, and that of `diffStat` is `git diff --stat <baseline>..<integrationSha>` with both shas

### Requirement: Review bundle: one-task view
`review` SHALL answer in this view: **One task** (`view: "task"`, parameter `task=<id>`): `omitted: []`, no `diffStat`, and `closure` with one entry: `taskId`, `title`, `status`, `publishedSha` when there is one, the task's own `acceptanceCriteria`, `changedFiles` when the published job has them, and from the task's latest submit report `summary`, `acceptance`, `interfaces`, `decisions`, `deviations`, `followUps`, `tests` and `noChanges`, but not `proposals`.

#### Scenario: One task's whole report
- **WHEN** `GET /v1/milestones/MVP/review?task=T1` is asked after T1's latest submit report carried every report field and a proposal
- **THEN** the answer has `view: "task"`, `omitted: []`, no `diffStat`, and one closure entry with T1's `acceptanceCriteria`, `publishedSha` and every report field, without `proposals`

### Requirement: Review bundle: one task without a report
A closure task with no submit report SHALL be answered 200 with none of the report's fields. The one-task view SHALL make no git call.

#### Scenario: Cancelled task answered without report fields
- **WHEN** the one-task view is asked for a closure task cancelled with release, which has no submit report
- **THEN** the answer is 200 with its `taskId`, `title`, `status` `cancelled` and `acceptanceCriteria`, and none of `summary`, `acceptance`, `interfaces`, `decisions`, `deviations`, `followUps`, `tests`, `noChanges` or `proposals`

#### Scenario: No git call for one task
- **WHEN** the one-task view is answered
- **THEN** the answer is built from the graph, the store's published job and its completion report, with no git command

### Requirement: Review bundle: whole view
`review` SHALL answer in this view: **Whole bundle** (`view: "full"`, parameter `full=true`): every key of the bundle the orchestrator builds, with `baseline`, the whole `diffStat` and every closure entry's `summary` and `acceptance`, plus `omitted: []`.

#### Scenario: Whole bundle answered
- **WHEN** `GET /v1/milestones/MVP/review?full=true` is asked
- **THEN** the answer equals the bundle the orchestrator builds plus `view: "full"` and `omitted: []`, with `view` and `omitted` serialised before `closure`

### Requirement: Review bundle: cut sizes
The cuts SHALL come from the config keys `review.statLines` (default 40) and `review.summaryChars` (default 400), integers of 0 or more read from the config file at daemon start; the request parameters `statLines` and `summaryChars` SHALL override them for one call, and 0 means none.

#### Scenario: Config defaults and a request override
- **WHEN** no `review` block is configured, and a request then passes `summaryChars=0`
- **THEN** the cuts are 40 stat lines and 400 summary units, and that request's index entries have empty summaries

#### Scenario: Negative cut size refused in the config
- **WHEN** the config sets `review.statLines` to -1 or `review.summaryChars` to 1.5
- **THEN** the config is refused

### Requirement: Review bundle: parameters
The parameters SHALL be read as follows, and a refusal answered 400 with `{ ok: false, reason, parameter }` naming the parameter: `full` is the whole bundle only for `true`, no for `false` or absent, and refused for any other value; an empty `task`, `statLines` or `summaryChars` is refused; `statLines` and `summaryChars` must be integers of 0 or more, and are checked in every view but have no effect in the one-task and whole views; `task` together with `full=true` is refused.

#### Scenario: Refused parameter named
- **WHEN** a review request carries `task=T1&full=true`, `statLines=-1`, `statLines=1.5`, `statLines=`, `summaryChars=abc`, `full=yes` or `task=`
- **THEN** it is answered 400 with `ok: false`, a reason, and `parameter` naming `full`, `statLines`, `summaryChars` or `task` as refused

#### Scenario: Cut parameters accepted in other views
- **WHEN** a request carries `task=T1&statLines=5` or `full=true&summaryChars=5`, or `full=false`
- **THEN** it is answered 200, and `full=false` gives the index

### Requirement: Review bundle: check order
`review` SHALL answer a request with the first refusal below that applies. A request is checked in this order: no graph loaded (409), a refused parameter (400), a node that is not a milestone or a milestone not in `submitted` (409, naming the current status, also when `task` is given), and a `task` that is not a task in the milestone's closure (404 with `{ ok: false, reason, closure }`, the reason naming the id and `closure` listing the closure's task ids).

#### Scenario: Milestone not submitted
- **WHEN** milestone MVP is not yet `submitted` and a review is asked with or without `task=T1`
- **THEN** both are answered 409

#### Scenario: Task outside the closure
- **WHEN** MVP is `submitted` and a review is asked with `task=NOPE` or `task=MVP`
- **THEN** it is answered 404 with `ok: false`, a reason naming the id, and `closure` listing `T1`

### Requirement: Tracker outbox: effect in ack and nack answers
The answers of `ack` and `nack`, including a repeated `ack` and the 409 for a `nack` of an applied effect, SHALL carry `effect` with only the effect's `id`, `taskId`, `kind`, `status` and `attempts`, plus `result` and `error` when the effect has them, and SHALL NOT carry its `payload`; `outbox` SHALL keep returning each effect with its `payload`.

#### Scenario: Answer carries the short effect
- **WHEN** an effect is acknowledged, acknowledged again, rejected with `nack`, and a `nack` follows on an applied effect
- **THEN** every answer's `effect` has only keys among `id`, `taskId`, `kind`, `status`, `attempts`, `result` and `error` and no `payload`, the late `nack` is 409, and `outbox` still lists the pending effect with its `payload`

### Requirement: Tracker outbox: CLI and MCP
Both the CLI and the MCP server SHALL expose `outbox` and `ack`, the latter taking a result or an error.

#### Scenario: CLI outbox and ack
- **WHEN** `orchestrator-ctl outbox` lists two effects and `ack <id> --result '{"stateId":"s1"}'` and `ack <id> --error 'no such state'` follow
- **THEN** the first effect is applied with that result, the second stays pending with `attempts` 1 and that error, and `outbox --after <id> --limit 1` lists only the second

#### Scenario: MCP outbox and ack
- **WHEN** the operator MCP server's `outbox` tool lists two effects and its `ack` tool is called for one with a result and for the other with an error
- **THEN** the first is applied with that result, the second stays pending with `attempts` 1 and that error, neither answer's `effect` carries `payload`, and an `ack` with neither a result nor an error is refused

### Requirement: Tracker outbox: status facts
`status` SHALL additionally report `tracker` (the recorded kind and workspace, or none), `outboxPending` (the count of pending effects), and `trackerErrors` (every `failed` effect with its id, issue, kind, attempts, and error); the event stream digest SHALL carry `outboxPending` and `trackerErrors`.

#### Scenario: Failed effect reported
- **WHEN** an effect reaches `tracker.maxAttempts` 3 with error "workflow has no started state"
- **THEN** `status` reports `outboxPending` 0 and `trackerErrors` with that effect's id, task, kind, `attempts` 3 and error, and the event digest carries the same

#### Scenario: Tracker recorded at import
- **WHEN** a graph is imported with tracker `{ kind: linear, workspace: acme }`
- **THEN** `status` reports that `tracker`

### Requirement: Status report: budgets and live launch facts
`status` SHALL additionally report `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known.

#### Scenario: Budgets reported
- **WHEN** the daemon runs with configured budgets and health limits
- **THEN** `status` reports `budgets` with the configured `maxLaunchMs` and `stuckAfterMs`

#### Scenario: Live launch elapsed time
- **WHEN** a live launch waited 20 minutes for an answer, was answered, and then ran for 5 seconds
- **THEN** its entry in `status` `liveLaunches` has `elapsedMs` 5000

### Requirement: Reopen with cascade: plan recorded and applied
With the `cascade` flag, the daemon SHALL compute the cascade plan, refuse with 409 naming the task when any job in the plan is `publishing`, and otherwise record the `operator.reopen` event with the plan, return `reset: [{ id, from }]`, and apply the plan in the next tick.

#### Scenario: Cascade returns the plan
- **WHEN** T1 is `done` and its dependent T2 is running, and `orchestrator-ctl reopen T1 --cascade` is run
- **THEN** the answer has `reset` with `{ id: T2, from: running }` and `{ id: T1, from: done }`, the last `operator.reopen` event carries `cascade: true`, and after the next tick T2's launch has ended with reason `cascade` and T2 is `unstarted`

#### Scenario: Cascade refused while publishing
- **WHEN** the job of T3, a task in the cascade plan of T1, is `publishing` and T1 is reopened with `cascade`
- **THEN** the reopen is refused with a reason naming T3 and `publishing: T3`, answered 409 by the route, and no `operator.reopen` event and no pending cascade are recorded

### Requirement: Proposal acceptance: appended node
Accepting a proposal SHALL append a task node to the run's graph file whose id is `nodeId` when given and the proposal id otherwise, whose `deps` are the proposal's deps plus the proposing task, and whose payload is the proposal's title, description, acceptance criteria, labels, and scope merged with `payload`, plus `proposal` and `proposedBy`.

#### Scenario: Accepted with a node id
- **WHEN** proposal T2-p1 from T2, with deps `[T3]` and label `follow-up`, is accepted with `nodeId: ENG-77` and `payload: { priority: 2 }`
- **THEN** the graph file gains node ENG-77 with deps T2 and T3 and a payload holding the proposal's title, description, acceptance criteria and labels, `priority: 2`, `proposal: T2-p1` and `proposedBy: T2`

#### Scenario: Accepted without a node id
- **WHEN** proposal T3-p1 is accepted with no `nodeId`
- **THEN** the node appended is T3-p1 with deps `[T3]`

### Requirement: Proposal acceptance: joined milestones
When `proposals.joinMilestone` is true (the default) the accepted proposal's node SHALL also be added to the `deps` of every gated milestone whose closure contains the proposing task.

#### Scenario: Node joins the proposer's milestone
- **WHEN** `proposals.joinMilestone` is true and T2, in the closure of gated milestone MVP, proposed T2-p1, which is accepted as ENG-77
- **THEN** MVP's deps become `[T2, ENG-77]` and the answer lists `joined: [MVP]`

#### Scenario: No milestone to join
- **WHEN** the proposing task is in no gated milestone's closure
- **THEN** the answer lists `joined: []`

### Requirement: Proposal acceptance: validated write
The graph file SHALL be validated and written atomically, reloaded, and the proposal marked `accepted` with the node id; on validation failure nothing SHALL be written and the proposal SHALL stay pending. Accepting a proposal whose node is already in the file SHALL mark it accepted without writing.

#### Scenario: Invalid graph not written
- **WHEN** the graph content with the appended node fails validation
- **THEN** the answer is 400, the graph file is not written, and the proposal stays pending

#### Scenario: Second accept writes nothing
- **WHEN** proposal T2-p1 was accepted as ENG-77 and is accepted again
- **THEN** the answer has `duplicate: true` and `written: false` and the graph file is not modified

### Requirement: Proposal rejection
Rejecting SHALL mark the proposal `rejected` with the note.

#### Scenario: Rejected with a note
- **WHEN** proposal T2-p2 is rejected with note "not worth it"
- **THEN** it is stored `rejected` with that note, leaves the pending list, and a later accept of it is answered 409

#### Scenario: Rejection needs a note
- **WHEN** a reject carries an empty note
- **THEN** it is answered 409

### Requirement: Claims and releases: CLI and MCP exposure
The CLI and the MCP server SHALL expose `claim`, `release` (with `--keep` on the CLI and `keep` on the tool), and the mode override through these routes; the usage route is for worker loops and SHALL be reachable over HTTP.

#### Scenario: Tools and commands
- **WHEN** the operator MCP server is listed and `orchestrator-ctl release <launchId> --reason r --keep` is run
- **THEN** the tools include `claim` and `release`, and the CLI posts `keep: true` to `POST /v1/launches/<launchId>/release`

#### Scenario: Worker usage over HTTP
- **WHEN** a worker posts `POST /v1/launches/<launchId>/usage` with its tokens and model after its submit
- **THEN** the usage is recorded on the launch with source `worker` and an `operator.usage` event

### Requirement: Claims and releases: reaping shutdown
A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them.

#### Scenario: Claimed launch survives a reap
- **WHEN** worker w1 has claimed T1's launch in `pull` mode and the daemon stops with reap
- **THEN** the launch is still `live` with worker w1 and T1 is still `running`

### Requirement: Idle exit: quiescence
The daemon SHALL be quiescent when the store holds no launch in `preparing`, `launching`, or `live`; no claimable launch whose claim window is finite and has not elapsed (zero in `spawn`, `runner.claimWindowMs` in `mixed`, unbounded in `pull`); no verifier job in `queued`, `checking`, `verified`, or `publishing`; no job in a terminal status not yet applied; and no pending cascade.

#### Scenario: Live launch and verifier job
- **WHEN** a launch is live, or a submitted task's verifier job is queued
- **THEN** the daemon is not quiescent

#### Scenario: Unapplied job and pending cascade
- **WHEN** a published job is not yet applied, or a cascade is pending
- **THEN** the daemon is not quiescent

#### Scenario: Parked launch by mode
- **WHEN** a launch is parked as claimable in `mixed` with `runner.claimWindowMs` 60000, and another in `pull`
- **THEN** the `mixed` daemon is not quiescent and the `pull` daemon is

### Requirement: Idle exit: activity
Activity SHALL be the end of any request the API server dispatches other than a probe, a tick at which the daemon was not quiescent, and, unless `exitWhileAttached` is true, a tick at which an attachment was alive. A probe is `GET /v1/status` with `probe=1`, `GET /healthz`, or `GET /readyz` (see specs/cluster-runtime "Probes").

#### Scenario: Probe is not activity
- **WHEN** the daemon is quiescent, a request that is not a probe ends, 300 ms pass and a probe ends
- **THEN** the idle time is 300 ms

#### Scenario: Busy tick is activity
- **WHEN** a tick launches tasks and 5 seconds pass
- **THEN** the idle time is zero

### Requirement: Idle exit: idle time
The daemon SHALL be idle only while quiescent, with no request in flight, and with no live attachment unless `exitWhileAttached` is true; its idle time SHALL be the time since the last activity and zero otherwise.

#### Scenario: Request in flight
- **WHEN** a request has begun and not ended
- **THEN** the idle time is zero

#### Scenario: Live attachment
- **WHEN** a live attachment is attached and `exitWhileAttached` is false
- **THEN** the idle time stays zero; with `exitWhileAttached` true it grows

### Requirement: Idle exit: exit when idle
After every tick, when `idleExitMs` is positive and the idle time reaches it, the daemon SHALL append the event `daemon.idleExit` with `idleMs` and SHALL stop gracefully, keeping agents for adoption, with the exit record reason `idle`.

#### Scenario: Idle daemon exits
- **WHEN** `daemon.idleExitMs` is 1500 and the run finishes
- **THEN** the daemon exits, the event log holds one `daemon.idleExit` event, and the exit record has reason `idle` and `reap: false`

#### Scenario: Disabled
- **WHEN** `daemon.idleExitMs` is 0 and the daemon has been idle for ten minutes
- **THEN** no idle exit is due

### Requirement: Idle exit: durable work is not activity
Pending tracker effects, an unfinished graph, blocked tasks, and a milestone awaiting review SHALL NOT count as activity.

#### Scenario: Milestone awaiting review
- **WHEN** every task is published and milestone MVP awaits review
- **THEN** the daemon is quiescent

### Requirement: Idle exit: status report
`status` SHALL report `idle: { quiescent, idleMs, exitAfterMs }`.

#### Scenario: Idle facts reported
- **WHEN** `idleExitMs` is 1000 and a quiescent daemon has been idle for 1000 ms
- **THEN** `status` reports `idle: { quiescent: true, idleMs: 1000, exitAfterMs: 1000 }`
