## 1. Store

- [x] 1.1 `loadRunInto` returns the rows copied; `PgSink.loadedRows`
- [x] 1.2 `schemasHoldingStoreTables(client, schema)` and `PgSink.schemasElsewhere()` on the sink's session
- [x] 1.3 `openStore` runs the check for an empty Postgres run and returns `otherSchemas`

## 2. Daemon

- [x] 2.1 `otherSchemasWarning` builds the message
- [x] 2.2 `src/main.ts` logs one warning and appends one `config.warning` event `tablesInOtherSchema` after `store opened`

## 3. Tests

- [x] 3.1 Postgres tests in `test/state/pg.test.ts`: other schemas reported for an empty run and not after rows exist; the `orchestrator_migrations` marker
- [x] 3.2 Tests without a server: a failed catalogue query, SQLite, the message
- [x] 3.3 Daemon test in `test/slice/store-postgres.test.ts`: one warning and one event at the first start, none at the restart
