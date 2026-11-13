## MODIFIED Requirements

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR`, `DATABASE_URL`, `ORCH_RUN_ID` and every variable whose value is the resolved store URL removed. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout, nor reach the orchestrator's state database through its environment.

#### Scenario: Check sees an isolated home
- **WHEN** the check command is `echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"`
- **THEN** the check passes and the recorded path is inside the run's data directory

#### Scenario: Check sees no store URL
- **WHEN** the check command is `env > check.env` on a daemon whose environment holds `DATABASE_URL` and another variable set to the store URL
- **THEN** `check.env` has neither variable nor the password, so check output stored in job rows cannot carry it
