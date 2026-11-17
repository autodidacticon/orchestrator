## MODIFIED Requirements

### Requirement: Postgres migrations
The Postgres sink SHALL apply its SQL migrations at startup, each once, recorded in a migrations table and serialized across sessions sharing the database.

The sink SHALL refuse to open when the migrations table records a version that is not among its own migrations, whatever that version is: a newer release has migrated the database. The refusal SHALL name the highest recorded version the sink does not know and the highest version it knows, and SHALL say that this daemon must be upgraded; it SHALL NOT carry the database password. The check SHALL run in the migration transaction, after the migration lock is taken and the recorded versions are read and before any pending migration runs, so the refusal comes before the run lock is taken and before the run is loaded. On a refusal the transaction SHALL be rolled back: no migration is applied and no version is recorded. The store open SHALL report the refusal with the code `schemaNewer`. A recorded version the sink knows SHALL NOT be compared by name, and a gap in the recorded versions SHALL NOT be an error.

The check runs at startup only: a daemon that is already running when a newer daemon migrates the database SHALL NOT be stopped by it, and gets the refusal at its next start.

#### Scenario: Migrations at startup
- **WHEN** a sink opens on a database where the migrations have already been applied
- **THEN** no migration runs again and the migrations table lists each version once

#### Scenario: Database migrated by a newer daemon
- **WHEN** a sink opens on a database whose migrations table records a version above the highest version the sink knows, for a run whose lock another session holds or for any other run
- **THEN** the open is refused with an error naming the recorded version and the highest known version and saying to upgrade the daemon, not with a run-lock refusal; the run lock is not taken, nothing is loaded, no migration is applied, the recorded versions are unchanged, and the store open fails with the code `schemaNewer`
