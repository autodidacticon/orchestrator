## MODIFIED Requirements

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR`, `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL removed. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout, nor reach the orchestrator's state database through its environment. The check runs as the daemon's user, so it can still read what specs/state-backend "Store credentials a child can still reach" lists; this requirement does not cover that.

#### Scenario: Check sees an isolated home
- **WHEN** the check command is `echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"`
- **THEN** the check passes and the recorded path is inside the run's data directory

#### Scenario: Check sees no store URL
- **WHEN** the check command is `env > check.env` on a daemon whose environment holds `DATABASE_URL` and another variable set to the store URL, `DATABASE_URL_FILE`, and every name in `LIBPQ_VARS` with `PGPASSWORD` set
- **THEN** `check.env` has none of those variables, not the password and not the `PGPASSWORD` value, so check output stored in job rows cannot carry them
