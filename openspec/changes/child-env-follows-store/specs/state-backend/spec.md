## MODIFIED Requirements

### Requirement: No store URL in child environments
Check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger, SHALL NOT receive `ORCH_RUN_ID`, on every store kind. While the daemon withholds (see "Withholding follows the store": always on a Postgres store), they SHALL NOT receive `DATABASE_URL`, `DATABASE_URL_FILE`, any libpq connection variable named in `LIBPQ_VARS` (`src/runs/childEnv.ts`: among them `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY` and `PGSSLROOTCERT`), or any variable whose value equals a withheld store URL (the resolved `store.url`). While it withholds, the libpq names SHALL be removed whatever their values, so a store URL built from parts (`postgres://host/db` plus `PGPASSWORD`) does not reach a child, and a project's check command loses its own `PG*` variables too. While it does not withhold, these variables SHALL reach the children unchanged. `LIBPQ_VARS` SHALL be the one list of these names. The daemon's own environment SHALL keep them. The environment of each daemon git command SHALL be built when the command runs, so a store URL resolved after startup is removed too, and SHALL still set `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`. The read-only startup lookups in `src/runs/runDir.ts` (`git config --get remote.origin.url`, `git ls-files --error-unmatch`, `git rev-parse --show-toplevel`) run no hooks and are not covered. This requirement covers environment variables only; what a child running as the daemon's user can still reach is stated in "Store credentials a child can still reach".

#### Scenario: Printed environments
- **WHEN** a daemon that withholds, whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, every name in `LIBPQ_VARS` with `PGPASSWORD` set, and another variable with the store URL, runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains any of those variables, the store password or the `PGPASSWORD` value, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** a daemon that withholds takes `store.url` from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

#### Scenario: Hook run by a daemon git command
- **WHEN** a daemon that withholds, whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, every name in `LIBPQ_VARS` and another variable with the store URL, runs its kept-release work-in-progress commit or another `git commit`, and a project git hook that prints its environment runs under it
- **THEN** the printout contains none of those variables, not the store password and not the `PGPASSWORD` value, keeps unrelated variables, and shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

#### Scenario: Store URL withheld after import
- **WHEN** a daemon that withholds registers the store URL after the git module has loaded, as it does once its configuration is resolved
- **THEN** the next daemon git command's environment no longer holds a variable with that URL

#### Scenario: Each libpq name is removed
- **WHEN** an environment holding one name from `LIBPQ_VARS` and an unrelated variable is passed through the child-environment filter in its default state (withholding), with no store URL withheld
- **THEN** the libpq name is removed and the unrelated variable is kept; `PGDATA` and other names outside the list are kept

#### Scenario: SQLite run passes the database variables
- **WHEN** a daemon on a SQLite store with no Postgres input, whose environment holds `DATABASE_URL`, another variable with the same value, `DATABASE_URL_FILE`, `PGHOST`, `PGPASSWORD` and `ORCH_RUN_ID` (with `store.kind: sqlite` written in the file), runs a check command, a spawned agent and a git commit whose hook print their environment
- **THEN** each printout holds `DATABASE_URL`, the other variable, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` with their values, and no `ORCH_RUN_ID`; the git printout still shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

### Requirement: Store credentials a child can still reach
The daemon removes only environment variables from its children, and only while it withholds (see "Withholding follows the store"). Any process of the daemon's user in its container (a check, a spawned agent, a worker there) can still read the URL file, the daemon's environment as started (`/proc/<daemon pid>/environ`), and its memory where the kernel allows. No requirement SHALL claim the daemon prevents these. `deploy/README.md` "Store credentials" SHALL state each of them and what a deployment does about it.

#### Scenario: Environment as started
- **WHEN** a daemon that withholds is started with `DATABASE_URL` in its environment and runs a check command
- **THEN** the check command's environment has no `DATABASE_URL`, and `/proc/<daemon pid>/environ` still holds it

#### Scenario: URL file stays readable
- **WHEN** the daemon reads its URL from a file readable by its user and runs a check command as that user
- **THEN** the check command can read the file; the deployment notes say so and name the measures a deployment takes

## ADDED Requirements

### Requirement: Withholding follows the store
The daemon SHALL withhold the store's variables from its children (see "No store URL in child environments") exactly when the store it opened is Postgres, or is SQLite while a Postgres input is set and the file does not write `store.kind` (see "Postgres inputs under SQLite", with its warning and event). A process that opens no store SHALL withhold. The daemon SHALL state at startup and in its config report whether it withholds (see "Withholding stated").

#### Scenario: A Postgres store withholds
- **WHEN** a daemon opens a Postgres store, whatever the config file and the environment hold
- **THEN** it withholds: its check commands, agents and git hooks see none of the store's variables, as in "No store URL in child environments"

#### Scenario: A SQLite store passes
- **WHEN** a daemon started with `orchestrator --repo`, with no `store` block in its config file and an empty `ORCH_RUN_ID`, opens a SQLite store with `DATABASE_URL` (holding a password), `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, and runs a check command and a spawned agent that print their environment
- **THEN** both printouts hold all five variables and an unrelated one, no `ORCH_URL`, and an `ORCH_HOME` inside the run directory; no `config.warning` event is appended; the report has `withholdsDatabaseVariables: false`

