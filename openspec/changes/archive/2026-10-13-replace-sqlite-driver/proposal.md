## Why

The store (`SqliteStore` in `src/state/sqlite.ts`) uses `better-sqlite3`, the only native module in the production dependency tree: of the 131 production packages in the lockfile it alone carries an install script and a `binding.gyp`, and it brings 34 transitive packages that nothing else uses. Claude Code's automatic dependency install for a marketplace plugin installs registry packages only, with `--ignore-scripts`, under a sixty-second cap, so a native module can never be delivered that way; that is why `add-daemon-lifecycle` has to reach the package through `npx`. Node 22.13.0 unflagged `node:sqlite`, a synchronous binding to Node's bundled SQLite with everything the store uses (`prepare`, `exec`, `close`; `run` returning `{ changes, lastInsertRowid }`, `get`, `all`). Replacing the driver lets the plugin carry the published package as an ordinary dependency and run it from `${CLAUDE_PLUGIN_ROOT}/node_modules`, with `npx` only as a fallback, and removes compilation from every install: checkouts, the verifier's temp roots, CI, and the plugin cache. The owner agreed on 2026-10-13 to do this first, as its own small change, before `add-daemon-lifecycle`.

## What Changes

- `SqliteStore` opens its file with `node:sqlite`'s `DatabaseSync` instead of `better-sqlite3`, behind the unchanged `Store` interface: WAL journal and `synchronous = NORMAL` as today, plus an explicit five-second busy timeout, which better-sqlite3 applied by default and `node:sqlite` does not.
- `transaction(fn)` is implemented in the store: `BEGIN`, `COMMIT`, and `ROLLBACK` at the top level, and `SAVEPOINT`, `RELEASE`, and `ROLLBACK TO` when called inside a transaction, which better-sqlite3 did implicitly and which `transition()`, `fail()`, `queueNotice()`, `recordSignal()`, and their callers rely on.
- Constraint violations keep SQLite's message (`UNIQUE constraint failed: ...`) and the rollback; the error's `code` becomes `ERR_SQLITE_ERROR` with the SQLite result code in `errcode`. Nothing inspected the old code.
- `close()` becomes idempotent and `getSnapshot()` returns a plain object, so the two places where the drivers differ in surface stay as they were.
- The `node:sqlite` ExperimentalWarning never reaches stderr, the daemon log, or an MCP log, from any executable however it is started; every other warning still prints, and the process's `warning` listeners are back as they were within one turn of the event loop, so an embedder of the core library sees no lasting side effect.
- `better-sqlite3` and `@types/better-sqlite3` leave `package.json`; `engines.node` becomes `>=22.13.0`; the production tree goes from 131 packages to 96, with no install script and no `binding.gyp`, and a host test guards that.
- Store tests pin savepoint nesting, constraint rollback, and a writer waiting for another process; a lifecycle test asserts a clean daemon log.
- No change to the schema, the `Store` interface, routes, tools, events, `daemonCommand()`, `shimCommand()`, the plugin under `hosts/`, or the test configuration.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `host-integration`: adds "No native dependencies" (pure-JavaScript production tree, `node:sqlite`, the Node floor, the host test) and "Quiet SQLite binding" (no ExperimentalWarning from any executable or in the daemon log, other warnings still printed, the process's listeners restored within one turn).
- `crash-recovery`: adds "Store transactions", the transaction, nesting, constraint, WAL, and busy-timeout contract that durable record bracketing has relied on without stating it, so that the swap is checked against a specification rather than only against the suite.

No existing requirement names `better-sqlite3`, SQLite, WAL, or any driver behaviour, so nothing is MODIFIED; the only mention of the driver outside code is the archived v1 design record, which stays as history.

## Impact

- Code: `src/state/sqlite.ts` (driver, transaction wrapper, busy timeout, snapshot copy, idempotent close), new `src/state/sqlite-warning.ts`, a comment in `src/state/store.ts`. Tests: `test/state/sqlite.test.ts`, new helper `test/state/hold-write.ts`, `test/host/package.test.ts`, `test/runs/lifecycle.test.ts`. Docs: `README.md` (prerequisite and spec index), `openspec/config.yaml` (tech stack line).
- Dependencies: `better-sqlite3` and `@types/better-sqlite3` removed; `package-lock.json` regenerated, dropping 35 packages; `@types/node` 22.20.5 already ships the `node:sqlite` typings. `engines.node` `>=22.13.0`; the README prerequisite becomes Node 22.13 or newer.
- Warning handling: filtered in process by the store module, one-shot, with the listeners restored once the warning is handled or after the first turn of the event loop, so `daemonCommand()`, `shimCommand()`, the shebangs, `vitest.config.ts`, and the plugin launcher that `add-daemon-lifecycle` introduces carry no flag.
- Migration: an existing `store.sqlite` opens unchanged; no schema change; `journal_mode = WAL` is already persisted in the file; rolling back is reverting the module and reinstalling `better-sqlite3`.
- Relation to other changes: `add-daemon-lifecycle` is applied after this one; its plugin-local packaging path assumes the pure-JavaScript tree, and its open question about replacing the driver is answered here. `add-toolchain-discovery` is unaffected.
