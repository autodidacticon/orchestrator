## MODIFIED Requirements

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
