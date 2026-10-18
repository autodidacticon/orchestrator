## MODIFIED Requirements

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
