## MODIFIED Requirements

### Requirement: Container mode
The daemon SHALL run as a long-lived foreground process. On SIGTERM or SIGINT it SHALL stop the tick loop, finish the in-flight tick and verifier job, close the API server and its open connections, write the exit record with reason `signal`, and exit 0. Under `verifier.mode: remote` the stop SHALL NOT wait for a job that waits for a verifier's result, and that job's row SHALL stay for the next start. `daemon.idleExitMs: 0` keeps the daemon running however long it is idle (see "Idle exit").

#### Scenario: SIGTERM mid-check
- **WHEN** the daemon under `verifier.mode: local` receives SIGTERM while a verifier job is `checking`
- **THEN** the job is published, the server closes, `daemon.json` carries `exit` with reason `signal`, and the process exits 0 within ten seconds

#### Scenario: SIGTERM while a remote job waits
- **WHEN** the daemon under `verifier.mode: remote` receives SIGTERM while an offered job claimed by a verifier waits for its result
- **THEN** the process exits 0 within eight seconds without `shutdown grace elapsed`, and its store holds the job `checking` with its `offer`, `verifier` and `token`

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
