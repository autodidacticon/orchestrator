## Why

Release 0.5.1 removed three names from the environments of check commands and agents: `ORCH_URL`, `ORCH_REPO` and `ORCH_DATA_DIR`. `main` also removes `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, every libpq connection variable in `LIBPQ_VARS` and every variable whose value equals a registered store URL, on every store kind. A 0.5.1 user on SQLite whose check command or agents need `DATABASE_URL` or `PG*` for the project's own database therefore loses them on upgrade. The check fails, and after `maxAttempts` the task is blocked with `attempts exhausted after ...`. Nothing names the removed variable (ORC-115).

The variables are withheld so that a child cannot reach the orchestrator's state database. That database exists only when the daemon opened a Postgres store.

## What Changes

- Withholding is a process-wide switch in `src/runs/childEnv.ts`. It is on when the module loads. `setStoreWithholding(on)` sets it and `storeWithholding()` reads it. `clearWithheldStoreUrls()` turns it back on.
- `isolationEnv` and `withoutStore` follow the switch. `ORCH_RUN_ID` is removed on every store kind, like `CLIENT_VARS`. While the switch is on, `DATABASE_URL`, `DATABASE_URL_FILE`, the `LIBPQ_VARS` names and the variables holding a withheld URL are removed too, as before. While it is off, they pass. `LIBPQ_VARS`, `STORE_VARS` and `WITHHELD_VARS` keep their contents. The four paths that use these functions all follow the switch: check commands, spawned agents, the `env` block of a codex or opencode claim, and the daemon's git commands with the hooks they run.
- Two pure functions make the decision. `storeWithholdingFor(openedKind, inputs)` is `true` for `postgres` whatever the inputs, `true` for `sqlite` with inputs, and `false` for `sqlite` with none. `postgresInputsWithoutKind(fileRaw, env)` lists the Postgres inputs set while the config file does not write `store.kind`: the file's `store.<key>` keys, then a non-empty `ORCH_RUN_ID`.
- `src/main.ts` calls `setStoreWithholding(storeWithholdingFor(opened.kind, inputs))` once, after `openStore` returns and before the first resolution. The decision follows the kind of the store that was opened, not the configured kind. On a SQLite store with inputs, the daemon also registers the trimmed `DATABASE_URL` for withholding by value. It then logs one warning and appends one `config.warning` event (`postgresInputsUnderSqlite`) naming the inputs and both remedies. When the daemon's environment holds any of these variables, one startup info line names them (`withholds`, `storeKind`, `names`) and never gives a value.
- The config report's store block gains `withholdsDatabaseVariables`. It reaches the start output, `GET /v1/config`, `config.json` and the `config.resolved` event.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: MODIFIED "No store URL in child environments" and "Store credentials a child can still reach"; ADDED "Withholding follows the store" (the rule and its scenarios), "Postgres inputs under SQLite" (what counts as an input, the warning and the event) and "Withholding stated" (the startup line and the report field). The detail is split across three requirements because `openspec validate --strict` refuses an ADDED requirement whose text is over 500 characters.
- `integration-pipeline`: MODIFIED "Check environment".
- `agent-protocol`: MODIFIED "Agent environment".

## Impact

- Code: `src/runs/childEnv.ts`, `src/main.ts`, `src/runs/resolve.ts` (the report field). Only the comment above `gitEnv` changes in `src/workspace/git.ts`. No spawn site changes.
- Tests:
  - `test/runs/child-env.test.ts`: the pure functions, the switch, the reset, the claim bodies and the report field.
  - `test/slice/git-env.test.ts`: a hook with withholding off.
  - `test/runs/child-env-sqlite.test.ts` (new): real SQLite daemons.
- What a Postgres daemon withholds does not change.
- Not done here:
  - A configuration key or pass-list for the names. It is planned for a later release.
  - The README and `deploy/README.md` text, which other tasks write.
  - Removing the copy of `DATABASE_URL` into `store.url` under SQLite (`src/config.ts`). This change behaves the same with or without that copy.
- Known limit: a daemon meant for Postgres that writes no `store.kind`, no other store key and no `ORCH_RUN_ID` runs on SQLite and passes its `DATABASE_URL` to its children. No rule tells it apart from a laptop upgrade. The startup line and the report field are the trace.
- The rule is decided at each daemon start. A restart by a client with a different environment can change it between two attempts of the same task.
