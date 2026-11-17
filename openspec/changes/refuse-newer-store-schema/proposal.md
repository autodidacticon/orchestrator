## Why

A daemon ignores migration versions it does not know, so it uses a Postgres database that a newer release has migrated as if nothing had changed. Its writes can then fail against tables it does not understand (a missing table is retried until the flush deadline and ends the daemon) or succeed against a shape the newer release does not expect.

## What Changes

- `migrate()` refuses with `NewerSchemaError` (code `schemaNewer`, `recorded`, `known`) when `orchestrator_migrations` records a version that is not in `MIGRATIONS`. The check runs in the migration transaction, after the migration lock and the read of recorded versions, before any pending migration; the transaction is rolled back.
- `PgSink.open` therefore refuses before the run lock and before the image is loaded.
- `openStore` reports it as `StoreOpenError` with the new code `schemaNewer`, naming both versions and the redacted URL.
- No change to the `orchestrator_migrations` table.

## Capabilities

### Modified Capabilities

- `state-backend`: requirement "Postgres migrations" gains the refusal of an unknown recorded version and the scenario "Database migrated by a newer daemon".

## Impact

`src/state/pg/sink.ts`, `src/state/pg/index.ts`, `src/state/open.ts`, `test/state/pg.test.ts`. A running daemon is not stopped by the check; it gets the refusal at its next start.
