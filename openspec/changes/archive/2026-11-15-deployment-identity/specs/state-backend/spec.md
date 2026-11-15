## ADDED Requirements

### Requirement: Run id per deployment
With `store.kind: postgres` the daemon SHALL choose the run id, in this order: `store.runId` from the config file; else `ORCH_RUN_ID`; else a hash of `git.originUrl` when set; else, with `git.pushIntegration` on, a hash of the clone's `origin` remote; else the repository path hash, logging one warning. Origin hashes SHALL leave out the URL's user information. `store.runId` SHALL never come from the stored overrides. An explicit id that is not 1 to 64 characters of `[A-Za-z0-9_-]` SHALL fail startup with a message naming it. With `store.kind: sqlite` the run id SHALL be as before.

#### Scenario: Two origins on one repository path
- **WHEN** two daemons start with the same repository path, different `git.originUrl` values and one Postgres database
- **THEN** they get different run ids, both run, and neither loads the other's rows, also after a restart on an empty data directory

#### Scenario: Explicit id precedence
- **WHEN** `store.runId` and `ORCH_RUN_ID` are both set
- **THEN** the run id is `store.runId`; with only `ORCH_RUN_ID` set it is `ORCH_RUN_ID`

#### Scenario: Invalid explicit id
- **WHEN** `ORCH_RUN_ID` or `store.runId` is `bad id!`, `x/../y`, empty in the file, or longer than 64 characters
- **THEN** the daemon exits non-zero before opening the store, with a message containing `invalid run id "<value>" from <source>`

#### Scenario: Path hash fallback
- **WHEN** a Postgres daemon has neither an explicit id nor `git.originUrl`, and `git.pushIntegration` is off or the clone has no origin
- **THEN** it starts on the repository path hash and logs exactly one warning that names `store.runId`, `ORCH_RUN_ID` and `git.originUrl`

#### Scenario: SQLite unchanged
- **WHEN** `store.kind` is `sqlite` and `store.runId`, `ORCH_RUN_ID` or `git.originUrl` is set, valid or not
- **THEN** the run id and the run directory are the repository path hash, as before

### Requirement: No store URL in child environments
Check commands, and agents of every runner kind together with the processes they start, SHALL NOT receive `DATABASE_URL`, `ORCH_RUN_ID`, or any variable whose value equals the resolved `store.url`. The daemon's own environment SHALL keep them. The daemon's own git commands are not covered yet (see design.md "Risks").

#### Scenario: Printed environments
- **WHEN** a Postgres daemon whose environment holds `DATABASE_URL` and another variable with the same URL runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains `DATABASE_URL`, `ORCH_RUN_ID`, the other variable, or the password, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** `store.url` comes from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

### Requirement: No store URL in a tracked config file
When `store.url` comes from a config file that git tracks in the repository, the daemon SHALL refuse to start with a message saying so, without printing the URL: a tracked file is checked out into every worktree.

#### Scenario: Tracked file with the URL
- **WHEN** `<repo>/orchestrator.yaml` sets `store.url` and is committed
- **THEN** the daemon exits non-zero with a message that the file sets `store.url` and is tracked by git, and the password is not printed
