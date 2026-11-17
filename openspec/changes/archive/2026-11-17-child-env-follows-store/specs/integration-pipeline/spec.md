## MODIFIED Requirements

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind. While the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL SHALL be removed too. While it does not withhold (a SQLite store with no Postgres input), they SHALL reach the check unchanged, so a project's check keeps its own database variables. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout. While the daemon withholds, it SHALL NOT be able to reach the orchestrator's state database through its environment. The check runs as the daemon's user, so it can still read what specs/state-backend "Store credentials a child can still reach" lists; this requirement does not cover that.

#### Scenario: Check sees an isolated home
- **WHEN** the check command is `echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"`
- **THEN** the check passes and the recorded path is inside the run's data directory

#### Scenario: Check sees no store URL
- **WHEN** the check command is `env > check.env` on a daemon that withholds, whose environment holds `DATABASE_URL` and another variable set to the store URL, `DATABASE_URL_FILE`, and every name in `LIBPQ_VARS` with `PGPASSWORD` set
- **THEN** `check.env` has none of those variables, not the password and not the `PGPASSWORD` value, so check output stored in job rows cannot carry them

#### Scenario: Check on a SQLite run keeps the project's database variables
- **WHEN** the check command is `env > check.env` on a daemon with a SQLite store and no Postgres input, whose environment holds `DATABASE_URL`, `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD`
- **THEN** `check.env` holds each of them with its value, has no `ORCH_URL` or `ORCH_RUN_ID` line, and its `ORCH_HOME` is inside the run directory
