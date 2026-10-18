## ADDED Requirements

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout.

#### Scenario: Check sees an isolated home
- **WHEN** the check command is `echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"`
- **THEN** the check passes and the recorded path is inside the run's data directory
