## 1. Name and key

- [x] 1.1 `DEFAULT_STORE_SCHEMA`, `STORE_SCHEMA_RULE` and `storeSchemaError` in `src/state/pg/schema.ts`, exported from `src/state/pg/index.ts`
- [x] 1.2 `store.schema` (optional string) in the config schema, `storeSchemaOf`, and the name check in `storeConfigError` under `postgres`
- [x] 1.3 `withStoreEnv` returns the config unchanged for a kind other than `postgres`

## 2. Sink

- [x] 2.1 The schema in the six statement sites; the helpers take it as a required argument; `PgSinkOptions.schema` optional; `PgSink.schema`
- [x] 2.2 `migrate()`: lookup, create when absent, rights check, transaction-local path, `current_schema()` check, under the migration lock
- [x] 2.3 `PgSink.open`: name check before connecting, session path after `migrate()`, then the run lock

## 3. Surfaces

- [x] 3.1 `openStore` passes the schema and names it in its errors
- [x] 3.2 `StoreReport.schema` under `postgres`; `schema` in `store opened` and `could not open the store`
- [x] 3.3 `deploy/smoke.sh` queries and the two places in `deploy/README.md`

## 4. Tests

- [x] 4.1 Placement, creation, path and lock tests in `test/state/pg.test.ts` (recording client without Postgres; cluster-only role test)
- [x] 4.2 Key, report and SQLite `DATABASE_URL` tests in `test/state/store-selection.test.ts`
- [x] 4.3 Daemon tests in `test/slice/store-postgres.test.ts`; query test in `test/host/smoke.test.ts`
