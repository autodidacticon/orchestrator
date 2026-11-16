## Why

The review of CLOUD-M2 v2 (2026-11-14) found two ways the store's credentials still reach a check command or an agent, by reading the code (ORC-100):

- `withoutStore` (`src/runs/childEnv.ts`) removed `DATABASE_URL`, `ORCH_RUN_ID` and any variable whose value is the store URL. The libpq variables (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, ...) passed through. A store URL built from parts (`postgres://host/db` plus `PGPASSWORD`) is not matched by value.
- A check command or agent runs as the daemon's user in the daemon's container. It can read `/proc/<daemon pid>/environ`, which holds `DATABASE_URL` as the process was started, whatever the daemon removes from its children later.

The spec ("No store URL in child environments") and `deploy/README.md` stated only the first point.

## What Changes

- `LIBPQ_VARS` in `src/runs/childEnv.ts` is the one list of libpq connection variables. `withoutStore`, `childEnv` and `isolationEnv` remove each of these names, and `DATABASE_URL_FILE`, whatever their values. Every child goes through `withoutStore`: agents of every runner kind (`SubprocessRunner`), the check command (`childEnv` in the verifier) and the daemon's git commands (`gitEnv`).
- The daemon can read the store URL from a file: `store.urlFile` in the config, else `DATABASE_URL_FILE`, else `DATABASE_URL`, under `store.kind: postgres` only. The file is read at most once per process. An unreadable or empty file, `store.url` together with `store.urlFile`, and `DATABASE_URL` together with `DATABASE_URL_FILE` are refused with a message that never carries the URL. The store report names the source `urlFile`.
- The reference manifests mount the CloudNativePG Secret's `uri` key as a read-only file (mode 0440, group = the pod's `fsGroup`), and set `store.urlFile` to it in `orchestrator.yaml`. The daemon container's environment holds no `DATABASE_URL`, no `PG*` variable and nothing read from a Secret, so `/proc/<daemon pid>/environ` holds no store URL or password.
- The spec and `deploy/README.md` "Store credentials" state what a child running as the daemon's user can still reach: the URL file, the daemon's environment when a deployment passes the URL there, and the daemon's memory where the kernel allows it. They also state what a deployment does about each. No requirement claims the daemon closes these.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: MODIFIED "Store selection" and "No store URL in child environments"; ADDED "Store URL from a file", "Refused URL file", "Store credentials a child can still reach" and "Reference daemon environment holds no store URL".
- `agent-protocol`: MODIFIED "Agent environment".
- `integration-pipeline`: MODIFIED "Check environment".
- `cluster-runtime`: MODIFIED "Reference manifests".

## Impact

- `src/runs/childEnv.ts`, `src/config.ts` (`store.urlFile`, `withStoreEnv`, `readStoreUrlFile`, `StoreUrlError`, `storeUrlSource`), `src/state/open.ts` (message), and `src/runs/resolve.ts` (the `urlSource` type gains `urlFile`; one line, outside the task's listed scope).
- `deploy/base/deployment.yaml`, `deploy/base/orchestrator.yaml`, `deploy/base/postgres.yaml` (comment), `deploy/README.md`.
- Tests: `test/runs/child-env.test.ts` (each libpq name, spelled out in the test), `test/slice/git-env.test.ts`, `test/slice/store-postgres.test.ts` (a real daemon from `DATABASE_URL_FILE` and from `store.urlFile` in a tracked config; its environment read with `/proc/<pid>/environ` or `ps eww`), `test/state/store-selection.test.ts` and `test/host/deploy.test.ts`. The last two are outside the task's listed scope: the first holds the unit tests for `withStoreEnv`, and the second asserted the old `DATABASE_URL` Secret reference.
- A project whose check command needs its own `PG*` variables loses them. The check command can set them itself.
- Not done: running the check command as another user, or anything else that keeps a same-user child from the URL file or the daemon's memory.
