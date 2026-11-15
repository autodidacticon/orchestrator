## MODIFIED Requirements

### Requirement: Store selection
The configuration SHALL carry `store: { kind: sqlite | postgres, url, urlFile, flushDeadlineMs }`, with `kind` defaulting to `sqlite` and `flushDeadlineMs` to 120000. When the file leaves `url` unset, `url` SHALL come from the sources of specs/state-backend "Store URL from a file" under `postgres`, and from `DATABASE_URL` under `sqlite`. The daemon SHALL open `<dataDir>/store.sqlite` under `sqlite`; under `postgres` it SHALL take the run lock, load the memory image for the run, and run the journal over the Postgres sink. The block SHALL be read from the file, the environment and the URL file only.

#### Scenario: Postgres restart on an empty data directory
- **WHEN** a daemon on `store.kind: postgres` is stopped and started again with a new, empty data directory
- **THEN** it serves the same tasks, launches, events and outbox as before, and no `store.sqlite` exists

#### Scenario: Override document cannot select a store
- **WHEN** the stored `config.overrides` document holds a `store` key beside other keys
- **THEN** the `store` key is ignored and the other keys still apply; a `PUT /v1/config` or `--set` naming `store` is refused

#### Scenario: Run already owned
- **WHEN** a second daemon starts on a run whose lock another session holds
- **THEN** it exits with an error saying the run is locked by another session

### Requirement: No store URL in child environments
Check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger, SHALL NOT receive `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, any libpq connection variable named in `LIBPQ_VARS` (`src/runs/childEnv.ts`: among them `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY` and `PGSSLROOTCERT`), or any variable whose value equals the resolved `store.url`. The libpq names SHALL be removed whatever their values, so a store URL built from parts (`postgres://host/db` plus `PGPASSWORD`) does not reach a child, and a project's check command loses its own `PG*` variables too. `LIBPQ_VARS` SHALL be the one list of these names. The daemon's own environment SHALL keep them. The environment of each daemon git command SHALL be built when the command runs, so a store URL resolved after startup is removed too, and SHALL still set `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`. The read-only startup lookups in `src/runs/runDir.ts` (`git config --get remote.origin.url`, `git ls-files --error-unmatch`, `git rev-parse --show-toplevel`) run no hooks and are not covered. This requirement covers environment variables only; what a child running as the daemon's user can still reach is stated in "Store credentials a child can still reach".

#### Scenario: Printed environments
- **WHEN** a daemon whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, every name in `LIBPQ_VARS` with `PGPASSWORD` set, and another variable with the store URL runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains any of those variables, the store password or the `PGPASSWORD` value, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** `store.url` comes from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

#### Scenario: Hook run by a daemon git command
- **WHEN** the daemon's environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, every name in `LIBPQ_VARS` and another variable with the store URL, and a project git hook that prints its environment runs under the daemon's kept-release work-in-progress commit or another daemon `git commit`
- **THEN** the printout contains none of those variables, not the store password and not the `PGPASSWORD` value, keeps unrelated variables, and shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

#### Scenario: Store URL withheld after import
- **WHEN** the store URL is withheld after the git module has loaded, as the daemon does once its configuration is resolved
- **THEN** the next daemon git command's environment no longer holds a variable with that URL

#### Scenario: Each libpq name is removed
- **WHEN** an environment holding one name from `LIBPQ_VARS` and an unrelated variable is passed through the child-environment filter, with no store URL withheld
- **THEN** the libpq name is removed and the unrelated variable is kept; `PGDATA` and other names outside the list are kept

## ADDED Requirements

### Requirement: Store URL from a file
Under `store.kind: postgres`, when the config file leaves `store.url` unset, the daemon SHALL take the URL from the file named by `store.urlFile`, else from the file named by `DATABASE_URL_FILE`, else from `DATABASE_URL`. The trimmed file content SHALL be the URL, read at most once per process. Under `sqlite` no URL file SHALL be read. The store report SHALL name the source `urlFile`. A URL from a file SHALL be withheld from child environments and scrubbed from the log.

#### Scenario: URL from DATABASE_URL_FILE
- **WHEN** a Postgres daemon starts with `DATABASE_URL_FILE` naming a file that holds the URL and no `DATABASE_URL`
- **THEN** it opens the store, and the environment another process of its user reads for it (`/proc/<pid>/environ`, or `ps eww` where there is no `/proc`) holds `DATABASE_URL_FILE` but neither `DATABASE_URL` nor the password

#### Scenario: store.urlFile in a tracked config
- **WHEN** a committed `orchestrator.yaml` sets `store.urlFile` and the environment has no `DATABASE_URL`
- **THEN** the daemon starts, its start output shows `urlSource: urlFile`, and the password is not printed

#### Scenario: Read once
- **WHEN** a URL file changes after the daemon's first resolution read it
- **THEN** a later resolution in the same process still uses the URL read first

### Requirement: Refused URL file
The daemon SHALL refuse to start, with a message naming the file and the setting that named it and never the URL, when a URL file cannot be read or is empty. It SHALL refuse `store.url` together with `store.urlFile`. Under `store.kind: postgres`, when the config file sets neither `store.url` nor `store.urlFile`, it SHALL refuse `DATABASE_URL` together with `DATABASE_URL_FILE`. A `store.urlFile` in a config file tracked by git SHALL NOT be refused: it holds a path, not the URL.

#### Scenario: Unreadable URL file
- **WHEN** `DATABASE_URL_FILE` names a file that does not exist
- **THEN** the daemon exits non-zero with `cannot read the database URL file <path> (DATABASE_URL_FILE)`

#### Scenario: Two sources at once
- **WHEN** a Postgres config sets neither `store.url` nor `store.urlFile` and `DATABASE_URL` and `DATABASE_URL_FILE` are both set, or the file sets both `store.url` and `store.urlFile`
- **THEN** the configuration is refused with a message naming both

### Requirement: Store credentials a child can still reach
The daemon removes only environment variables from its children. Any process of the daemon's user in its container (a check, a spawned agent, a worker there) can still read the URL file, the daemon's environment as started (`/proc/<daemon pid>/environ`), and its memory where the kernel allows. No requirement SHALL claim the daemon prevents these. `deploy/README.md` "Store credentials" SHALL state each of them and what a deployment does about it.

#### Scenario: Environment as started
- **WHEN** a daemon is started with `DATABASE_URL` in its environment and runs a check command
- **THEN** the check command's environment has no `DATABASE_URL`, and `/proc/<daemon pid>/environ` still holds it

#### Scenario: URL file stays readable
- **WHEN** the daemon reads its URL from a file readable by its user and runs a check command as that user
- **THEN** the check command can read the file; the deployment notes say so and name the measures a deployment takes

### Requirement: Reference daemon environment holds no store URL
The reference manifests SHALL give the daemon the store URL through a mounted Secret file named by `store.urlFile`, with no `DATABASE_URL`, `DATABASE_URL_FILE`, `PG*` variable, `envFrom` or Secret-read variable in the daemon container.

#### Scenario: Reference manifests keep the URL out of the daemon's environment
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the daemon container has no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG`, no `envFrom` and no variable read from a Secret, and `orchestrator.yaml` names `store.urlFile` on the mounted Secret file
