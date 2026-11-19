## MODIFIED Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. Humans and host sessions SHALL act only through this interface.

#### Scenario: CLI reaches the daemon
- **WHEN** `status` is run while the daemon is up
- **THEN** it prints the current report from the daemon

#### Scenario: MCP and CLI share one implementation
- **WHEN** the same operation is invoked through the CLI and through the MCP server
- **THEN** both produce the same event and the same effect

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

## ADDED Requirements

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
