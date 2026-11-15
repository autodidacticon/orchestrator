## MODIFIED Requirements

### Requirement: Postgres test database
The test run SHALL decide once, in a vitest global setup in the main process, where the Postgres suites get their database: from `TEST_DATABASE_URL` when it is set, after one connection to it succeeds; otherwise from one throwaway cluster started with `initdb` and `pg_ctl` when both are on `PATH`, listening on a Unix socket in a temporary directory and shared by every test file of the run; otherwise there is no Postgres. On the shared cluster each test file SHALL use its own database, dropped when the file ends. The cluster SHALL be stopped and its directory removed when the run ends, also when a test fork is killed, and also when the main process dies without its teardown. `ORCH_TEST_PG` SHALL accept `auto` (the default), `off` (no Postgres, whatever is available) and `required` (the run fails when there is no Postgres); any other value fails the run. A run without Postgres SHALL print exactly one line saying the Postgres suites are skipped and why. Each test SHALL use its own run id. A test SHALL signal a Postgres server process only when the server is the cluster this run started. `npm test` SHALL pass, without retries, both with and without Postgres available.

#### Scenario: No Postgres
- **WHEN** `npm test` runs with no `TEST_DATABASE_URL` and neither `initdb` nor `pg_ctl` on `PATH`
- **THEN** the Postgres suites are reported skipped, one line says so and why, and the run passes

#### Scenario: Postgres required
- **WHEN** `npm test` runs with `ORCH_TEST_PG=required` and no Postgres is available
- **THEN** the run fails, naming why there is no Postgres

#### Scenario: Unreachable URL
- **WHEN** `TEST_DATABASE_URL` is set and does not accept a connection
- **THEN** the run fails instead of skipping the Postgres suites

#### Scenario: One cluster per run
- **WHEN** several test files of one run use Postgres from the throwaway cluster
- **THEN** they share one cluster, each in its own database, and no postmaster or cluster directory remains after the run, even when a test fork or the main process was killed with SIGKILL

#### Scenario: Remote server not signalled
- **WHEN** the Postgres suites run against `TEST_DATABASE_URL`
- **THEN** the tests that stall a server by stopping its backend process are skipped

## ADDED Requirements

### Requirement: Randomized journal test covers every table
The seeded randomized journal test SHALL write, through accepted batches, every table the journal mirrors, so that each table's rows are compared between the sink and the image, and SHALL fail when a table was never written.

#### Scenario: Every table written
- **WHEN** the randomized run over SQLite or Postgres ends
- **THEN** the set of tables its accepted batches wrote equals the journal's table list, `verifier_jobs`, `proposals` and `payload_overlays` included
