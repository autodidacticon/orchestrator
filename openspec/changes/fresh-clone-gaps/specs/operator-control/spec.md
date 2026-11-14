## ADDED Requirements

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
