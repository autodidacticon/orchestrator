## 1. Refusal

- [x] 1.1 `NewerSchemaError` in `src/state/pg/sink.ts`, exported from `src/state/pg/index.ts`
- [x] 1.2 The check in `migrate()`, after the read of recorded versions and before any pending migration
- [x] 1.3 `openStore` maps it to `StoreOpenError` code `schemaNewer` with the redacted URL

## 2. Tests

- [x] 2.1 `migrate refuses a recorded version it does not know` (recording client, runs without Postgres)
- [x] 2.2 `a database migrated by a newer daemon is refused before the run lock` (throwaway cluster only)

## 3. Spec

- [x] 3.1 MODIFIED requirement "Postgres migrations" in `state-backend`
