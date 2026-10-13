## ADDED Requirements

### Requirement: Idle exit
The configuration SHALL accept `daemon.idleExitMs`, an integer in milliseconds defaulting to 600000 where 0 disables the exit, and `daemon.exitWhileAttached`, a boolean defaulting to false. The daemon SHALL be quiescent when the store holds no launch in `preparing`, `launching`, or `live`; no claimable launch whose claim window is finite and has not elapsed (zero in `spawn`, `runner.claimWindowMs` in `mixed`, unbounded in `pull`); no verifier job in `queued`, `checking`, `verified`, or `publishing`; no job in a terminal status not yet applied; and no pending cascade. Activity SHALL be the end of any request the loopback server dispatches other than a probe, a tick at which the daemon was not quiescent, and, unless `exitWhileAttached` is true, a tick at which an attachment was alive. A probe is `GET /v1/status` with `probe=1`. The daemon SHALL be idle only while quiescent, with no request in flight, and with no live attachment unless `exitWhileAttached` is true; its idle time SHALL be the time since the last activity and zero otherwise. After every tick, when `idleExitMs` is positive and the idle time reaches it, the daemon SHALL append the event `daemon.idleExit` with `idleMs` and SHALL stop gracefully, keeping agents for adoption, with the exit record reason `idle`. Pending tracker effects, an unfinished graph, blocked tasks, and a milestone awaiting review SHALL NOT count as activity. `status` SHALL report `idle: { quiescent, idleMs, exitAfterMs }`.

#### Scenario: Finished run exits after the window
- **WHEN** a run finishes, no session is attached, and no request other than probes arrives for `idleExitMs`
- **THEN** the daemon records `daemon.idleExit`, exits with code 0, and `daemon.json` carries `exit.reason` `idle`

#### Scenario: Open long-poll keeps it alive
- **WHEN** the run is quiescent and a client holds `GET /v1/events?wait=30000` open past the window
- **THEN** the daemon does not exit while the request is open, and the idle clock starts when the request ends

#### Scenario: Probes do not count
- **WHEN** `GET /v1/status?probe=1` is called every minute on a quiescent daemon with a five-minute window
- **THEN** the daemon exits after five minutes as if no request had arrived

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
On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest }` into `daemon.json` after the orchestrator has stopped and before the process ends, where `reason` is `stop`, `signal`, or `idle` and `digest` is the event-stream digest at that moment. A daemon that starts SHALL write `daemon.json` without `exit`. A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash. `runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists.

#### Scenario: Stop records the reason
- **WHEN** the daemon is stopped through the `shutdown` route with `reap` false
- **THEN** `daemon.json` carries `exit` with reason `stop`, `reap` false, and the digest

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

## MODIFIED Requirements

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