#### Scenario: Postgres inputs without store.kind
- **WHEN** the same SQLite daemon is started with `ORCH_RUN_ID=team-a`, or with a `store` block that sets only `flushDeadlineMs`
- **THEN** its check command and agent see none of `DATABASE_URL`, `APP_DATABASE`, `DATABASE_URL_FILE`, `PGHOST`, `PGPASSWORD` or `ORCH_RUN_ID`, and not the password; its log has one warning and its events one `config.warning` with code `postgresInputsUnderSqlite`, both naming `ORCH_RUN_ID` (or `store.flushDeadlineMs`); the report has `withholdsDatabaseVariables: true`

#### Scenario: store.kind written as sqlite
- **WHEN** the config file writes `store.kind: sqlite` and `ORCH_RUN_ID=team-a` is set
- **THEN** the daemon does not withhold, its children see the database variables and no `ORCH_RUN_ID`, and nothing warns

#### Scenario: No store opened
- **WHEN** a process that opened no store (an operator command, a library caller, the in-process test harness) builds a child environment, a claim's `env` block or a config report
- **THEN** it withholds: the store's variables are removed (blanked in a claim's `env` block), and the report has `withholdsDatabaseVariables: true`

#### Scenario: Variables named at startup
- **WHEN** a daemon starts with `DATABASE_URL`, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment
- **THEN** its log has one info line with `withholds`, `storeKind` and `names` holding those four names, and the line holds neither the password nor the `PGHOST` value

#### Scenario: The config report states the rule
- **WHEN** an operator reads `GET /v1/config` of a running daemon, or its `config.json`
- **THEN** the store block has `withholdsDatabaseVariables`: `true` on a Postgres store or under the exception, `false` on a SQLite store otherwise

### Requirement: Postgres inputs under SQLite
A Postgres input is a key other than `kind` in the file's `store` block, or a non-blank `ORCH_RUN_ID`. A file that writes `store.kind` has none. `DATABASE_URL`, `DATABASE_URL_FILE`, libpq names and `git.originUrl` are not inputs. A SQLite daemon with inputs SHALL also withhold the trimmed `DATABASE_URL` by value, and at each start log one warning and append one `config.warning` event `{ code: 'postgresInputsUnderSqlite', message, inputs }` naming each input and both remedies.

#### Scenario: Project variables are no inputs
- **WHEN** a SQLite daemon with no `store` block and an empty `ORCH_RUN_ID` has `DATABASE_URL`, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, or `git.originUrl` in its config file
- **THEN** it finds no Postgres input, appends no `config.warning` event and does not withhold

#### Scenario: Warning names the remedies
- **WHEN** a SQLite daemon starts with a Postgres input and no `store.kind` in its config file
- **THEN** the warning and the event's `message` name each input, `store.kind: postgres` and `store.kind: sqlite`

### Requirement: Withholding stated
The daemon SHALL decide once per start, after the store opens and before its first resolution, with no configuration key or pass-list. When its environment holds a non-empty `DATABASE_URL`, `DATABASE_URL_FILE` or `LIBPQ_VARS` name, it SHALL log one info line with `withholds`, `storeKind` and `names`, never a value. The report's store block SHALL carry `withholdsDatabaseVariables` on every store kind, in the start output, `GET /v1/config`, `config.json` and `config.resolved`.

#### Scenario: No line without database variables
- **WHEN** a daemon starts with none of `DATABASE_URL`, `DATABASE_URL_FILE` or the `LIBPQ_VARS` names set in its environment
- **THEN** it logs no line naming database variables, and its report still carries `withholdsDatabaseVariables`
