## Why

Since the store keeps its tables in the schema named by `store.schema`, a changed or misspelt value, or a database made before 0.6.0 (its tables in the session's default schema, normally `public`), gives an empty run with no message while the old rows stay in another schema. The daemon should say where the other tables are when it starts an empty run.

## What Changes

- `loadRunInto` resolves with the number of rows it copied; `PgSink.loadInto` keeps it in `PgSink.loadedRows`. `loadImage` and `loadInto` keep their return types.
- New `schemasHoldingStoreTables(client, schema)` in `src/state/pg/sink.ts` (exported from `src/state/pg/index.ts`): one query on `pg_catalog.pg_class` joined with `pg_catalog.pg_namespace` for the schemas, other than `schema`, holding an ordinary table named `orchestrator_migrations`, sorted. It reads catalogues only and never throws: a failed query resolves with no schemas. `PgSink.schemasElsewhere()` runs it on the sink's session through `serial`.
- `openStore`, under `postgres`, after the load and before the journal is built, and only when the load copied no row, awaits `sink.schemasElsewhere()` inside a `try`. A non-empty answer is returned as `OpenedStore.otherSchemas`.
- `otherSchemasWarning(schema, otherSchemas, runId)` in `src/state/open.ts` builds the message: it names every other schema, the configured schema, the run id and `store.schema`.
- `src/main.ts`, right after `store opened`: when `otherSchemas` is set, one `warn` line with `schema`, `otherSchemas` and `runId`, and one `config.warning` event with `code: 'tablesInOtherSchema'`, `message` and `schemas`.

The warning shows only at a run's first start: every start writes the run id and a `config.resolved` event, so the next load finds rows. Under `sqlite` nothing changes.

## Capabilities

### Modified Capabilities

- `state-backend`: the requirement "Empty run beside tables in another schema" is added.

## Impact

`src/state/pg/sink.ts`, `src/state/pg/index.ts`, `src/state/open.ts`, `src/main.ts`, and tests in `test/state/pg.test.ts` and `test/slice/store-postgres.test.ts`.
