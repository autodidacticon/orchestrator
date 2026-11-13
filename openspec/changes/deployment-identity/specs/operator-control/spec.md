## MODIFIED Requirements

### Requirement: Run directory
Run data SHALL live outside the repository in `$ORCH_HOME/runs/<id>/`, where `ORCH_HOME` defaults to `~/.orchestrator` and `<id>` is the run id. For a SQLite run the id is the first sixteen hex digits of the SHA-256 of the repository's real path. For a Postgres run it is chosen as specs/state-backend "Run id per deployment" says. The run directory SHALL contain a `repo` file with that path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, `daemon.pid`, and `daemon.json` with the daemon's pid, URL, port, start time, repository, and, after a graceful exit, the exit record. The CLI and MCP server SHALL resolve the run directory from an explicit repository argument or from the git top level of the working directory, with the same id the daemon chooses. A `runs` operation SHALL list every run with its repository path, whether its daemon is alive, a status digest when it is, and otherwise the exit record or its absence.

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
