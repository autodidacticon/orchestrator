## Why

The Postgres store creates its tables wherever the session's `search_path` points, normally `public`, beside an application's own tables, and the place can change between starts (a `search_path` in the URL's `options`, in `PGOPTIONS`, or set on the role or the database). The store should keep its tables in one schema that the configuration names. Separately, a SQLite run reads `DATABASE_URL` into `store.url`, so a project's own database URL shows up in the store report as if it were a store input.

## What Changes

- New config key `store.schema` (postgres only, read from the config file at start, never a runtime override). Unset, the tables are in the schema `orchestrator` (`DEFAULT_STORE_SCHEMA`).
- One name rule (`storeSchemaError` in `src/state/pg/schema.ts`): 1 to 63 characters of `a-z`, `0-9` and `_`, starting with a letter or `_`, not starting with `pg_`, not `information_schema`. `storeConfigError` refuses a bad name under `postgres` before the store opens; `PgSink.open` refuses it before connecting. A value that is not a string fails the config parse.
- `migrate(client, schema)`, inside the migration transaction and under its lock: looks the name up in `pg_catalog.pg_namespace`, sends `CREATE SCHEMA` only when no row is found (never `IF NOT EXISTS`), requires USAGE and CREATE on an existing schema, and sets a transaction-local `search_path` holding the schema alone. A `CREATE SCHEMA` refused with SQLSTATE `42501` names both remedies; any other failure carries the server's message without grant advice.
- Every statement the sink builds names the schema: the INSERT and DELETE of a batch, the `launches` order sub-select, the loader's SELECT, and the three statements on `orchestrator_migrations`. `PgSink.open` also sets the session's `search_path` to the schema alone, outside any transaction, and checks `current_schema()`. The text of migration 1 does not change.
- `batchStatements`, `applyPgOps`, `readRun`, `loadRunInto` and `migrate` take the schema as a required argument; `PgSinkOptions.schema` is optional (default `orchestrator`); `PgSink.schema` is public. New `StoreSchemaError` (code `schemaRefused`).
- `openStore` passes the schema in force; its run-locked, open and load errors name the schema, and the run-locked error says the run lock is per database. New `StoreOpenError` code `schemaRefused`.
- The store report carries `schema` under `postgres`; the log lines `store opened` and `could not open the store` carry `schema` under `postgres`.
- Under `sqlite`, `withStoreEnv` returns the config unchanged: `DATABASE_URL` no longer fills `store.url`. A `store.url` written in the file is kept.
- `deploy/smoke.sh` and the quoted query in `deploy/README.md` read `orchestrator.launches` and `orchestrator.overlay`.

A database made before this change keeps its tables in `public` and is no longer read: a daemon starts an empty run in `orchestrator`. No release has created a Postgres database, so nothing is migrated.

## Capabilities

### Modified Capabilities

- `state-backend`: "Postgres schema", "Store selection" and "Database URL redaction" are modified; "Store schema placement", "Store schema creation", "Store schema key" and "Run lock is per database" are added.

## Impact

`src/state/pg/schema.ts`, `src/state/pg/sink.ts`, `src/state/pg/index.ts`, `src/state/open.ts`, `src/config.ts`, `src/runs/resolve.ts`, `src/main.ts`, `deploy/smoke.sh`, `deploy/README.md` (two places), and the tests in `test/state`, `test/slice/store-postgres.test.ts`, `test/runs/deployment-identity.test.ts` and `test/host/smoke.test.ts`. Under SQLite the password of `DATABASE_URL` is no longer registered for log scrubbing by the store block, since the store no longer reads it.
