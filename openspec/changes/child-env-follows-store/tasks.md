## 1. Child environments

- [x] 1.1 `src/runs/childEnv.ts`: the withholding switch (`setStoreWithholding`, `storeWithholding`, reset by `clearWithheldStoreUrls`); `storeWithholdingFor` and `postgresInputsWithoutKind`; `isolationEnv` and `withoutStore` follow the switch, `ORCH_RUN_ID` always removed
- [x] 1.2 `src/main.ts`: one call of the setter after `openStore`, before the first resolution; the SQLite exception (URL registered, one warning, one `config.warning` event); the startup line
- [x] 1.3 `src/runs/resolve.ts`: `StoreReport.withholdsDatabaseVariables`
- [x] 1.4 Comments: the header of `src/runs/childEnv.ts` and the comment above `gitEnv`

## 2. Tests

- [x] 2.1 `test/runs/child-env.test.ts`: the pure functions, the switch off and the reset, the codex and opencode claim bodies, the report field
- [x] 2.2 `test/slice/git-env.test.ts`: a hook run by a daemon `git commit` with withholding off
- [x] 2.3 `test/runs/child-env-sqlite.test.ts`: real SQLite daemons, with the variables passing and with them withheld (`ORCH_RUN_ID`, a `store.flushDeadlineMs` block)

## 3. Spec

- [x] 3.1 state-backend, integration-pipeline and agent-protocol deltas; `openspec validate child-env-follows-store --strict`
